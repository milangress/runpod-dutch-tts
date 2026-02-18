"""
RunPod Serverless Handler for Parkiet — Dutch Text-to-Speech (TTS)

Loads the pevers/parkiet model (1.6B param Dia-based architecture) at startup
and serves TTS requests via the RunPod serverless framework.

Supports batched text requests:
  - Input:  { "texts": ["...", ...] }
  - Output: { "audio": ["<b64>", ...], "format": "wav", "count": N }

Voice cloning via preset voices or custom audio prompts:
  - Preset: { "text": "...", "voice": "F1" }
  - Custom: { "text": "...", "audio_prompt": "<b64>", "audio_prompt_transcript": "..." }
"""

from __future__ import annotations

import base64
import io
import json
import os
import logging
import sys

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(name)s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    stream=sys.stdout
)
logger = logging.getLogger("runpod_tts")

# Prevent Hugging Face from checking for updates or connecting to the Hub
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
# Silence HTTP request logs from underlying libraries
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

import random
import re
import tempfile
from dataclasses import dataclass, field

import numpy as np
import runpod
import soundfile as sf
import torch
import torchaudio
from transformers import AutoProcessor, DiaForConditionalGeneration


# ---------------------------------------------------------------------------
# Error Handling
# ---------------------------------------------------------------------------

class AppError(Exception):
    """Custom exception for structured API errors."""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


# ---------------------------------------------------------------------------
# Initialisation — runs once at cold-start
# ---------------------------------------------------------------------------

MODEL_ID = os.environ.get("MODEL_ID", "pevers/parkiet")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
VOICES_DIR = os.environ.get("VOICES_DIR", "/voices")

logger.info(f"Loading model '{MODEL_ID}' on device '{DEVICE}' ...")
try:
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = DiaForConditionalGeneration.from_pretrained(MODEL_ID).to(DEVICE)
    SAMPLE_RATE: int = processor.feature_extractor.sampling_rate
    logger.info(f"Model loaded successfully. Sample rate: {SAMPLE_RATE}")
except Exception as e:
    logger.critical(f"Failed to load model: {e}")
    raise e


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def _load_waveform(waveform: torch.Tensor, sr: int) -> np.ndarray:
    """
    Normalise a raw waveform tensor to mono at the model's sample rate.
    Shared by both preset-voice loading and base64 decoding.
    """
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sr != SAMPLE_RATE:
        waveform = torchaudio.transforms.Resample(orig_freq=sr, new_freq=SAMPLE_RATE)(waveform)
    return waveform.squeeze(0).numpy()


def load_audio_from_b64(b64_audio: str) -> np.ndarray:
    """Decode a base64 audio string to a numpy array at the model's sample rate."""
    try:
        audio_bytes = base64.b64decode(b64_audio)
    except Exception as e:
        raise AppError("AUDIO_DECODING_FAILED", f"Invalid base64 string: {e}")

    # Create temp file and write bytes, ensuring it is closed before loading
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
            tmp_path = f.name
            f.write(audio_bytes)
            f.flush()

        waveform, sr = torchaudio.load(tmp_path)
        return _load_waveform(waveform, sr)
    except Exception as e:
        raise AppError("AUDIO_DECODING_FAILED", f"Failed to decode audio file: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


def tensor_to_base64(audio_tensor: torch.Tensor, sample_rate: int, fmt: str = "wav") -> str:
    """Convert a torch.Tensor audio waveform to a base64-encoded string."""
    audio_np = audio_tensor.cpu().float().numpy()
    buf = io.BytesIO()
    sf.write(buf, audio_np, sample_rate, format=fmt.upper())
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

_SPEAKER_TAG = re.compile(r'\[S\d+\]')


def ensure_speaker_tag(text: str) -> str:
    """Prepend [S1] if the text doesn't already start with a speaker tag."""
    if _SPEAKER_TAG.match(text.strip()):
        return text
    return f"[S1] {text}"


def strip_consecutive_speaker_tags(text: str) -> str:
    """
    Remove redundant consecutive speaker tags from text.

    When the same tag appears twice with no other speaker tag in between,
    the second occurrence is removed.

    Example:
      "[S1] hello world [S1] more text [S2] reply [S1] back"
    → "[S1] hello world more text [S2] reply [S1] back"
    """
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r'(\[S\d+\])((?:(?!\[S\d+\]).)*)\1', r'\1\2', text)
    return text


# ---------------------------------------------------------------------------
# Preset voices — loaded once at cold-start
# ---------------------------------------------------------------------------

@dataclass
class PresetVoice:
    """A pre-loaded voice for zero-latency voice cloning."""
    name: str
    transcript: str
    audio: np.ndarray

    @property
    def duration_s(self) -> float:
        return len(self.audio) / SAMPLE_RATE


def _load_preset_voices() -> dict[str, PresetVoice]:
    """Load all voices from the voices manifest (if it exists)."""
    manifest_path = os.path.join(VOICES_DIR, "voices.json")
    voices: dict[str, PresetVoice] = {}

    if not os.path.exists(manifest_path):
        logger.warning(f"No voices manifest found at {manifest_path}, preset voices disabled.")
        return voices

    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (json.JSONDecodeError, ValueError, OSError) as e:
        logger.error(f"Failed to load voices manifest from {manifest_path}: {e}")
        manifest = {}

    for voice_id, meta in manifest.items():
        filename = meta.get("file")
        if not isinstance(filename, str):
            logger.warning(f"Voice '{voice_id}': missing or invalid 'file' entry in manifest, skipping.")
            continue

        wav_path = os.path.join(VOICES_DIR, filename)
        if not os.path.exists(wav_path):
            logger.warning(f"Voice '{voice_id}': file '{wav_path}' not found, skipping.")
            continue

        try:
            waveform, sr = torchaudio.load(wav_path)
            audio = _load_waveform(waveform, sr)

            voice = PresetVoice(
                name=meta.get("name", voice_id),
                transcript=meta.get("transcript", ""),
                audio=audio,
            )
            voices[voice_id] = voice
            logger.info(f"Loaded voice '{voice_id}' ({voice.name}): {voice.duration_s:.1f}s, {len(audio)} samples")
        except Exception as e:
            logger.error(f"Failed to load voice '{voice_id}': {e}")

    logger.info(f"Loaded {len(voices)} preset voice(s): {list(voices.keys())}")
    return voices


PRESET_VOICES = _load_preset_voices()


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------

@dataclass
class JobParams:
    """Parsed and validated job parameters."""
    input_texts: list[str]
    max_new_tokens: int = 3072
    guidance_scale: float = 3.0
    temperature: float = 1.8
    top_p: float = 0.90
    top_k: int = 50
    seed: int | None = None
    output_format: str = "wav"
    # Voice cloning
    voice: str | None = None
    audio_prompt_b64: str | None = None
    audio_prompt_transcript: str = ""
    # Resolved at prepare-time
    audio_array: np.ndarray | None = field(default=None, repr=False)

    @property
    def is_voice_cloning(self) -> bool:
        return self.voice is not None or self.audio_prompt_b64 is not None


def parse_input(job_input: dict) -> JobParams:
    """
    Parse raw job input into a JobParams dataclass.
    Raises AppError if validation fails.
    """
    texts = job_input.get("texts")

    if not texts or not isinstance(texts, list):
        raise AppError("INVALID_INPUT", "Missing required field 'texts' (list of strings).")

    if any(not isinstance(t, str) for t in texts):
        raise AppError("INVALID_INPUT", "All items in 'texts' must be strings.")


    # Ensure every text starts with a speaker tag
    input_texts = [ensure_speaker_tag(t) for t in texts]

    # Validate numeric inputs
    try:
        max_new_tokens = int(job_input.get("max_new_tokens", 3072))
        guidance_scale = float(job_input.get("guidance_scale", 3.0))
        temperature = float(job_input.get("temperature", 1.8))
        top_p = float(job_input.get("top_p", 0.90))
        top_k = int(job_input.get("top_k", 50))
    except (ValueError, TypeError) as e:
        raise AppError("INVALID_INPUT", f"Invalid numeric parameter: {e}. Check max_new_tokens, guidance_scale, temperature, top_p, top_k.")

    seed = job_input.get("seed")
    if seed is not None:
        try:
            seed = int(seed)
        except (ValueError, TypeError):
            raise AppError("INVALID_INPUT", f"Invalid seed value '{seed}': must be an integer.")

    return JobParams(
        input_texts=input_texts,
        max_new_tokens=max_new_tokens,
        guidance_scale=guidance_scale,
        temperature=temperature,
        top_p=top_p,
        top_k=top_k,
        seed=seed,
        output_format=job_input.get("output_format", "wav").lower(),
        voice=job_input.get("voice"),
        audio_prompt_b64=job_input.get("audio_prompt"),
        audio_prompt_transcript=job_input.get("audio_prompt_transcript", ""),
    )


# ---------------------------------------------------------------------------
# Voice cloning resolution
# ---------------------------------------------------------------------------

def resolve_voice_cloning(params: JobParams) -> None:
    """
    Resolve the voice cloning audio + transcript onto params.
    Mutates params in-place. Raises AppError if something's wrong.
    """
    # ── Preset voice ────────────────────────────────────────────
    if params.voice:
        voice_key = params.voice.upper()
        if voice_key not in PRESET_VOICES:
            available = list(PRESET_VOICES.keys()) or ["none loaded"]
            raise AppError("VOICE_NOT_FOUND", f"Unknown voice '{params.voice}'. Available: {available}")

        preset = PRESET_VOICES[voice_key]
        logger.info(f"Using preset voice: {voice_key} ({preset.name})")
        params.audio_array = preset.audio

        if not params.audio_prompt_transcript:
            params.audio_prompt_transcript = preset.transcript

    # ── Custom audio prompt ─────────────────────────────────────
    elif params.audio_prompt_b64:
        params.audio_array = load_audio_from_b64(params.audio_prompt_b64)

    # ── No voice cloning ────────────────────────────────────────
    else:
        return

    # ── Validate the resolved audio ─────────────────────────────
    audio = params.audio_array
    duration_s = len(audio) / SAMPLE_RATE

    logger.debug(f"Voice cloning mode: {len(audio)} samples, {duration_s:.2f}s @ {SAMPLE_RATE} Hz")

    if len(audio) == 0:
        raise AppError("AUDIO_QUALITY_ISSUE", "Audio prompt decoded to zero samples. Check the audio file.")

    if np.abs(audio).max() < 1e-6:
        raise AppError("AUDIO_QUALITY_ISSUE", "Audio prompt appears to be silent (all zeros). Check the audio file.")

    if duration_s < 3:
        logger.warning(f"Audio prompt is very short ({duration_s:.2f}s). Voice cloning may not work well with prompts under 3 seconds.")

    if duration_s > 15:
        logger.warning(f"Audio prompt is very long ({duration_s:.2f}s). This may cause memory issues. Consider using a 5-15 second clip.")

    if not params.audio_prompt_transcript:
        logger.warning("No transcript provided. Voice cloning works best when the transcript matches the audio prompt.")

    # ── Prepend transcript + clean up speaker tags ──────────────
    if params.audio_prompt_transcript:
        params.input_texts = [
            strip_consecutive_speaker_tags(params.audio_prompt_transcript + " " + t)
            for t in params.input_texts
        ]

    return None


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

from contextlib import contextmanager

@contextmanager
def temporary_seed(seed: int | None):
    """
    Context manager to temporarily set random seeds and deterministic flags.
    Restores valid global state (for cudnn flags) after the block.
    """
    if seed is None:
        yield
        return

    # 1. Capture previous state
    prev_deterministic = torch.backends.cudnn.deterministic
    prev_benchmark = torch.backends.cudnn.benchmark

    # 2. Set new state
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False

    try:
        yield
    finally:
        # 3. Restore previous state
        torch.backends.cudnn.deterministic = prev_deterministic
        torch.backends.cudnn.benchmark = prev_benchmark


def log_settings(params: JobParams, audio_prompt_len: int | None) -> None:
    """Log generation settings as a JSON blob with full prompt texts."""
    mode = "voice_clone" if params.is_voice_cloning else "tts"
    logger.info(f"Generation ({mode}) started")

    for i, t in enumerate(params.input_texts):
        logger.debug(f'text[{i}]: "{t}"')

    settings: dict = {
        "max_new_tokens": params.max_new_tokens,
        "guidance_scale": params.guidance_scale,
        "temperature": params.temperature,
        "top_p": params.top_p,
        "top_k": params.top_k,
        "seed": params.seed,
        "output_format": params.output_format,
    }
    if params.voice:
        settings["voice"] = params.voice
    if params.audio_prompt_b64 and not params.voice:
        settings["audio_prompt"] = f"<{len(params.audio_prompt_b64) * 3 // 4 // 1024} KB>"
    if audio_prompt_len is not None:
        settings["audio_prompt_len"] = audio_prompt_len

    logger.info(f"Settings: {json.dumps(settings)}")


def generate_speech(params: JobParams) -> list[str]:
    """
    Run the TTS/voice-cloning pipeline and return a list of base64-encoded
    audio strings. Raises AppError on failure.
    """
    # ── Prepare processor inputs ────────────────────────────────
    audio_prompt_len = None

    if params.is_voice_cloning and params.audio_array is not None:
        audio = params.audio_array
        audio_batch = [audio] * len(params.input_texts) if len(params.input_texts) > 1 else audio

        inputs = processor(
            text=params.input_texts,
            audio=audio_batch,
            padding=True,
            return_tensors="pt",
        ).to(DEVICE)
        audio_prompt_len = processor.get_audio_prompt_len(inputs["decoder_attention_mask"])
        logger.debug(f"Audio prompt len (tokens): {audio_prompt_len}")
    else:
        inputs = processor(text=params.input_texts, padding=True, return_tensors="pt").to(DEVICE)

    # ── Log ─────────────────────────────────────────────────────
    log_settings(params, audio_prompt_len)

    # ── Generate ────────────────────────────────────────────────
    generate_kwargs = {
        "max_new_tokens": params.max_new_tokens,
        "guidance_scale": params.guidance_scale,
        "temperature": params.temperature,
        "top_p": params.top_p,
        "top_k": params.top_k,
    }

    try:
        with temporary_seed(params.seed):
            with torch.no_grad():
                outputs = model.generate(**inputs, **generate_kwargs)

        audio_list = processor.batch_decode(outputs, audio_prompt_len=audio_prompt_len)
    except torch.cuda.OutOfMemoryError:
        logger.error("GPU out of memory")
        raise AppError("GPU_OOM", "GPU out of memory. Try reducing batch size or text length.")
    except Exception as e:
        logger.error(f"Generation failed: {e}", exc_info=True)
        raise AppError("GENERATION_FAILED", f"Generation failed: {e}")

    # ── Encode to base64 ────────────────────────────────────────
    return [tensor_to_base64(a, SAMPLE_RATE, fmt=params.output_format) for a in audio_list]


# ---------------------------------------------------------------------------
# RunPod handler (thin orchestrator)
# ---------------------------------------------------------------------------

def handler(job: dict) -> dict:
    """
    RunPod handler entry point.

    Input schema:
        texts           (list[str])      — List of texts to synthesise.
        max_new_tokens  (int, 3072)      — Maximum audio tokens.
        guidance_scale  (float, 3.0)     — Classifier-free guidance scale.
        temperature     (float, 1.8)     — Sampling temperature.
        top_p           (float, 0.90)    — Nucleus sampling.
        top_k           (int, 50)        — Top-k sampling.
        seed            (int|null)       — Random seed.
        output_format   (str, "wav")     — Audio format (wav / mp3 / flac).

    Voice cloning — preset or custom:
        voice                     (str)  — Preset voice ID (e.g. "F1", "M1").
        audio_prompt              (str)  — Base64-encoded audio to clone from.
        audio_prompt_transcript   (str)  — Transcript of the audio prompt.

    Returns: { "audio": ["<b64>", ...], "format": "wav", "count": N }
    """
    try:
        # 1. Parse input
        params = parse_input(job["input"])

        # 2. Resolve voice cloning (if requested)
        resolve_voice_cloning(params)

        # 3. Generate speech
        result = generate_speech(params)

        # 4. Format response
        logger.info(f"Generated {len(result)} audio clip(s)")
        return {"audio": result, "format": params.output_format, "count": len(result)}

    except AppError as e:
        logger.error(f"AppError: [{e.code}] {e.message}")
        return {"error": e.message, "code": e.code}

    except Exception as e:
        logger.critical(f"Unhandled exception in handler: {e}", exc_info=True)
        return {"error": f"Internal handler error: {str(e)}", "code": "INTERNAL_ERROR"}


runpod.serverless.start({"handler": handler})
