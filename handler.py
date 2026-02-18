"""
RunPod Serverless Handler for Parkiet — Dutch Text-to-Speech (TTS)

Loads the pevers/parkiet model (1.6B param Dia-based architecture) at startup
and serves TTS requests via the RunPod serverless framework.
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


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def handler(job):
    """
    RunPod handler for Dutch TTS.

    Input schema:
        text            (str, required)  — Text to synthesise. Use [S1], [S2], etc. for speakers.
        max_new_tokens  (int, 3072)      — Maximum audio tokens to generate.
        guidance_scale  (float, 3.0)     — Classifier-free guidance scale.
        temperature     (float, 1.8)     — Sampling temperature.
        top_p           (float, 0.90)    — Nucleus sampling probability.
        top_k           (int, 50)        — Top-k sampling.
        seed            (int|null)       — Random seed for reproducibility.
        audio_prompt    (str|null)       — Base64-encoded WAV for voice cloning.
        output_format   (str, "wav")     — Output audio format (wav / mp3 / flac).

    Returns:
        { "audio": "<base64 encoded audio>", "format": "wav" }
    """
    job_input = job["input"]

    # -- Required --
    text = job_input.get("text")
    if not text:
        return {"error": "Missing required field 'text'."}

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

    # -- Prepare text input --
    # The processor expects a list of strings
    if isinstance(text, str):
        text = [text]

    inputs = processor(text=text, padding=True, return_tensors="pt").to(DEVICE)

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

    # -- Decode audio --
    decoded = processor.batch_decode(outputs)

    # Save to a temp file via the processor (handles codec decoding), then read back
    tmp_output = f"/tmp/tts_output.{output_format}"
    processor.save_audio(decoded, tmp_output)

    # Read the saved file and encode to base64
    audio_data, sample_rate = sf.read(tmp_output)
    audio_b64 = audio_to_base64(audio_data, sample_rate, fmt=output_format)

    # Cleanup
    if audio_prompt_path and os.path.exists(audio_prompt_path):
        os.remove(audio_prompt_path)
    if os.path.exists(tmp_output):
        os.remove(tmp_output)

    return {
        "audio": audio_b64,
        "format": output_format,
    }


runpod.serverless.start({"handler": handler})
