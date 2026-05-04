# setup.sh

## Purpose
One-shot setup script for Pharaoh's local inference environment. It creates isolated TTS and music virtualenvs, checks the Woosh environment, and reports missing local tools needed by model dependencies.

## Components

### `Checking uv`
- **Does**: Verifies `uv` is available before creating or syncing Python environments.
- **Interacts with**: `.venv-tts`, `.venv-music`, `requirements-tts.txt`, `requirements-music.txt`.

### `Checking audio tools`
- **Does**: Warns when SoX is missing.
- **Interacts with**: Qwen3-TTS voice-clone preprocessing paths.
- **Rationale**: Qwen dependencies emit a runtime SoX warning during clone generation; surfacing it during setup makes the fix obvious.

### TTS and Music env sections
- **Does**: Create and sync separate Python 3.11 virtualenvs for incompatible TTS and ACE-Step dependency pins.
- **Interacts with**: `start_servers.sh`.

### SFX env section
- **Does**: Checks for an existing Woosh checkout and virtualenv.
- **Interacts with**: `PHARAOH_WOOSH_DIR`, Woosh checkpoints.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `start_servers.sh` | `.venv-tts` and `.venv-music` exist after setup | Changing venv locations without updating startup |
| Users | Missing SoX is reported with install guidance | Removing the preflight warning |
| Woosh setup | SFX env remains managed by the Woosh repo | Creating a conflicting Pharaoh SFX env |

## Notes
- SoX is a system dependency, not a Python package. On macOS the expected install command is `brew install sox`.
