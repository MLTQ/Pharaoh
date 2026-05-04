# CharacterDesignerView.tsx

## Purpose
Cast and voice-design workspace for creating characters, testing generated voices, and saving clone references. It owns character-level TTS probes that are separate from scene `script.csv` rows.

## Components

### `handleGenerateDesign`, `handleGenerateClone`
- **Does**: Submit voice design and clone test jobs, then add returned jobs to the frontend queue.
- **Interacts with**: `submitTtsVoiceDesign`, `submitTtsVoiceClone` in `tauriCommands.ts`, `jobStore.ts`.
- **Rationale**: Uses a synthetic `__char__{id}` scene slug so character takes do not collide with scene generation takes.

### `submitting`
- **Does**: Tracks the gap between button click and returned job id so the page shows work-in-progress even before normal job events arrive.
- **Interacts with**: `RunningBadge` in `TakeList.tsx`.

### `saveVoice`, `outputPath`
- **Does**: Persist selected voice assignment data and choose character asset output paths.
- **Interacts with**: `projectStore.ts`, project character folders.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `projectStore.ts` | Voice assignment updates persist into `project.json` | Changing assignment shape |
| `jobStore.ts` | Character takes use `scene_slug` + `row_index` keys | Key format changes |
| `inference.rs` | Clone requests include a bounded `max_new_tokens` value | Removing the cap from clone requests |

## Notes
- Clone generation can spend a long time inside Qwen before producing audio. The submitting state keeps the page from looking idle before the backend job id is available.
