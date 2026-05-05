# audio_enhance.rs

## Purpose
Rust-side post-processing commands for neural audio enhancement. The first implementation shells out to AudioSR so Pharaoh can upscale generated assets without folding AudioSR's heavy Python stack into the Tauri binary.

## Components

### `upscale_audio_asset`
- **Does**: Runs the AudioSR CLI on a selected WAV, copies the newest generated WAV beside the source, and writes a parent-linked sidecar.
- **Interacts with**: `UpscaleView.tsx`, `sidecar.rs`, optional `inference/.venv-audiosr`.
- **Rationale**: AudioSR is an optional, slow, model-heavy pass. Keeping it as a CLI subprocess makes it headless and avoids dependency conflicts with TTS/SFX/music servers.

### `upscale_audio_asset_path`
- **Does**: Shared implementation used by both GUI Tauri command and headless CLI mode.
- **Interacts with**: `cli.rs`.

### AudioSR CLI resolution
- **Does**: Checks `PHARAOH_AUDIOSR_CLI`, then searches for `inference/.venv-audiosr/bin/audiosr` near the current process.
- **Interacts with**: `setup.sh`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `UpscaleView.tsx` | Missing AudioSR returns an actionable setup error | Returning a generic process error |
| `cli.rs` | Shared helper works without an `AppHandle` | Adding GUI-only dependencies |
| `sidecar.rs` | Upscaled output has a valid sidecar with `parent` set to the source path | Omitting sidecar writes |
| Users/agents | Output lands next to the source as `{stem}.upscaled.{model}.{timestamp}.wav` | Moving output without reporting the path |

## Notes
- AudioSR itself is responsible for model downloads and device selection. Pharaoh only manages input/output and metadata.
