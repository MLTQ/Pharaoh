# dissectStore.ts

## Purpose
Background tracker for running dissect imports. Owns the job-queue row for each import (`model: "dissect"`, id `dissect-<import_id>`) and keeps it current from the server's stage message and progress, whether or not the import modal is open.

## Components

### `track(importId, sourceName)`
- **Does**: Adds the queue row (once) and polls `dissectStatus` every 1.5 s until complete/failed. Idempotent per import. On completion: row → 100 % with the speaker count, and a toast with **Review →** (switches to the Library and sets `openRequest`). On failure: row → failed, error toast.
- **Rationale**: The modal used to own the poll loop, so closing it froze the job and nothing else knew the import existed.

### `cancel(importId)`, `retry(importId, sourceName?)`
- **Does**: Back the job-queue row's Cancel / Retry buttons and the modal's. Cancel calls `dissect_cancel` and lets the poll loop finalise the row as `cancelled`. Retry calls `dissect_retry` (same import, same options, current server) and re-tracks, reusing the existing row; it resolves `false` — row failed, toast shown — when the re-run couldn't start (e.g. the source file moved).

### `settle(importId)`, `forget(importId)`
- **Does**: `settle` re-reads an import and puts its row in its real state; `cancel` falls back to it when the cancel call errors (e.g. the import already failed). `forget` drops the row and tracking when an import is deleted.
- **Rationale**: Cancel used to set "cancelling…" and wait for the poll loop; when the loop wasn't running or the cancel errored, the row stayed "running" forever and the queue reported a phantom running job. Every poll tick also checks it is still wanted, so an in-flight poll can't overwrite a cancelled row.

### `trackRebuild(jobId, title)`, `rebuilds`
- **Does**: Follows a rebuild job (`dissect_rebuild_status`, 1 s): queue row "Rebuild project · title", progress from the backend's stage message, and on completion a toast whose "Open →" calls `openProjectById`.

### `resumeRunning()`
- **Does**: Called once at app start (`App.tsx`); re-tracks every import whose `import.json` says `running`, so the queue survives a restart. No-op for mesh viewers.

### `statuses`, `openRequest`, `requestOpen`
- **Does**: Latest status per tracked import (the modal's running stage follows it instead of polling itself); a one-shot "open this import" request that `LibraryView` consumes to open the modal at review.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `DissectView.tsx` | `track` after submit / when resuming a running import; `statuses[importId]` updates | Renaming or removing the status map |
| `DissectView.tsx` (toast) | `openRequest` set by the toast action (which switches to the Dissect tab), cleared with `requestOpen(null)` | Changing the handshake |
| `jobStore.ts` / `JobQueue.tsx` | Rows use `model: "dissect"`; `output_path` is the manifest | Model kind rename (CSS `.model.dissect`) |
