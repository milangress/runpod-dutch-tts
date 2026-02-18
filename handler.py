"""
RunPod Serverless Handler for Parkiet — Dutch Text-to-Speech (TTS)

Loads the pevers/parkiet model (1.6B param Dia-based architecture) at startup
and serves TTS requests via the RunPod serverless framework.

Supports both single-text and batch requests:
  - Single: { "text": "..." }         → { "audio": "<b64>", "format": "wav" }
  - Batch:  { "texts": ["...", ...] }  → { "audio": ["<b64>", ...], "format": "wav" }

Voice cloning via preset voices or custom audio prompts:
  - Preset: { "text": "...", "voice": "F1" }
  - Custom: { "text": "...", "audio_prompt": "<b64>", "audio_prompt_transcript": "..." }
"""

from __future__ import annotations

import base64
import io
import json
import os
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
# Initialisation — runs once at cold-start
# ---------------------------------------------------------------------------

MODEL_ID = os.environ.get("MODEL_ID", "pevers/parkiet")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
VOICES_DIR = os.environ.get("VOICES_DIR", "/voices")

print(f"Loading model '{MODEL_ID}' on device '{DEVICE}' ...")
processor = AutoProcessor.from_pretrained(MODEL_ID)
model = DiaForConditionalGeneration.from_pretrained(MODEL_ID).to(DEVICE)
SAMPLE_RATE: int = processor.feature_extractor.sampling_rate
print(f"Model loaded successfully. Sample rate: {SAMPLE_RATE}")


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
    audio_bytes = base64.b64decode(b64_audio)

    # Create temp file without keeping it open, so torchaudio can open it safely
    f = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
    tmp_path = f.name

    try:
        f.write(audio_bytes)
        f.flush()
        f.close()

        waveform, sr = torchaudio.load(tmp_path)
        return _load_waveform(waveform, sr)
    finally:
        if os.path.exists(tmp_path):
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
        print(f"No voices manifest found at {manifest_path}, preset voices disabled.")
        return voices

    with open(manifest_path) as f:
        manifest = json.load(f)

    for voice_id, meta in manifest.items():
        wav_path = os.path.join(VOICES_DIR, meta["file"])
        if not os.path.exists(wav_path):
            print(f"⚠️  Voice '{voice_id}': file '{wav_path}' not found, skipping.")
            continue

        waveform, sr = torchaudio.load(wav_path)
        audio = _load_waveform(waveform, sr)

        voice = PresetVoice(
            name=meta.get("name", voice_id),
            transcript=meta.get("transcript", ""),
            audio=audio,
        )
        voices[voice_id] = voice
        print(f"   ✅ Voice '{voice_id}' ({voice.name}): {voice.duration_s:.1f}s, {len(audio)} samples")

    print(f"Loaded {len(voices)} preset voice(s): {list(voices.keys())}")
    return voices


PRESET_VOICES = _load_preset_voices()


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------

@dataclass
class JobParams:
    """Parsed and validated job parameters."""
    input_texts: list[str]
    is_batch: bool
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


def parse_input(job_input: dict) -> JobParams | dict:
    """
    Parse raw job input into a JobParams dataclass.
    Returns an error dict if validation fails.
    """
    texts = job_input.get("texts")
    text = job_input.get("text")

    if texts and isinstance(texts, list):
        is_batch = True
        input_texts = texts
    elif text:
        is_batch = False
        input_texts = [text]
    else:
        return {"error": "Missing required field 'text' (string) or 'texts' (list of strings)."}

    # Ensure every text starts with a speaker tag
    input_texts = [ensure_speaker_tag(t) for t in input_texts]

    # Validate numeric inputs
    try:
        max_new_tokens = int(job_input.get("max_new_tokens", 3072))
        guidance_scale = float(job_input.get("guidance_scale", 3.0))
        temperature = float(job_input.get("temperature", 1.8))
        top_p = float(job_input.get("top_p", 0.90))
        top_k = int(job_input.get("top_k", 50))
    except (ValueError, TypeError) as e:
        return {"error": f"Invalid numeric parameter: {e}. Check max_new_tokens, guidance_scale, temperature, top_p, top_k."}

    seed = job_input.get("seed")
    if seed is not None:
        try:
            seed = int(seed)
        except (ValueError, TypeError):
             return {"error": f"Invalid seed value '{seed}': must be an integer."}

    return JobParams(
        input_texts=input_texts,
        is_batch=is_batch,
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

def resolve_voice_cloning(params: JobParams) -> dict | None:
    """
    Resolve the voice cloning audio + transcript onto params.
    Mutates params in-place. Returns an error dict if something's wrong, else None.
    """
    # ── Preset voice ────────────────────────────────────────────
    if params.voice:
        voice_key = params.voice.upper()
        if voice_key not in PRESET_VOICES:
            available = list(PRESET_VOICES.keys()) or ["none loaded"]
            return {"error": f"Unknown voice '{params.voice}'. Available: {available}"}

        preset = PRESET_VOICES[voice_key]
        print(f"🎤 Using preset voice: {voice_key} ({preset.name})")
        params.audio_array = preset.audio

        if not params.audio_prompt_transcript:
            params.audio_prompt_transcript = preset.transcript

    # ── Custom audio prompt ─────────────────────────────────────
    elif params.audio_prompt_b64:
        try:
            params.audio_array = load_audio_from_b64(params.audio_prompt_b64)
        except Exception as e:
            return {"error": f"Failed to decode audio_prompt: {e}"}

    # ── No voice cloning ────────────────────────────────────────
    else:
        return None

    # ── Validate the resolved audio ─────────────────────────────
    audio = params.audio_array
    duration_s = len(audio) / SAMPLE_RATE

    print(f"🎤 Voice cloning mode:")
    print(f"   Audio: {len(audio)} samples, {duration_s:.2f}s @ {SAMPLE_RATE} Hz")
    print(f"   Audio range: [{audio.min():.4f}, {audio.max():.4f}], dtype={audio.dtype}")
    print(f"   Transcript: {'provided (' + str(len(params.audio_prompt_transcript)) + ' chars)' if params.audio_prompt_transcript else 'MISSING'}")
    print(f"   Batch size: {len(params.input_texts)} text(s)")

    if len(audio) == 0:
        return {"error": "Audio prompt decoded to zero samples. Check the audio file."}

    if np.abs(audio).max() < 1e-6:
        return {"error": "Audio prompt appears to be silent (all zeros). Check the audio file."}

    if duration_s < 3:
        print(f"   ⚠️  WARNING: Audio prompt is very short ({duration_s:.2f}s). "
              "Voice cloning may not work well with prompts under 3 seconds.")

    if duration_s > 15:
        print(f"   ⚠️  WARNING: Audio prompt is very long ({duration_s:.2f}s). "
              "This may cause memory issues. Consider using a 5-15 second clip.")

    if not params.audio_prompt_transcript:
        print("   ⚠️  WARNING: No transcript provided. "
              "Voice cloning works best when the transcript matches the audio prompt.")

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

def set_seed(seed: int) -> None:
    """Set all random seeds for reproducible generation."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False


def log_settings(params: JobParams, audio_prompt_len: int | None) -> None:
    """Log generation settings as a JSON blob with full prompt texts."""
    mode = "voice_clone" if params.is_voice_cloning else "tts"
    print(f"\n🔧 Generation ({mode}, {'batch' if params.is_batch else 'single'}):")

    for i, t in enumerate(params.input_texts):
        print(f'   text[{i}]: "{t}"')

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
    print(f"   {json.dumps(settings)}")


def generate_speech(params: JobParams) -> list[str] | dict:
    """
    Run the TTS/voice-cloning pipeline and return a list of base64-encoded
    audio strings, or an error dict.
    """
    # ── Seed ────────────────────────────────────────────────────
    if params.seed is not None:
        set_seed(int(params.seed))

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
        print(f"   Audio prompt len (tokens): {audio_prompt_len}")
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
        with torch.no_grad():
            outputs = model.generate(**inputs, **generate_kwargs)

        audio_list = processor.batch_decode(outputs, audio_prompt_len=audio_prompt_len)
    except torch.cuda.OutOfMemoryError:
        return {"error": "GPU out of memory. Try reducing batch size or text length."}
    except Exception as e:
        return {"error": f"Generation failed: {e}"}

    # ── Encode to base64 ────────────────────────────────────────
    return [tensor_to_base64(a, SAMPLE_RATE, fmt=params.output_format) for a in audio_list]


# ---------------------------------------------------------------------------
# RunPod handler (thin orchestrator)
# ---------------------------------------------------------------------------

def handler(job: dict) -> dict:
    """
    RunPod handler entry point.

    Input schema (single):
        text            (str, required)  — Text to synthesise. Use [S1], [S2] for speakers.
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

    Input schema (batch):
        texts           (list[str])      — Multiple texts in one request.

    Returns (single): { "audio": "<b64>", "format": "wav" }
    Returns (batch):  { "audio": ["<b64>", ...], "format": "wav", "count": N }
    """
    # 1. Parse input
    params = parse_input(job["input"])
    if isinstance(params, dict):
        return params  # error

    # 2. Resolve voice cloning (if requested)
    error = resolve_voice_cloning(params)
    if error:
        return error

    # 3. Generate speech
    result = generate_speech(params)
    if isinstance(result, dict):
        return result  # error

    # 4. Format response
    if params.is_batch:
        return {"audio": result, "format": params.output_format, "count": len(result)}
    else:
        return {"audio": result[0], "format": params.output_format}


runpod.serverless.start({"handler": handler})
