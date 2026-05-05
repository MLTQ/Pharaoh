# SettingsView.tsx

## Purpose
Settings panel for inference server URLs, model download commands, and install guidance.

## Components

### Model cards
- **Does**: Render per-server URL, health, model download instructions, and install commands.
- **Interacts with**: `modelStore.ts`, Tauri settings commands.

### SFX downloads
- **Does**: Shows Woosh checkpoint instructions, a resumable native AudioLDM checkpoint download command, and the AudioLDM Hugging Face fallback command.
- **Interacts with**: `sfx_server.py`, `inference/setup.sh`.
- **Rationale**: Woosh and AudioLDM share the SFX server but have different setup paths. Native AudioLDM setup is the production path and expects `audioldm-m-full.ckpt` in `~/pharaoh-models/sfx/audioldm`; the Hugging Face command is retained only for the explicit diffusers fallback engine.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `sfx_server.py` | Native AudioLDM is installed with `PHARAOH_INSTALL_AUDIOLDM=1`; native checkpoints land in `~/pharaoh-models/sfx/audioldm`; diffusers fallback may use the HF local directory | Changing setup guidance without updating server resolution |
| Users | Woosh remains the required short-foley setup | Hiding Woosh behind AudioLDM setup |

## Notes
- AudioLDM dependencies are installed separately with `PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh`; the native model command only places the `.ckpt` expected by the upstream CLI.
