# types.ts

## Purpose
Shared TypeScript contracts for project data, script rows, jobs, server health, and UI/navigation structures.

## Components

### `ServerHealth`
- **Does**: Represents common inference server health fields plus optional SFX AudioLDM and Post AudioSR readiness fields.
- **Interacts with**: `modelStore.ts`, `ModelsView.tsx`.
- **Rationale**: TTS, SFX, and music share one health polling path, but only SFX reports `audioldm_*` optional fields such as engine, CUDA support, and local model path.

### Script and job types
- **Does**: Keep frontend data structures aligned with Rust models and CSV parsing; `ModelKind` includes `post` for Post server jobs such as AudioSR.
- **Interacts with**: `csvParser.ts`, stores, timeline, asset browser.

### `Character`, `VoiceAssignment`, `RvcConfig`, `PaletteEntry`
- **Does**: Mirror the Rust character/voice/RVC shape. `production_pipeline` is the production-time switch ("chatterbox" vs "chatterbox+rvc"); the legacy `model` enum is kept for back-compat but new UI code should derive the badge from data instead.
- **Interacts with**: `CharacterDesignerView.tsx`, `projectStore.ts`, `commands/project.rs` (backend migration).
- **Rationale**: `Character.schema_version` is informational only — migration always runs server-side in `migrate_project_in_place`. `RvcConfig.corpus_count` and `corpus_duration_ms` are recomputed by the backend on every `get_project`, so the UI never needs an extra request to keep stats fresh.

### `GeneratedAudioAsset`
- **Does**: Represents sidecar-indexed WAV files available for review and upscaling.
- **Interacts with**: `ClipStudioView.tsx`, `UpscaleView.tsx`, `list_generated_audio_assets`.
- **Rationale**: Generated assets must be discoverable after app restart, independent of the transient job queue.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Store code | Optional health extensions remain optional | Making SFX-only fields mandatory |
| Tauri wrappers | Field names mirror Rust serde payloads | Renaming shared fields |
| App navigation | `ViewId` includes every page rendered by `App.tsx`, including Post pages | Adding pages without updating the union |

## Notes
- Keep this file declarative. Model routing decisions belong in hooks, stores, or backend commands.
