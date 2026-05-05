# sidecar.rs

## Purpose
Tauri commands for reading and writing generated-audio sidecar metadata. Sidecars are the persistent index for takes after the in-memory job queue is gone.

## Components

### `write_sidecar`, `read_sidecar`
- **Does**: Write or read `{audio}.meta.json` files next to generated WAV files.
- **Interacts with**: `commands/inference.rs`, frontend QA and review panels.

### `list_generated_audio_assets`
- **Does**: Scans a project's `scenes/*/assets` folders for WAV sidecars and returns selectable generated assets.
- **Interacts with**: `UpscaleView.tsx`.
- **Rationale**: The upscale workflow must work across app restarts, so it cannot depend on the transient frontend job store.

### `get_takes`, `update_sidecar_qa`
- **Does**: Enumerate alternate takes for a base path and update QA state.
- **Interacts with**: `AssetBrowser.tsx`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `UpscaleView.tsx` | `list_generated_audio_assets` returns existing WAV paths with sidecar-derived metadata | Filtering out completed sidecars |
| `AssetBrowser.tsx` | QA updates mutate the existing sidecar file | Changing sidecar path derivation |
| `commands/inference.rs` | Sidecar path is `{audio_path}.meta.json` | Changing `meta_path` naming |

## Notes
- Asset kind is inferred from the sidecar model string. AudioSR child assets inherit kind from their parent sidecar when available.
