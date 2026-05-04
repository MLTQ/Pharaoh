# CompositionView.tsx

## Purpose
Main composition workspace for one scene. It shows the script panel, derived timeline tracks, and render controls while syncing with `script.csv`.

## Components

### `handleUpdateRow`, `handleClipMove`
- **Does**: Persist script edits and timeline placement changes back to the backend.
- **Interacts with**: `updateScriptRow` in `tauriCommands.ts`.

### Script loading effect
- **Does**: Reads the active scene script and now refreshes again when completed jobs land for that scene.
- **Interacts with**: `jobStore.ts`, `readScript` in `tauriCommands.ts`.
- **Rationale**: Automatic backend take binding should show up in the open composition view without needing a manual refresh.

### `handleRender`
- **Does**: Calls the Rust render command and captures the resulting output path or error.
- **Interacts with**: `audio_engine.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Timeline UI | `scriptRows` reflects backend placement and file binding | Removing script refreshes |
| `audio_engine.rs` | Render returns a file path or throws | Return type changes |

## Notes
- Track derivation remains intentionally optimistic: rows without placement data stay off the timeline even if they have generated files.
