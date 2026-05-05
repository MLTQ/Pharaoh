# modelStore.ts

## Purpose
Zustand store for inference server health, model load/unload state, and load-progress events.

## Components

### `ServerHealth`
- **Does**: Mirrors `/health` payloads from TTS, SFX, music, and Post servers.
- **Interacts with**: `ModelsView.tsx`.
- **Rationale**: The SFX health shape includes optional AudioLDM readiness and CUDA capability fields while the shared store remains compatible with TTS and music responses.

### `pollHealth`, `loadModel`, `unloadModel`
- **Does**: Calls Tauri inference commands and updates online/loading/offline state.
- **Interacts with**: `commands/inference.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ModelsView.tsx` | Optional SFX-only AudioLDM and Post-only AudioSR fields may be absent | Treating optional fields as required |
| Tauri settings commands | Health polling returns JSON matching `ServerHealth` | Removing common fields |

## Notes
- `loadModel("sfx", variant)` forwards the selected variant through Tauri to the SFX server, enabling AudioLDM preloading without a separate store key.
- `post` is tracked as a server kind so AudioSR can run remotely like the generation services.
