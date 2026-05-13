# SettingsView.tsx

## Purpose
Settings panel for inference server URLs, model download commands, automated dependency setup, post-processing server setup, and install guidance.

## Components

### Model cards
- **Does**: Render per-server URL, health, model download instructions, automated setup buttons, and fallback install commands; URL edits update live config and persist to app config.
- **Interacts with**: `modelStore.ts`, Tauri settings commands, `setup_inference_servers` in `setup.rs`.

### Server setup buttons
- **Does**: Run `inference/setup.sh` profiles from the GUI for core TTS/Music dependencies, optional AudioLDM, and optional AudioSR; displays recent setup output as a compact live log.
- **Interacts with**: `inference_setup` Tauri events emitted by `setup.rs`.
- **Rationale**: Keeps model-server dependency installs agent/user operable from Settings while retaining copyable commands for remote hosts or manual troubleshooting.

### SFX downloads
- **Does**: Shows Woosh checkpoint instructions, a resumable native AudioLDM checkpoint download command, and the AudioLDM Hugging Face fallback command.
- **Interacts with**: `sfx_server.py`, `inference/setup.sh`.
- **Rationale**: Woosh and AudioLDM share the SFX server but have different setup paths. Native AudioLDM setup is the production path and expects `audioldm-m-full.ckpt` in `~/pharaoh-models/sfx/audioldm`; the Hugging Face command is retained only for the explicit diffusers fallback engine.

### AudioSR setup
- **Does**: Shows the Post server URL and optional AudioSR install command for neural upscaling.
- **Interacts with**: `UpscaleView.tsx`, `audio_enhance.rs`, `post_server.py`, `setup.sh`.
- **Rationale**: AudioSR must run on the inference host, not in the local desktop process.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `sfx_server.py` | Native AudioLDM is installed with `PHARAOH_INSTALL_AUDIOLDM=1`; native checkpoints land in `~/pharaoh-models/sfx/audioldm`; diffusers fallback may use the HF local directory | Changing setup guidance without updating server resolution |
| Users | Woosh remains the required short-foley setup | Hiding Woosh behind AudioLDM setup |
| `UpscaleView.tsx` | AudioSR setup command installs `inference/.venv-audiosr/bin/audiosr` and `post_url` points at the Post server | Showing a local-only CLI workflow |
| `setup.rs` | Settings passes Tauri camelCase args (`wooshDir`) and listens for `SetupProgress`-shaped events | Changing command arg names or event payload shape |

## Notes
- AudioLDM dependencies are installed separately with `PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh`; the native model command only places the `.ckpt` expected by the upstream CLI.
