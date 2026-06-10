# gruveCollab.ts

## Purpose
Pharaoh-level multiplayer on top of the Gruve session room: everyone viewing
the app over the mesh shares project / scene / view / playback state (LWW per
key, any participant can drive). Cursors and whiteboard come free from the
lobby overlay; this module only syncs app state.

## Components

### `initGruveCollab`
- **Does**: Joins the room (once), wires zustand stores ↔ session keys.
  Store→room: subscribes to uiStore.view, projectStore.realProjectId /
  activeSceneNo, audioStore.playing. Room→store: validates values off the
  wire, applies through store setters.
- **Interacts with**: called from `App.tsx` mount effect.
- **Rationale**: loop-breaking is by idempotence (apply only when the value
  differs), not an applying-flag — the SDK echoes local writes back through
  subscribe, so every apply path must be a no-op for an already-applied value.

### `joinHostSession`
- **Does**: The Tauri host's session client — same hello/welcome/state
  protocol as gruve-sdk's joinSession but pointed at
  `ws://127.0.0.1:8088/gruve/session/pharaoh` explicitly.
- **Rationale**: the host's webview is not served through the agent, so the
  SDK would give it a local no-op room and the host couldn't see or drive its
  viewers. Quiet 15s reconnect; no agent running = standalone, harmless.

### `followProject`
- **Does**: When a peer opens a different project, loads it via
  openProject/listScenes/getProjectsDir and `loadRealProject`.

### Session keys
| key | value | meaning |
|-----|-------|---------|
| `project` | `{ id }` | open project (peers follow) |
| `scene` | `{ no }` | active scene number |
| `ui` | `{ view }` | active ViewId (validated against WORKSPACE_OF) |
| `playback` | `{ path \| null }` | listen-together; path must be inside projectsDir |

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | `initGruveCollab()` idempotent, safe with no agent running | throwing on missing agent |
| peers in room | key/value shapes above | renaming keys or value fields |

## Notes
- Data freshness for viewers is event-driven only at the navigation level;
  script edits by others currently need a scene re-entry to show up. A `rev`
  bump key + reloadProjectFromDisk is the obvious next step.
- Playback sync shares the path only (no position scrubbing) — keeps the
  protocol trivial and avoids fighting over a shared transport.
