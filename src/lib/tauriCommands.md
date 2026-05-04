# tauriCommands.ts

## Purpose
Typed frontend wrappers around Tauri `invoke` calls. This file keeps component code using structured TypeScript request shapes instead of raw command strings and ad hoc payloads.

## Components

### Project, scene, and script wrappers
- **Does**: Expose project CRUD, scene CRUD, and `script.csv` read/write/update commands.
- **Interacts with**: Rust command modules under `src-tauri/src/commands/`.

### Inference wrappers
- **Does**: Submit TTS, SFX, and music generation jobs to Rust.
- **Interacts with**: generation panels, Character Designer, `commands/inference.rs`.
- **Rationale**: `submitTtsVoiceClone` includes `max_new_tokens` so clone generation is bounded like other TTS modes.

### Sidecar and audio wrappers
- **Does**: Read/write sidecars and call audio utility/render commands.
- **Interacts with**: asset browser, timeline, playback helpers.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| React components | Function argument shapes match Rust serde models | Payload field rename/removal |
| `commands/inference.rs` | TTS clone payload includes generation cap | Omitting `max_new_tokens` |
| `CompositionView.tsx` | `renderScene` returns an output path string | Return type changes |

## Notes
- Keep this file boring: it should mirror backend command shapes and avoid frontend business logic.
