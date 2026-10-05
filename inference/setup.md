# setup.sh

## Purpose
One-shot setup script for Pharaoh's local inference environment. It creates isolated TTS and music virtualenvs, checks the Woosh environment, and can install optional AudioLDM/AudioSR environments.

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
- **Does**: Checks for an existing Woosh checkout and virtualenv. Optionally creates `inference/.venv-audioldm` and installs the upstream AudioLDM runner when `PHARAOH_INSTALL_AUDIOLDM=1`.
- **Interacts with**: `PHARAOH_WOOSH_DIR`, `PHARAOH_AUDIOLDM_CACHE_DIR`, Woosh checkpoints, `requirements-sfx-audioldm.txt`.
- **Rationale**: Woosh remains the default high-quality short-foley backend. AudioLDM is isolated because the Woosh dependency stack makes the diffusers AudioLDM path unreliable.

### AudioSR env section
- **Does**: Optionally creates `inference/.venv-audiosr` and installs the AudioSR CLI used by `post_server.py` when `PHARAOH_INSTALL_AUDIOSR=1`.
- **Interacts with**: `post_server.py`, `audio_enhance.rs`, `UpscaleView.tsx`, `requirements-audiosr.txt`.
- **Rationale**: Neural upscaling is ML work and must stay on the inference host, but it needs its own dependency stack.

### Dissect env section
- **Does**: Runs automatically when Linux + an NVIDIA GPU are detected (`PHARAOH_INSTALL_DISSECT=auto`, the default; `0` skips, `1` forces). Checks ffmpeg/ffprobe and free disk; creates `.venv-dissect` (Python 3.12) with torch 2.8 cu128 and `requirements-dissect.txt` (NeMo from a pinned source commit); moves the MSST checkout to its pinned commit; downloads the BandIt Plus weights via `.part` files with a size sanity check; prefetches the three NeMo checkpoints (`dissect_pipeline.py --prefetch`, skip with `PHARAOH_DISSECT_PREFETCH=0`); then verifies with `dissect_pipeline.py --check`.
- **Interacts with**: `dissect_server.py`, `dissect_pipeline.py`, `PHARAOH_DISSECT_MODEL_DIR`.
- **Rationale**: Nemotron-3-Diarization needs NeMo newer than the 3.0.0 wheel, which in turn needs torch ≥ 2.7 — incompatible with the torch 2.6 pins in the other envs.

### Section arguments
- **Does**: `./inference/setup.sh <section…>` runs only the named sections (`core breeze moss yue2 rvc audioldm audiosr dissect applio`) and switches named optional ones on; no arguments runs everything as before. `--help` prints the header.
- **Rationale**: Installing one optional server used to re-sync every core env. Naming `dissect` still honours GPU auto-detection so it can't half-install CUDA wheels on a Mac.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `start_servers.sh` | `.venv-tts` and `.venv-music` exist after setup | Changing venv locations without updating startup |
| Users | Missing SoX is reported with install guidance | Removing the preflight warning |
| Woosh setup | SFX env remains managed by the Woosh repo | Creating a conflicting Pharaoh SFX env |
| AudioLDM setup | Optional deps install into `.venv-audioldm`; native checkpoints are reported under `~/pharaoh-models/sfx/audioldm` by default | Installing AudioLDM into the Woosh interpreter |
| AudioSR setup | Optional deps install into `.venv-audiosr` | Installing AudioSR into generation envs |

## Notes
- SoX is a system dependency, not a Python package. On macOS the expected install command is `brew install sox`.
- AudioSR 0.0.7 pulls older librosa code that imports `pkg_resources`, so the optional AudioSR requirements include `setuptools`. `urllib3<2` avoids noisy LibreSSL warnings on the macOS Python used by uv.
- `yue2` section (auto on Linux + NVIDIA, `PHARAOH_INSTALL_YUE2=0/1`): builds `.venv-yue2` (Python 3.12) from `requirements-yue2.txt` (yue2-infer pinned to a YuE commit; torch 2.10) and downloads `m-a-p/YuE2-3B` + `m-a-p/YuE2-Vae` (~7.3 GB) into the Hugging Face cache. `.venv-music` (ACE-Step) is still built by `core` for Macs and for repaint/cover.
- `breeze` section (auto on Linux + NVIDIA, `PHARAOH_INSTALL_BREEZE=0/1`): clones breeze-tts at a pinned commit into `PHARAOH_BREEZE_HOME`, builds `.venv-breeze` (Python 3.11), downloads the Breeze TTS 2 weights (non-commercial licence) and the Whisper take checker.
