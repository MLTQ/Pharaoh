# SettingsView.tsx

## Purpose
Settings panel for inference server URLs, model download commands, and install guidance.

## Components

### Model cards
- **Does**: Render per-server URL, health, model download instructions, and install commands.
- **Interacts with**: `modelStore.ts`, Tauri settings commands.

### SFX downloads
- **Does**: Shows Woosh checkpoint instructions and the AudioLDM Hugging Face download command.
- **Interacts with**: `sfx_server.py`, `inference/setup.sh`.
- **Rationale**: Woosh and AudioLDM share the SFX server but have different setup paths. The Settings page needs to make both visible so users can prepare long soundscape generation without discovering missing files at runtime.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `sfx_server.py` | AudioLDM default local directory is `~/pharaoh-models/sfx/audioldm-s-full-v2` | Changing the Settings download path without updating server resolution |
| Users | Woosh remains the required short-foley setup | Hiding Woosh behind AudioLDM setup |

## Notes
- AudioLDM dependencies are installed separately with `PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh`; the model download command only places weights.
