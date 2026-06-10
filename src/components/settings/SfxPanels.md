# SfxPanels.tsx

## Purpose
SFX-specific download and install guidance: the Woosh checkpoint breakdown, AudioLDM checkpoint commands, and the hardware-aware Woosh `uv sync` install helper. Extracted from `SettingsView.tsx`.

## Components

### `SfxDownloads`
- **Does**: Shows Woosh checkpoint instructions (via private `WooshCheckpoints`), a resumable native AudioLDM checkpoint download command, and the AudioLDM Hugging Face fallback command.
- **Interacts with**: `sfx_server.py`, `inference/setup.sh`; rendered by `ModelServerCards.tsx` in the SFX card's downloads section.
- **Rationale**: Woosh and AudioLDM share the SFX server but have different setup paths. Native AudioLDM expects `audioldm-m-full.ckpt` in `~/pharaoh-models/sfx/audioldm`; the HF command is retained only for the explicit diffusers fallback engine.

### `WooshInstall`
- **Does**: Shows the detected GPU backend's `git clone && uv sync` command with a toggle for the other hardware variants.
- **Interacts with**: `HardwareProfile` from `settingsShared.tsx`.

### `WOOSH_CHECKPOINTS` (private)
- **Does**: Per-checkpoint name/size/role/description table driving the required/recommended/optional/skip breakdown.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ModelServerCards.tsx` | `SfxDownloads` (no props), `WooshInstall({ hw })` | Prop changes |
| `sfx_server.py` | Guidance matches server checkpoint resolution paths | Changing download targets without updating the server |

## Notes
- AudioLDM deps install separately with `PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh`; the native model command only places the `.ckpt` expected by the upstream CLI.
