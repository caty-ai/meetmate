# Path 2 — voice conversion of gpt-live-1 output (Seed-VC zero-shot), Issue #251

Goal: keep gpt-live-1's audio (timing, fillers, interruptions) and convert only its timbre to the agent's own voice after the fact. Test-only; no realtime implementation.

## Setup used (macOS, Apple Silicon, 2026-09-11)

```bash
git clone --depth 1 https://github.com/Plachtaa/seed-vc.git repo && cd repo
uv venv --python /opt/homebrew/bin/python3.10 .venv
# requirements-mac.txt uses "torch --pre --extra-index-url" lines that uv rejects; install torch separately
uv pip install --python .venv/bin/python torch torchaudio torchcodec
grep -v -E "^(torch|torchvision|torchaudio|--extra-index-url|gradio|FreeSimpleGUI|sounddevice|funasr|modelscope|jiwer|resemblyzer)" requirements-mac.txt > req-inference.txt
uv pip install --python .venv/bin/python -r req-inference.txt
```

`torchcodec` is required by torchaudio 2.14 for `torchaudio.save` (first run failed without it). Model checkpoints download from HuggingFace on first run (~2.5 min including download; ~20 s afterwards for a 39 s clip).

## Target voice

15-second reference synthesized with Fish Audio TTS (`POST /v1/tts`, `model: s2.1-pro`, `reference_id` = CatyPhone default preset `fish-neutral-ja-v1` = `0089dce5fefb4c6ba9b9f2f0debe1ddc`, `format: wav`, `sample_rate: 24000`; 22050 is rejected by the API). Stored locally as `path2/ref-caty-fish.wav` (git-ignored).

## Command

```bash
.venv/bin/python inference.py \
  --source ../runs/solo-1/output.wav --target ../path2/ref-caty-fish.wav \
  --output ../path2 --diffusion-steps 10 --length-adjust 1.0 --inference-cfg-rate 0.7 --f0-condition False
```

## Result

| Item | Value |
|---|---|
| Source | `runs/solo-1/output.wav` (gpt-live-1 voice `quartz`, 39 s, 16 kHz) |
| Output | `path2/solo-1-vc-caty.wav` (22.05 kHz, 40 s) |
| Conversion time | ~20 s for 39 s of audio, RTF 0.24 on MPS (10 diffusion steps) |
| Placeholder run | `path2/solo-1-vc-kyoko-placeholder.wav` (target = macOS `say -v Kyoko`), RTF 0.20 |
| Listening note | Owner 2026-09-11: intonation and pitch accent sound off to a Japanese listener; voice similarity does not compensate. **Rejected** in favour of Path 3. |

## What this says about a realtime variant

- RTF 0.2–0.24 offline means the compute budget exists for streaming on this class of machine; Seed-VC's realtime GUI reports ~430 ms end-to-end on a laptop GPU with the tiny model and 10 steps. Expect a similar order of added latency, plus the Bridge's chunking.
- Zero-shot conversion preserves gpt-live-1's prosody and timing exactly (fillers, cut-offs, pauses), which Path 3 cannot.
- Open: Japanese pitch/accent fidelity after conversion, robustness to backchannels shorter than the model's context window, and whether a Fish-synthesized reference is an acceptable stand-in for the real target voice.
