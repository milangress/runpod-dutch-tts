"""
RunPod Serverless Handler for Parkiet — Dutch Text-to-Speech (TTS)

Loads the pevers/parkiet model (1.6B param Dia-based architecture) at startup
and serves TTS requests via the RunPod serverless framework.

Supports both single-text and batch requests:
  - Single: { "text": "..." }         → { "audio": "<b64>", "format": "wav" }
  - Batch:  { "texts": ["...", ...] }  → { "audio": ["<b64>", ...], "format": "wav" }
"""

import base64
import io
import os
import random

import numpy as np
import runpod
import soundfile as sf
import torch
from transformers import AutoProcessor, DiaForConditionalGeneration

# ---------------------------------------------------------------------------
# Model loading — happens once at cold-start, before any jobs are processed
# ---------------------------------------------------------------------------
MODEL_ID = os.environ.get("MODEL_ID", "pevers/parkiet")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Use only the pre-cached model from the Docker image (no network calls)
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

print(f"Loading model '{MODEL_ID}' on device '{DEVICE}' ...")
processor = AutoProcessor.from_pretrained(MODEL_ID)
model = DiaForConditionalGeneration.from_pretrained(MODEL_ID).to(DEVICE)
print("Model loaded successfully.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def set_seed(seed: int):
    """Set all random seeds for reproducible generation."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False


def decode_audio_prompt(b64_audio: str) -> str:
    """Decode a base64 WAV string and write it to a temp file, return the path."""
    audio_bytes = base64.b64decode(b64_audio)
    tmp_path = "/tmp/audio_prompt.wav"
    with open(tmp_path, "wb") as f:
        f.write(audio_bytes)
    return tmp_path


def audio_to_base64(audio_array: np.ndarray, sample_rate: int, fmt: str = "wav") -> str:
    """Encode a numpy audio array to a base64 string."""
    buf = io.BytesIO()
    sf.write(buf, audio_array, sample_rate, format=fmt.upper())
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


def tensor_to_base64(audio_tensor, sample_rate: int, fmt: str = "wav") -> str:
    """Convert a torch.Tensor audio waveform to a base64 string."""
    audio_np = audio_tensor.cpu().float().numpy()
    return audio_to_base64(audio_np, sample_rate, fmt=fmt)


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def handler(job):
    """
    RunPod handler for Dutch TTS.

    Input schema (single):
        text            (str, required)  — Text to synthesise. Use [S1], [S2], etc. for speakers.
        max_new_tokens  (int, 3072)      — Maximum audio tokens to generate.
        guidance_scale  (float, 3.0)     — Classifier-free guidance scale.
        temperature     (float, 1.8)     — Sampling temperature.
        top_p           (float, 0.90)    — Nucleus sampling probability.
        top_k           (int, 50)        — Top-k sampling.
        seed            (int|null)       — Random seed for reproducibility.
        audio_prompt    (str|null)       — Base64-encoded WAV for voice cloning.
        output_format   (str, "wav")     — Output audio format (wav / mp3 / flac).

    Input schema (batch):
        texts           (list[str], required) — List of texts to synthesise in one batch.
        (all other params same as above, applied to every text in the batch)

    Returns (single):
        { "audio": "<base64 encoded audio>", "format": "wav" }

    Returns (batch):
        { "audio": ["<base64>", ...], "format": "wav", "count": N }
    """
    job_input = job["input"]

    # -- Determine single vs batch mode --
    texts = job_input.get("texts")  # batch mode
    text = job_input.get("text")    # single mode

    if texts and isinstance(texts, list):
        is_batch = True
        input_texts = texts
    elif text:
        is_batch = False
        input_texts = [text]
    else:
        return {"error": "Missing required field 'text' (string) or 'texts' (list of strings)."}

    # -- Optional generation params --
    max_new_tokens = int(job_input.get("max_new_tokens", 3072))
    guidance_scale = float(job_input.get("guidance_scale", 3.0))
    temperature = float(job_input.get("temperature", 1.8))
    top_p = float(job_input.get("top_p", 0.90))
    top_k = int(job_input.get("top_k", 50))
    seed = job_input.get("seed")
    audio_prompt_b64 = job_input.get("audio_prompt")
    output_format = job_input.get("output_format", "wav").lower()

    # -- Seed --
    if seed is not None:
        set_seed(int(seed))

    # -- Prepare text input (processor accepts list[str]) --
    inputs = processor(text=input_texts, padding=True, return_tensors="pt").to(DEVICE)

    # -- Voice cloning (audio prompt) --
    audio_prompt_path = None
    if audio_prompt_b64:
        audio_prompt_path = decode_audio_prompt(audio_prompt_b64)

    # -- Generation --
    generate_kwargs = {
        "max_new_tokens": max_new_tokens,
        "guidance_scale": guidance_scale,
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
    }

    if audio_prompt_path is not None:
        generate_kwargs["audio_prompt"] = audio_prompt_path

    with torch.no_grad():
        outputs = model.generate(**inputs, **generate_kwargs)

    # -- Decode audio (returns list[torch.Tensor], one per input text) --
    audio_list = processor.batch_decode(outputs)

    # Get sample rate from processor config
    sample_rate = processor.feature_extractor.sampling_rate

    # -- Encode outputs to base64 --
    audio_b64_list = [
        tensor_to_base64(audio, sample_rate, fmt=output_format)
        for audio in audio_list
    ]

    # -- Cleanup --
    if audio_prompt_path and os.path.exists(audio_prompt_path):
        os.remove(audio_prompt_path)

    # -- Return single or batch response --
    if is_batch:
        return {
            "audio": audio_b64_list,
            "format": output_format,
            "count": len(audio_b64_list),
        }
    else:
        return {
            "audio": audio_b64_list[0],
            "format": output_format,
        }


runpod.serverless.start({"handler": handler})
