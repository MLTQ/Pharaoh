# RvcModelStage.tsx

## Purpose
Stage 4 of the optional voice lock: train an RVC model on the character's corpus and decide how production takes use it.

## Components

### `RvcModelStage`
- **Does**: Starts training (`submitRvcTrain`), polls the job, then `finishRvcTrain` copies the model into the bundle's `rvc/` and the lock is switched on. Shows the model, the voice-lock toggle, the calm/every-line choice and the pitch / index rate / protect sliders.
- **Interacts with**: `tauriCommands` (`submitRvcTrain`, `getRvcJob`, `finishRvcTrain`, `getRvcModelInfo`), [rvc.rs](../../../src-tauri/src/commands/rvc.md).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView.tsx` | Every settings change arrives as a whole `RvcConfig` through `onRvcChange` | Partial updates, or writing to disk directly |

## Notes
- Defaults follow the blind test: index rate 0.5, calm lines only.
- Keep the panel open until training finishes: the model is fetched into the bundle when the poll sees completion.
