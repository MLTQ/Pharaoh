# useGenerateJob.ts

## Purpose
Shared frontend hook for submitting scene-level TTS, SFX, and music jobs. It resolves the active project/scene context, builds output paths, and records jobs in the UI queue.

## Components

### `resolveContext`
- **Does**: Ensures a real project and active scene are available before submitting generation.
- **Interacts with**: `projectStore.ts`.

### `submitTts`
- **Does**: Submits production dialogue through Qwen CustomVoice, passing performance direction as `instruct`.
- **Interacts with**: `tauriCommands.ts`, `jobStore.ts`.
- **Rationale**: Scene dialogue needs direction control, which the Base/clone model path does not provide. Character Designer remains responsible for clone/design probe jobs.

### `submitSfx`, `submitMusic`
- **Does**: Submit SFX and music generation jobs with model-specific defaults while passing through caller-provided backend parameters.
- **Interacts with**: SFX and Music panels.
- **Rationale**: Woosh is preferred for short foley; AudioLDM is reserved for long effects and soundscapes that should not be stitched from many short chunks.
- **Woosh defaults**: Uses 4 Euler steps and CFG scale 4.5 unless the caller overrides them.
- **AudioLDM defaults**: Uses upstream's recommended `audioldm-m-full` native checkpoint and 200 steps for quality. Candidate count defaults to 1 because upstream AudioLDM's multi-candidate CLAP ranking assumes CUDA and crashes on Apple Silicon/CPU.
- **Music defaults**: Uses ACE-Step 1.7B, 60 diffusion steps, batch size 1, and thinking mode off unless the caller overrides them.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Generator panels | Returned `jobId` identifies a job already submitted to Rust | Return shape changes |
| `jobStore.ts` | Added jobs include scene slug and row index | Missing row metadata |
| Rust inference commands | Payloads match serde request models | Field mismatch |

## Notes
- Character Designer bypasses this hook for character-level probe jobs because those use synthetic character slugs rather than scene rows.
