# sfx_server.py

## Purpose
FastAPI server for Pharaoh SFX generation on port 18002. It keeps Woosh as the default short-foley backend and adds optional AudioLDM v1 generation for long effects and ambience beds.

## Components

### Woosh backend
- **Does**: Loads Sony Woosh checkpoints from `PHARAOH_WOOSH_DIR` and generates high-quality short SFX.
- **Interacts with**: Woosh `.venv`, Woosh checkpoints, `/generate/t2a`.
- **Rationale**: Woosh remains the preferred backend for tight one-shots and foley, where quality is more important than long duration.

### T2A parameters
- **Does**: Accepts prompt, duration, model variant, backend, steps, seed, Woosh `cfg_scale`, AudioLDM guidance, AudioLDM negative prompt, and AudioLDM candidate count.
- **Interacts with**: `SFXPanel.tsx`, Rust `SfxT2ARequest`.

### AudioLDM backend
- **Does**: Runs the upstream `audioldm` CLI from `inference/.venv-audioldm` when a request uses `backend="audioldm"` or an AudioLDM model variant, then copies the generated WAV to Pharaoh's requested output path.
- **Interacts with**: `requirements-sfx-audioldm.txt`, `PHARAOH_AUDIOLDM_PYTHON`, `PHARAOH_AUDIOLDM_CACHE_DIR`, `/generate/t2a`.
- **Rationale**: The diffusers AudioLDM pipeline is deprecated and produced unusable diffusion artifacts inside the Woosh dependency stack. The native runner matches the upstream examples more closely, defaults to upstream's recommended `audioldm-m-full`, and keeps AudioLDM isolated from Woosh.

### AudioLDM prompt normalization
- **Does**: Converts Pharaoh's bracketed director markup into concise prose and sanitizes it for the upstream CLI.
- **Interacts with**: `SFXPanel.tsx`, script rows, headless CLI SFX generation.
- **Rationale**: AudioLDM quality drops when fed long screenplay-style directions. The upstream examples are short natural-language audio captions, and the CLI also uses prompt text as a filename, so Pharaoh caps and sanitizes the text before invoking it.

### Health and lifecycle
- **Does**: Reports Woosh and AudioLDM readiness independently, and lets `/load` preload AudioLDM when `variant` starts with `AudioLDM`.
- **Interacts with**: Model manager and server health polling.

### Native subprocess progress
- **Does**: Streams native AudioLDM stdout/stderr into server logs and maps upstream download, DDIM sampling, and save progress lines into Pharaoh job progress.
- **Interacts with**: Job polling UI and terminal logs.
- **Rationale**: The upstream CLI writes checkpoint download bars to stderr and sampler bars with carriage returns. A blind heartbeat made first-run model downloads look like stuck 92% inference, so Pharaoh derives progress from AudioLDM's own output instead.

### Native CUDA candidate guard
- **Does**: Detects whether the isolated AudioLDM torch build has CUDA. If not, native requests are forced to `-n 1`.
- **Interacts with**: Upstream AudioLDM CLI.
- **Rationale**: Upstream AudioLDM candidate ranking uses CLAP and unconditionally calls `waveform.cuda()`. Multi-candidate generation crashes after DDIM on Apple Silicon/CPU builds.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `submit_sfx_t2a` | `/generate/t2a` accepts existing Woosh payloads | Making `backend` required without a default |
| `SFXPanel.tsx` | Woosh/AudioLDM parameters map directly to request fields | Renaming request fields without updating controls |
| Sidecar finalizer | Server writes a WAV to `output_path` | Returning non-WAV or remote-only outputs |

## Notes
- AudioLDM dependencies are optional so basic Woosh SFX setup stays unchanged.
- Native AudioLDM defaults to `PHARAOH_AUDIOLDM_NATIVE_MODEL=audioldm-m-full`. The previous `audioldm-s-full-v2` default was a mismatch with upstream CLI defaults and produced poor results.
- On first use, native AudioLDM downloads checkpoints into `PHARAOH_AUDIOLDM_CACHE_DIR` / `AUDIOLDM_CACHE_DIR`, defaulting to `~/pharaoh-models/sfx/audioldm`. A stderr line such as `8% |#####|` is the upstream checkpoint download progress bar, not an inference error.
- `PHARAOH_AUDIOLDM_ENGINE=diffusers` keeps the old diffusers path available for debugging only; native is the production default.
- AudioLDM defaults use 200 diffusion steps. Candidate count defaults to 1 for cross-platform reliability; CUDA users may request more candidates explicitly.
- Long AudioLDM generations can be slow and memory-heavy. Agents should prefer Woosh for short, isolated foley and AudioLDM for beds/soundscapes.
