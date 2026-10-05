# jobStore.ts

## Purpose
Frontend store for generation and Post-server jobs, active takes, and event listeners. It translates Tauri inference/post events into UI state used by the queue, asset browser, and script views.

## Components

### `takeKey`
- **Does**: Creates the stable per-row key for active take selection.
- **Interacts with**: `AssetBrowser.tsx`, `TakeList` consumers.

### `addJob`, `updateJob`, `removeJob`, `setActiveTake`, `setQaStatus`
- **Does**: Manage the in-memory job list and selected takes.
- **Interacts with**: generation panels and asset review UI.

### `initListeners`
- **Does**: Subscribes to Tauri `job-progress`, `job-complete`, and `job-failed` events.
- **Interacts with**: `commands/inference.rs`, `commands/audio_enhance.rs`, `toastStore.ts`, `uiStore.ts`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AssetBrowser.tsx` | First completed take for a row is auto-selected | Changing active-take behavior |
| `CompositionView.tsx` | Completed jobs are visible in state quickly enough to trigger script refresh | Delayed or missing completion updates |
| `inference.rs` | Event payloads match these TypeScript interfaces | Payload drift |
| `audio_enhance.rs` | AudioSR progress events can update caller-created `post` jobs without auto-selecting a script take | Changing event id/model |

## Notes
- The store does not write `script.csv` itself on completion; backend finalization owns that. The UI only mirrors the resulting state.

## Dissect jobs
Rows with `model: "dissect"` are added and updated by [dissectStore](./dissectStore.md), not by Tauri job events — dissect progress is polled from the import, not pushed.

## Clearing
`clearFinished()` drops every complete / failed / cancelled row (the queue's **Clear N** button); `removeJob` backs each finished row's ×. Only the list changes — nothing on disk is touched.
- Voice lock: a completed take whose job has `voice_lock` calls `submit_voice_lock` first. When the line qualifies (lock on; calm lines only unless set to every line), an RVC job is added as a `post` row with `cleans_row` and the take's `audiosr` flag; its completion (model `rvc`) binds `<take>.lock.wav` to the row and then runs AudioSR if asked. When it doesn't qualify, AudioSR runs on the raw take as before. RVC completions never auto-select a take (their events carry no scene).
- AudioSR clean-up: a completed take whose job has `audiosr` starts an AudioSR (speech) job with `cleans_row`; when that completes, `update_script_row` binds the cleaned file in place of the raw take.
- Grouping: follow-ups carry `parent_id` (the line's first job) and `stage`; the first job's `followups` lists stages still expected and drops each when it starts or is skipped. [jobGroups](../lib/jobGroups.ts) turns that into one queue row per line; `clearFinished` and `removeJob` act on whole groups.
- Auto layout: after any job ends, `scheduleLayoutCheck` runs layouts armed by [sceneLayout](../lib/sceneLayout.ts) once their scene has no running jobs.
