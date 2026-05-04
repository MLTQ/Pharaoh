# tts_server.py

## Purpose
FastAPI server for Qwen3-TTS generation. It manages typed TTS model loading, job state, and asynchronous dialogue/voice-design/voice-clone synthesis.

## Components

### `_resolve_model_dir`, `_ensure_model`, `_do_load`
- **Does**: Locate and load the required TTS model type from `PHARAOH_TTS_MODEL_DIR`.
- **Interacts with**: Qwen3-TTS local checkpoint folders and `/load`.

### `_run_tts`
- **Does**: Executes the requested TTS endpoint in a background job and writes the resulting WAV.
- **Interacts with**: `JobStore` in `_common.py`, Qwen `Qwen3TTSModel` methods.

### `_run_blocking_generation`
- **Does**: Runs blocking Qwen generation calls in an executor while emitting coarse progress updates.
- **Interacts with**: `_run_tts`, `/jobs/{job_id}`.
- **Rationale**: Qwen generation does not expose token-level progress, but the UI needs heartbeat progress during long clone/design calls.

### `/generate/*`, `/jobs/{job_id}`
- **Does**: Submit jobs and expose polling state to the Rust backend.
- **Interacts with**: `commands/inference.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `commands/inference.rs` | Generate endpoints return `{ job_id }` quickly | Blocking endpoint responses |
| `jobStore.ts` | `/jobs/{id}` progress changes over time | Static progress during long calls |
| Character Designer | Clone requests honor `max_new_tokens` to limit runaway generation | Ignoring the cap |

## Notes
- SoX is optional for current startup, but installing it may improve audio preprocessing paths in dependencies that expect it.
