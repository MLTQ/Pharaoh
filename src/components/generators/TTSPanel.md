# TTSPanel.tsx

## Purpose
Dialogue-generation panel for scene-level spoken lines. It collects a character, spoken line, and performance direction, then submits production dialogue through Qwen CustomVoice.

## Components

### `TTSPanel`
- **Does**: Renders speaker selection, line and direction editors, generation controls, and take review.
- **Interacts with**: `useGenerateJob.ts`, `jobStore.ts`, `projectStore.ts`.

### `line` / `direction`
- **Does**: Keeps spoken text separate from delivery instruction.
- **Interacts with**: `submitTts` in `useGenerateJob.ts`.
- **Rationale**: CustomVoice supports `instruct`; Base/clone dialogue generation does not. Direction must not be mixed into the words being spoken.

### `handleGenerate`
- **Does**: Sends `line` as TTS text and `direction` as CustomVoice `instruct` text.
- **Interacts with**: `submit_tts_custom_voice` through `tauriCommands.ts`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `useGenerateJob.ts` | Dialogue submissions use CustomVoice speaker and instruction | Routing through clone/base |
| Users | Direction text is not spoken literally | Concatenating direction into line text |
| `jobStore.ts` | Generated takes are keyed to the active scene and row 0 | Changing row metadata |

## Notes
- Character Designer still owns voice clone and voice design probes. This panel is for production dialogue takes that need direction control.
