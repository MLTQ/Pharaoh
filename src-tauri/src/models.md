# models.rs

## Purpose
Shared serialized models for the Rust backend. This file defines project, scene, script, config, request, and event payload shapes used across Tauri commands and the CLI.

## Components

### `Project`, `Scene`, `Storyboard`, `ScriptRow`
- **Does**: Represent the persistent story and composition data model on disk.
- **Interacts with**: `project.rs`, `script.rs`, `cli.rs`.

### `AppConfig`, `ServerConfig`, `AppState`
- **Does**: Hold runtime configuration and shared clients/locks for the native app, including TTS/SFX/music/Post server URLs.
- **Interacts with**: `lib.rs`, `settings.rs`, `app_support.rs`.

### `Tts*Request`, `SfxT2ARequest`, `MusicText2MusicRequest`
- **Does**: Encode generation payloads sent to the Python servers.
- **Interacts with**: `inference.rs`, `cli.rs`.
- **Rationale**: Clone requests include `max_new_tokens` because Qwen can otherwise spend unbounded time in generation.

### `JobProgressEvent`, `JobCompleteEvent`, `JobFailedEvent`
- **Does**: Define frontend event payloads for live generation state.
- **Interacts with**: `jobStore.ts`.

### `SidecarMeta`, `GeneratedAudioAsset`
- **Does**: Represent persisted generated-asset metadata and the flattened asset list returned to the UI.
- **Interacts with**: `sidecar.rs`, `UpscaleView.tsx`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Frontend TypeScript stores | Rust event payloads stay shape-compatible | Event field rename/removal |
| `cli.rs` | Request models serialize directly to inference server JSON | Payload shape changes |
| `app_support.rs` | `ScriptRow` fields remain stringly-typed CSV mirrors | Type changes |
| `UpscaleView.tsx` | Generated assets include path, kind, prompt, model, and timing metadata | Removing `GeneratedAudioAsset` fields |
| Settings/model stores | `AppConfig` and `AllServerHealth` include `post` alongside TTS/SFX/music | Omitting Post server fields |

## Notes
- `JobCompleteEvent` now carries duration and binding metadata so the UI can react to automatic row binding.
- `SfxT2ARequest.backend` is optional for compatibility; absent means Woosh. AudioLDM callers should also set AudioLDM-specific guidance fields when needed.
