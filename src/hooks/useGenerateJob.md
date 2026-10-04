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
- **Music defaults**: `instrumental: true` (YuE2 suppresses vocals; ACE-Step ignores it). ACE-Step fields: 1.7B, 60 diffusion steps, batch size 1, thinking mode off unless the caller overrides them.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Generator panels | Returned `jobId` identifies a job already submitted to Rust | Return shape changes |
| `jobStore.ts` | Added jobs include scene slug and row index | Missing row metadata |
| Rust inference commands | Payloads match serde request models | Field mismatch |

## Notes
- Character Designer bypasses this hook for character-level probe jobs because those use synthetic character slugs rather than scene rows.
- `clonesVoice(char)`: a character with a gold reference and a Chatterbox pipeline speaks through `submit_chatterbox_clone`.
- `paletteEntryFor(char, note)`: a delivery note that names a palette emotion (exact key/label, word stems like "angrily", or synonyms like "furious") swaps that emotion's reference in for the gold clip. Used by the TTS panel's Direction field and the script editor's parentheticals.
- `dialogueEngine(char)`: `breeze` when the TTS server reports Breeze and the character has a gold clip; `chatterbox` for cloned voices without Breeze; `preset` otherwise. `production_pipeline` no longer routes (old "chatterbox+rvc" characters use Breeze too). A cloned character with `rvc.enabled` gets `voice_lock` on its job (character, RVC settings, text, direction) so [jobStore](../store/jobStore.md) can lock calm lines when the take lands. `breezeDirection(char, note)` builds Breeze's instruction: the note (unless it's just a palette emotion's name) plus that emotion's written direction; the palette emotion's clip becomes the reference.
- Jobs carry `audiosr` (the character's clean-up setting) and `project_id`; `jobStore` runs AudioSR on completion and binds the cleaned file to the row.
