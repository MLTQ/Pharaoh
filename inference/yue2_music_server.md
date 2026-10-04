# yue2_music_server.py

## Purpose
Pharaoh's music engine on port 18003 when installed (Linux + BF16 NVIDIA GPU): YuE2-3B behind the same API as `music_server.py` (ACE-Step), so every caller keeps working. Chosen after a test on the RTX 4090 on 2026-10-04: much better music than ACE-Step v1, ~8 GB VRAM, ~3x realtime.

## Components

### `/generate/text2music` → `_compose`
1. **Plan**: YuE2 writes an ABC score from the style (caption + key + BPM, plus "Instrumental … no vocals…" when instrumental). The planner is capped at `400 + 30 × duration` ABC tokens (4096 for songs) because it otherwise writes 4–9 minutes for a 30 s cue.
2. **Shape** (`yue2_score.py`): repair a plan the cap cut mid-line, force the BPM into `Q:`, and for instrumental cues move the vocal line to the instrument voice and trim to whole bars that fit the duration. Lyrics become section tags only.
3. **Render**: audio tokens capped at `(duration + 10 s) × 25`; if the cap cuts the music, the last 2 s fade out.
4. Writes 48 kHz stereo PCM_24 WAV, `<take>.wav.score.abc`, and a sidecar. The job `result` carries `model`, `seed`, `style`, `instrumental`, `cut_off`, `score_path`.

### `/generate/repaint`, `/generate/cover` → `_run_ace`
YuE2 can only re-render a whole score, so these run ACE-Step v1 through `ace_step_worker.py` in `PHARAOH_MUSIC_PYTHON` (`.venv-music`), after unloading YuE2. Repaint output is then spliced (`_splice_repaint`): the source is kept bit-for-bit outside the window, with 100 ms crossfades, at the source's bit depth. ACE-Step on its own re-encodes the whole file to 16-bit.

### `/health`
Reports `engine: "yue2"` (the app shows YuE2 controls), whether the weights are cached, and `capabilities.repaint/cover` (whether `.venv-music` and the ACE-Step weights exist).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `commands/inference.rs`, CLI, MCP | ACE-Step-compatible endpoints; extra ACE fields accepted and ignored | Renaming endpoints or required fields |
| `SidecarMeta::apply_server_model` | `result.model` on completed jobs | Dropping `result.model` (takes would be labelled ACE-Step) |
| `MusicPanel.tsx` | `/health.engine == "yue2"` | Dropping `engine` |

## Notes
- Weights come from the Hugging Face cache (`setup.sh yue2`). Env: `PHARAOH_YUE2_MODEL`, `PHARAOH_YUE2_VAE`, `PHARAOH_YUE2_DEVICE`, `PHARAOH_MUSIC_PYTHON`.
- Between jobs YuE2 keeps its weights on the CPU (it moves them off the GPU to decode), so idle VRAM is small.
- Key is only a style hint; the planner may choose a different key.
- Remote clients get the WAV through `/files`; the score stays on the server and is deleted with it.
- Weights: CC BY-NC 4.0, plus a creator permission (monetising your own work is allowed).
