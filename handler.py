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
import re
import random
import tempfile

import numpy as np
import runpod
import soundfile as sf
import torch
import torchaudio
from transformers import AutoProcessor, DiaForConditionalGeneration

# ---------------------------------------------------------------------------
# Model loading — happens once at cold-start, before any jobs are processed
# ---------------------------------------------------------------------------
MODEL_ID = os.environ.get("MODEL_ID", "pevers/parkiet")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

print(f"Loading model '{MODEL_ID}' on device '{DEVICE}' ...")
processor = AutoProcessor.from_pretrained(MODEL_ID)
model = DiaForConditionalGeneration.from_pretrained(MODEL_ID).to(DEVICE)
SAMPLE_RATE = processor.feature_extractor.sampling_rate
print(f"Model loaded successfully. Sample rate: {SAMPLE_RATE}")


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


def load_audio_from_b64(b64_audio: str) -> np.ndarray:
    """
    Decode a base64 audio string (wav/mp3/flac) to a numpy array at the
    model's expected sample rate (44100 Hz).
    """
    audio_bytes = base64.b64decode(b64_audio)

    # Write to temp file so torchaudio can detect format (supports mp3, wav, flac, etc.)
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        waveform, sr = torchaudio.load(tmp_path)

        # Convert stereo to mono if needed
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        # Resample to model's expected rate if needed
        if sr != SAMPLE_RATE:
            resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=SAMPLE_RATE)
            waveform = resampler(waveform)

        return waveform.squeeze(0).numpy()
    finally:
        os.remove(tmp_path)


def tensor_to_base64(audio_tensor, sample_rate: int, fmt: str = "wav") -> str:
    """Convert a torch.Tensor audio waveform to a base64 string."""
    audio_np = audio_tensor.cpu().float().numpy()
    buf = io.BytesIO()
    sf.write(buf, audio_np, sample_rate, format=fmt.upper())
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


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
        output_format   (str, "wav")     — Output audio format (wav / mp3 / flac).

    Voice cloning (add to single or batch):
        audio_prompt              (str)  — Base64-encoded audio file (wav/mp3/flac) to clone voice from.
        audio_prompt_transcript   (str)  — Transcript of the audio prompt. This is prepended
                                           to text/texts automatically so the model knows
                                           where the prompt voice ends and generation starts.

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
    audio_prompt_transcript = job_input.get("audio_prompt_transcript", "")
    output_format = job_input.get("output_format", "wav").lower()

    # -- Seed --
    if seed is not None:
        set_seed(int(seed))

    # -- Prepare inputs (with or without audio prompt for voice cloning) --
    audio_prompt_len = None

    if audio_prompt_b64:
        # -- Validate voice cloning inputs --
        if not audio_prompt_transcript:
            print("⚠️  WARNING: audio_prompt provided without audio_prompt_transcript. "
                  "Voice cloning works best when the transcript matches the audio prompt.")

        # Validate audio prompt size (base64 string)
        prompt_size_kb = len(audio_prompt_b64) * 3 / 4 / 1024  # approx decoded size
        print(f"🎤 Voice cloning mode:")
        print(f"   Audio prompt size: ~{prompt_size_kb:.1f} KB (base64)")
        print(f"   Transcript: {'provided (' + str(len(audio_prompt_transcript)) + ' chars)' if audio_prompt_transcript else 'MISSING'}")
        print(f"   Batch size: {len(input_texts)} text(s)")

        # Decode and validate audio
        try:
            audio_array = load_audio_from_b64(audio_prompt_b64)
        except Exception as e:
            return {"error": f"Failed to decode audio_prompt: {e}"}

        # Validate the decoded audio
        duration_s = len(audio_array) / SAMPLE_RATE
        print(f"   Decoded audio: {len(audio_array)} samples, {duration_s:.2f}s @ {SAMPLE_RATE} Hz")
        print(f"   Audio range: [{audio_array.min():.4f}, {audio_array.max():.4f}], dtype={audio_array.dtype}")

        if len(audio_array) == 0:
            return {"error": "Audio prompt decoded to zero samples. Check the audio file."}

        if duration_s < 3:
            print(f"   ⚠️  WARNING: Audio prompt is very short ({duration_s:.2f}s). "
                  "Voice cloning may not work well with prompts under 3 seconds.")

        if duration_s > 15:
            print(f"   ⚠️  WARNING: Audio prompt is very long ({duration_s:.2f}s). "
                  "This may cause memory issues. Consider using a 5-15 second clip.")

        # Check for silence / corrupt audio (all zeros or near-zero)
        if np.abs(audio_array).max() < 1e-6:
            return {"error": "Audio prompt appears to be silent (all zeros). Check the audio file."}

        # Voice cloning mode: prepend transcript to each text, strip duplicate speaker tags
        if audio_prompt_transcript:
            input_texts = [
                re.sub(r'(\[S\d+\])\s*\1', r'\1', audio_prompt_transcript + " " + t)
                for t in input_texts
            ]

        # Processor expects one audio sample per text — duplicate for batch
        audio_batch = [audio_array] * len(input_texts) if len(input_texts) > 1 else audio_array

        inputs = processor(
            text=input_texts,
            audio=audio_batch,
            padding=True,
            return_tensors="pt",
        ).to(DEVICE)
        audio_prompt_len = processor.get_audio_prompt_len(inputs["decoder_attention_mask"])
        print(f"   Audio prompt len (tokens): {audio_prompt_len}")
    else:
        # Standard TTS mode: text only
        inputs = processor(text=input_texts, padding=True, return_tensors="pt").to(DEVICE)

    # -- Generation --
    generate_kwargs = {
        "max_new_tokens": max_new_tokens,
        "guidance_scale": guidance_scale,
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
    }

    with torch.no_grad():
        outputs = model.generate(**inputs, **generate_kwargs)

    # -- Decode audio (returns list[torch.Tensor], one per input text) --
    # Pass audio_prompt_len so batch_decode strips the prompt audio from output
    audio_list = processor.batch_decode(outputs, audio_prompt_len=audio_prompt_len)

    # -- Encode outputs to base64 --
    audio_b64_list = [
        tensor_to_base64(audio, SAMPLE_RATE, fmt=output_format)
        for audio in audio_list
    ]

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
