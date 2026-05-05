# post_server.py

## Purpose
FastAPI server for Pharaoh post-processing work on port 18004. It keeps neural enhancement on the ML host instead of inside the Tauri UI process.

## Components

### `UpscaleParams`
- **Does**: Defines the AudioSR request payload: input path, output path, model, DDIM steps, guidance, seed, and optional caller job id.
- **Interacts with**: `audio_enhance.rs`.

### `_run_upscale`
- **Does**: Runs the AudioSR CLI in the server environment, maps CLI progress text into Pharaoh job progress, and copies the generated WAV to the requested output path.
- **Interacts with**: `JobStore`, `.venv-audiosr/bin/audiosr`.
- **Rationale**: AudioSR is a heavy ML dependency and must execute on the inference host, not in the desktop UI process.

### `/generate/upscale`, `/jobs/{job_id}`
- **Does**: Submit asynchronous upscale jobs and expose polling state.
- **Interacts with**: `audio_enhance.rs`, `UpscaleView.tsx`.

### `/health`, `/load`, `/unload`
- **Does**: Report AudioSR CLI readiness using the same server-management surface as other inference services.
- **Interacts with**: Settings and model health polling.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `audio_enhance.rs` | `/generate/upscale` returns `{ job_id }` and `/jobs/{id}` returns `JobStatus` | Response shape changes |
| `start_servers.sh` | Server runs under `.venv-audiosr` on port 18004 | Changing default port or venv |
| Remote deployments | `input_path` and `output_path` are visible on the inference host | Requiring local-only paths |

## Notes
- The current generation servers also use shared filesystem paths. For fully separate machines without shared storage, the next architectural step is upload/download transport for generated audio assets.
