# types.ts

## Purpose
Shared TypeScript contracts for project data, script rows, jobs, server health, and UI/navigation structures.

## Components

### `ServerHealth`
- **Does**: Represents common inference server health fields and optional SFX AudioLDM readiness fields.
- **Interacts with**: `modelStore.ts`, `ModelsView.tsx`.
- **Rationale**: TTS, SFX, and music share one health polling path, but only SFX reports `audioldm_*` optional fields such as engine, CUDA support, and local model path.

### Script and job types
- **Does**: Keep frontend data structures aligned with Rust models and CSV parsing.
- **Interacts with**: `csvParser.ts`, stores, timeline, asset browser.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Store code | Optional health extensions remain optional | Making SFX-only fields mandatory |
| Tauri wrappers | Field names mirror Rust serde payloads | Renaming shared fields |

## Notes
- Keep this file declarative. Model routing decisions belong in hooks, stores, or backend commands.
