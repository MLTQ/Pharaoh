# dissectStore.ts

## Purpose
Background tracker for running dissect imports. Owns the job-queue row for each import (`model: "dissect"`, id `dissect-<import_id>`) and keeps it current from the server's stage message and progress, whether or not the import modal is open.

## Components

### `track(importId, sourceName)`
- **Does**: Adds the queue row (once) and polls `dissectStatus` every 1.5 s until complete/failed. Idempotent per import. On completion: row → 100 % with the speaker count, and a toast with **Review →** (switches to the Library and sets `openRequest`). On failure: row → failed, error toast.
- **Rationale**: The modal used to own the poll loop, so closing it froze the job and nothing else knew the import existed.

### `resumeRunning()`
- **Does**: Called once at app start (`App.tsx`); re-tracks every import whose `import.json` says `running`, so the queue survives a restart. No-op for mesh viewers.

### `statuses`, `openRequest`, `requestOpen`
- **Does**: Latest status per tracked import (the modal's running stage follows it instead of polling itself); a one-shot "open this import" request that `LibraryView` consumes to open the modal at review.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `DissectImportModal.tsx` | `track` after submit / when resuming a running import; `statuses[importId]` updates | Renaming or removing the status map |
| `LibraryView.tsx` | `openRequest` set by the toast action, cleared with `requestOpen(null)` | Changing the handshake |
| `jobStore.ts` / `JobQueue.tsx` | Rows use `model: "dissect"`; `output_path` is the manifest | Model kind rename (CSS `.model.dissect`) |
