# moss_sfx_worker.py

## Purpose
Runs MOSS-SoundEffect v2 for the SFX server in its own venv (`.venv-moss`), kept alive so its weights load once.

## Components

### `main`
- **Does**: Loads the pipeline with VRAM management on (each stage moves only its model to the GPU; peak ~9 GB, fits beside Breeze), replies `ready`, then serves JSON-line jobs from stdin: prompt, seconds (≤30), steps (100), cfg (4.0), seed, output path. Writes 48 kHz mono 24-bit WAV and replies with the path and duration. Replies carry the `@@MOSS ` prefix because the libraries print to stdout too.
- **Interacts with**: [sfx_server](sfx_server.py) (`_ensure_moss`, `_run_moss_sfx`, `_stop_moss`).

## Notes
- Never shrink `max_inference_seconds`: the pipeline denoises a fixed 30 s canvas and crops. A shorter canvas saved memory in the 2026-10 shootout but produced noise (CLAP 0.12 vs 0.37).
- VRAM management leaves the output unchanged (matches an all-on-GPU run to 24-bit precision); it costs ~7 s per clip in transfers.
