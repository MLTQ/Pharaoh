# flush.ts

## Purpose

Carries the "commit your debounced writes now" signal from the Cmd-S handler to
every editor that batches disk I/O behind a timer.

## Components

### `FLUSH_EVENT`
- **Is**: the window event name, `"pharaoh:flush"`.
- **Listened for by**: `FountainEditor` (prose file) and `CompositionView`
  (pending per-row `script.csv` patches and the debounced Fountain row commit).

### `requestFlush()`
- **Does**: dispatches `FLUSH_EVENT` on `window`.
- **Called by**: the global Cmd-S handler in `App.tsx`.

## Rationale

Cmd-S previously dispatched a synthetic `beforeunload` because the debounced
writers already subscribed to it for the force-quit case. But `gruveCollab.ts`
also subscribes to `beforeunload` to call `session.leave()`, and a left session
sets `closed = true` and never reconnects — so one Cmd-S silently ended mesh
collaboration for the rest of the run. Separating "save now" from "the window is
going away" removes that coupling; writers subscribe to both, `gruveCollab` only
to the real one.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Debounced writers | Listening for `FLUSH_EVENT` flushes on Cmd-S | Renaming the event without updating listeners |
| `gruveCollab` | `FLUSH_EVENT` never means "the window is closing" | Reusing this event for teardown |

## Notes

Writers must keep their `beforeunload` listener as well — it is still the only
signal for a real window close or force-quit.
