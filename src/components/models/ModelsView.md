# ModelsView.tsx

## Purpose
Model lifecycle panel for checking server health and preloading local inference models.

## Components

### TTS variant picker
- **Does**: Selects the Qwen3-TTS variant sent to the TTS server `/load` endpoint.
- **Interacts with**: `modelStore.ts`, Tauri `load_model`.

### SFX variant picker
- **Does**: Selects between `Woosh-DFlow`, `AudioLDM-M-Full`, and smaller AudioLDM variants before loading the SFX server.
- **Interacts with**: `sfx_server.py` `/load`.
- **Rationale**: AudioLDM is an optional backend on the same SFX server. The native runner defaults to upstream's recommended `audioldm-m-full` checkpoint without introducing a fourth top-level model kind.

### Dissect card
- **Does**: A fourth managed server (`dissect`, port 18007) with one Load that brings up all four models — BandIt Plus, Nemotron-3-Diarization, TitaNet, Parakeet — each shown with a loaded dot from `/health.loaded`. Warns when the separator weights are missing or the server is in stub mode.
- **Interacts with**: `modelStore` (`dissect` status/health), Rust `load_model` / `unload_model` / `check_server_health` (`"dissect"` arm).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `modelStore.ts` | `loadModel("sfx", variant)` posts the selected variant | Dropping variant forwarding |
| SFX server | AudioLDM variants start with `AudioLDM` | Renaming without updating server detection |

## Notes
- The panel only reports optional AudioLDM dependency readiness. Installation remains a setup-script concern.
- `invoke` routes via `lib/transport.ts`.
