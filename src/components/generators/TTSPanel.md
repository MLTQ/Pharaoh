# TTSPanel.tsx

## Purpose
Dialogue-generation panel for scene-level spoken lines. It collects a character, spoken line, and performance direction, then submits production dialogue through Qwen CustomVoice.

## Components

### `TTSPanel`
- **Does**: Renders speaker selection, line/direction editors, generation controls, and current plus persisted take review for the selected scene.
- **Interacts with**: `useGenerateJob.ts`, `jobStore.ts`, `projectStore.ts`.

### `line` / `direction`
- **Does**: Keeps spoken text separate from delivery instruction.
- **Interacts with**: `submitTts` in `useGenerateJob.ts`.
- **Rationale**: CustomVoice supports `instruct`; Base/clone dialogue generation does not. Direction must not be mixed into the words being spoken.

### `handleGenerate`
- **Does**: Syncs the selected scene, then sends `line` as TTS text and `direction` as CustomVoice `instruct` text.
- **Interacts with**: `submit_tts_custom_voice` through `tauriCommands.ts`.

### Generation controls
- **Does**: Exposes seed, temperature, top-p, and max-token cap for Qwen CustomVoice.
- **Interacts with**: `useGenerateJob.ts`, `tts_server.py`.

### Take history
- **Does**: Shows current-session TTS jobs and persisted Qwen TTS sidecars for the selected scene, and lets completed takes be selected for scene routing.
- **Interacts with**: `jobStore.ts`, `listGeneratedAudioAssets`, `getWaveformPeaks`.

### `handleSendToScene`
- **Does**: Writes the selected completed take into the first empty dialogue row of the target scene's `script.csv`, replacing the first dialogue row only if no empty row exists.
- **Interacts with**: `routeAudioToScene` in `assetRouting.ts`, `projectStore.ts`.
- **Rationale**: Old dialogue assets need the same explicit promotion path as freshly generated takes, without depending on transient job state.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `useGenerateJob.ts` | Dialogue submissions use CustomVoice speaker and instruction | Routing through clone/base |
| Users | Direction text is not spoken literally | Concatenating direction into line text |
| `jobStore.ts` | Generated takes are keyed to the active scene and row 0 | Changing row metadata |
| `sidecar.rs` | Persisted Qwen TTS assets can be listed after app restart | Filtering only transient jobs |
| Users | Completed current-session and persisted takes can be selected and routed to a scene | Making the take list review-only |

## Notes
- Character Designer still owns voice clone and voice design probes. This panel is for production dialogue takes that need direction control.
- “Send to scene” targets dialogue rows in the selected scene; scenes with no assignable dialogue rows report an error instead of silently dropping the assignment.
