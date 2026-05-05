# start_servers.sh

## Purpose
Starts Pharaoh's local inference servers with the expected isolated Python interpreters and model directory environment. It centralizes default runtime paths so headless agents and manual users start the same stack.

## Components

### Model directory exports
- **Does**: Sets default locations for TTS, music, Woosh, and native AudioLDM model assets.
- **Interacts with**: `tts_server.py`, `music_server.py`, `sfx_server.py`.
- **Rationale**: Native AudioLDM uses upstream `AUDIOLDM_CACHE_DIR`, so Pharaoh exports it to `~/pharaoh-models/sfx/audioldm` instead of letting the package fall back to `~/.cache/audioldm`.

### Interpreter checks
- **Does**: Verifies the TTS, music, and Woosh Python interpreters exist before launching servers.
- **Interacts with**: `setup.sh`, `PHARAOH_WOOSH_DIR`.

### Server launch
- **Does**: Starts TTS, SFX, and music servers in the background and waits for them.
- **Interacts with**: Ports 18001, 18002, and 18003.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `sfx_server.py` | `AUDIOLDM_CACHE_DIR` points at Pharaoh's AudioLDM model directory | Removing the export reverts native downloads to upstream cache defaults |
| Users | `./inference/start_servers.sh` starts all required servers from one terminal | Changing interpreter defaults without updating setup guidance |

## Notes
- `PHARAOH_AUDIOLDM_CACHE_DIR` overrides the native AudioLDM checkpoint directory. If unset, an existing `AUDIOLDM_CACHE_DIR` is respected; otherwise Pharaoh uses `~/pharaoh-models/sfx/audioldm`.
