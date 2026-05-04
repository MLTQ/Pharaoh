# jobStore.ts

## Purpose
Frontend store for generation jobs, active takes, and event listeners. It translates Tauri inference events into UI state used by the queue, asset browser, and script views.

## Components

### `takeKey`
- **Does**: Creates the stable per-row key for active take selection.
- **Interacts with**: `AssetBrowser.tsx`, `TakeList` consumers.

### `addJob`, `updateJob`, `removeJob`, `setActiveTake`, `setQaStatus`
- **Does**: Manage the in-memory job list and selected takes.
- **Interacts with**: generation panels and asset review UI.

### `initListeners`
- **Does**: Subscribes to Tauri `job-progress`, `job-complete`, and `job-failed` events.
- **Interacts with**: `commands/inference.rs`, `toastStore.ts`, `uiStore.ts`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AssetBrowser.tsx` | First completed take for a row is auto-selected | Changing active-take behavior |
| `CompositionView.tsx` | Completed jobs are visible in state quickly enough to trigger script refresh | Delayed or missing completion updates |
| `inference.rs` | Event payloads match these TypeScript interfaces | Payload drift |

## Notes
- The store does not write `script.csv` itself on completion; backend finalization owns that. The UI only mirrors the resulting state.
