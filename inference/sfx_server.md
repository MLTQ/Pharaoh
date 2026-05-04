# sfx_server.py

## Purpose
FastAPI server for Pharaoh SFX generation on port 18002. It keeps Woosh as the default short-foley backend and adds optional AudioLDM v1 generation for long effects and ambience beds.

## Components

### Woosh backend
- **Does**: Loads Sony Woosh checkpoints from `PHARAOH_WOOSH_DIR` and generates high-quality short SFX.
- **Interacts with**: Woosh `.venv`, Woosh checkpoints, `/generate/t2a`.
- **Rationale**: Woosh remains the preferred backend for tight one-shots and foley, where quality is more important than long duration.

### AudioLDM backend
- **Does**: Loads `diffusers.AudioLDMPipeline` when a request uses `backend="audioldm"` or an AudioLDM model variant, then generates WAVs at 16 kHz for requested durations.
- **Interacts with**: `requirements-sfx-audioldm.txt`, Hugging Face cache, `/generate/t2a`.
- **Rationale**: AudioLDM v1 is the practical long-form ambience option. It supports `audio_length_in_s` and the upstream demo explicitly includes long samples, unlike AudioLDM2's own TODO for >10s generation.

### Health and lifecycle
- **Does**: Reports Woosh and AudioLDM readiness independently, and lets `/load` preload AudioLDM when `variant` starts with `AudioLDM`.
- **Interacts with**: Model manager and server health polling.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `submit_sfx_t2a` | `/generate/t2a` accepts existing Woosh payloads | Making `backend` required without a default |
| `SFXPanel.tsx` | AudioLDM can be selected through request fields, not a new server URL | Splitting into a new model kind without UI migration |
| Sidecar finalizer | Server writes a WAV to `output_path` | Returning non-WAV or remote-only outputs |

## Notes
- AudioLDM dependencies are optional so basic Woosh SFX setup stays unchanged.
- Long AudioLDM generations can be slow and memory-heavy. Agents should prefer Woosh for short, isolated foley and AudioLDM for beds/soundscapes.
