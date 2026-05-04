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
- **Interacts with**: `requirements-sfx-audioldm.txt`, `~/pharaoh-models/sfx/audioldm-s-full-v2`, Hugging Face cache, `/generate/t2a`.
- **Rationale**: AudioLDM v1 is the practical long-form ambience option. It supports `audio_length_in_s` and the upstream demo explicitly includes long samples, unlike AudioLDM2's own TODO for >10s generation.

### AudioLDM prompt normalization
- **Does**: Converts Pharaoh's bracketed director markup into concise prose, prefixes it as a realistic field recording, and asks for no speech/music.
- **Interacts with**: `SFXPanel.tsx`, script rows, headless CLI SFX generation.
- **Rationale**: AudioLDM quality drops when fed long screenplay-style directions. The upstream examples are short natural-language audio captions.

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
- `AudioLDM-S-Full-V2` resolves to `PHARAOH_AUDIOLDM_MODEL`, otherwise `PHARAOH_AUDIOLDM_MODEL_DIR`, otherwise the Hugging Face model id.
- AudioLDM defaults intentionally match the upstream CLI more closely: 200 diffusion steps and 3 candidates per prompt. This is slower but materially better than the earlier fast 50-step/1-candidate setting.
- Long AudioLDM generations can be slow and memory-heavy. Agents should prefer Woosh for short, isolated foley and AudioLDM for beds/soundscapes.
