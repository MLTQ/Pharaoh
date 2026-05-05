# audio_enhance.rs

## Purpose
Rust-side post-processing command plumbing for neural audio enhancement. It submits AudioSR work to the Post inference server instead of running ML code inside the Tauri UI process.

## Components

### `upscale_audio_asset`
- **Does**: Computes the destination path, submits `/generate/upscale` to the configured Post server, and starts a background poller.
- **Interacts with**: `UpscaleView.tsx`, `post_server.py`, `AppState`.
- **Rationale**: AudioSR is heavy ML work and must run on the inference host for split local-UI/remote-server deployments.

### `poll_post_until_done`
- **Does**: Polls `/jobs/{id}`, emits frontend job progress, writes sidecar metadata when complete, and emits completion/failure events.
- **Interacts with**: `jobStore.ts`, `sidecar.rs`.

### `output_path_for`, `write_upscale_sidecar`
- **Does**: Shared helpers for GUI and headless CLI post upscaling.
- **Interacts with**: `cli.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `UpscaleView.tsx` | Command returns quickly with the caller-owned job id | Blocking until AudioSR finishes |
| `post_server.py` | Request includes shared `input_path`, `output_path`, model, steps, guidance, and seed | Payload field changes |
| `jobStore.ts` | Progress/completion events use model `post` and the submitted job id | Emitting server-only ids |
| `sidecar.rs` | Upscaled output has a valid sidecar with `parent` set to the source path | Omitting sidecar writes |
| Users/agents | Output lands next to the source as `{stem}.upscaled.{model}.{timestamp}.wav` | Moving output without reporting the path |

## Notes
- This still relies on shared filesystem paths, matching the current TTS/SFX/music server contract. Fully remote deployments without shared storage need an upload/download asset transport layer.
