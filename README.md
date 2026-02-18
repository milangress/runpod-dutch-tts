# RunPod Dutch TTS — Parkiet

A [RunPod](https://runpod.io) serverless endpoint for Dutch text-to-speech using the [Parkiet](https://huggingface.co/pevers/parkiet) model (1.6B parameters, Dia-based architecture).

## Features

- **Multi-speaker** — Up to 4 speakers per prompt (`[S1]`, `[S2]`, `[S3]`, `[S4]`)
- **Voice cloning** — Provide a WAV audio prompt to clone a voice
- **Reproducible** — Optional seed for deterministic output
- **Serverless** — Scales to zero, pay only for compute time

## API

### Input

| Field | Type | Default | Description |
|---|---|---|---|
| `text` | `string` | *required* | Text to synthesise. Use `[S1]`, `[S2]`, etc. for speakers. |
| `max_new_tokens` | `int` | `3072` | Maximum audio tokens to generate |
| `guidance_scale` | `float` | `3.0` | Classifier-free guidance scale |
| `temperature` | `float` | `1.8` | Sampling temperature |
| `top_p` | `float` | `0.90` | Nucleus sampling probability |
| `top_k` | `int` | `50` | Top-k sampling |
| `seed` | `int\|null` | `null` | Random seed for reproducibility |
| `audio_prompt` | `string\|null` | `null` | Base64-encoded WAV for voice cloning |
| `output_format` | `string` | `"wav"` | Output format: `wav`, `mp3`, `flac` |

### Output

```json
{
  "audio": "<base64 encoded audio>",
  "format": "wav"
}
```

### Example Request

```json
{
  "input": {
    "text": "[S1] hallo, hoe gaat het met je? [S2] het gaat goed, dankjewel!",
    "temperature": 1.8,
    "output_format": "wav"
  }
}
```

## Generation Guidelines

- Always start with `[S1]` and alternate between speakers
- Prefer lowercase text with punctuation
- Write out digits as words (e.g. "drie" instead of "3")
- Use `...` for pauses, `uh` / `uhm` / `mmm` for disfluencies
- Use `(laughs)` sparingly for laughter

## Deploy

### Option 1: GitHub Integration (Recommended)

1. Push this repo to GitHub
2. Connect it to [RunPod Serverless](https://docs.runpod.io/serverless/github-integration)
3. RunPod builds and deploys automatically on push

### Option 2: Manual Docker Build

```bash
docker build -t runpod-dutch-tts .
docker tag runpod-dutch-tts your-registry/runpod-dutch-tts:latest
docker push your-registry/runpod-dutch-tts:latest
```

Then create a new Endpoint in RunPod pointing to your image.

## Local Testing

```bash
pip install -r requirements.txt
python handler.py
```

This runs the handler against `test_input.json` using the RunPod SDK's local test mode.

## Hardware

The model requires a GPU with ~10 GB VRAM (bfloat16 compute). Recommended: NVIDIA A40 / RTX 4090 or better.

## License

Code: [MIT](LICENSE). Model: [RAIL-M](https://github.com/pevers/parkiet/blob/main/MODEL_LICENSE).
