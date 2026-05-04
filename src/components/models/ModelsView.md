# ModelsView.tsx

## Purpose
Model lifecycle panel for checking server health and preloading local inference models.

## Components

### TTS variant picker
- **Does**: Selects the Qwen3-TTS variant sent to the TTS server `/load` endpoint.
- **Interacts with**: `modelStore.ts`, Tauri `load_model`.

### SFX variant picker
- **Does**: Selects between `Woosh-DFlow` and `AudioLDM-S-Full-V2` before loading the SFX server.
- **Interacts with**: `sfx_server.py` `/load`.
- **Rationale**: AudioLDM is an optional backend on the same SFX server. It should be preloadable without introducing a fourth top-level model kind.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `modelStore.ts` | `loadModel("sfx", variant)` posts the selected variant | Dropping variant forwarding |
| SFX server | AudioLDM variants start with `AudioLDM` | Renaming without updating server detection |

## Notes
- The panel only reports optional AudioLDM dependency readiness. Installation remains a setup-script concern.
