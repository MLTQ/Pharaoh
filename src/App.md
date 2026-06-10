# App.tsx

## Purpose
Top-level React shell for Pharaoh's project workspace. It wires navigation, global server/job listeners, sidebars, the main canvas, right rail, and transport controls.

## Components

### `RAIL_WORKSPACES`
- **Does**: Defines the five top-level workspace modes shown as icons in the
  rail: Pyramid, Story, Scenes, Polish, App. Each is a `WorkspaceId` (not a
  `ViewId`) — the rail is a workspace switcher, not a flat page picker.
- **Interacts with**: `WorkspaceId` in `types.ts`, `useUiStore.setWorkspace`.

### `SCENE_SUBTABS`
- **Does**: When the Scenes workspace is active, a tab strip above the canvas
  lets the user flip between Compose / Voice / Sound / Score *within the same
  scene context*. Voice/SFX/Score are no longer top-level destinations —
  they're tools inside a scene.
- **Interacts with**: `useUiStore.setView`, `jobStore` for per-tab badges.

### Sidebar (workspace-contextual)
- **Does**: Renders different content per active workspace. Pyramid shows
  jump-links; Story shows Tier I + cast list; Scenes shows the scene list +
  cast; Polish lists post tools; App lists app config.
- **Rationale**: The old sidebar duplicated half of the rail and bolted on
  contextual content. Splitting by workspace eliminates the overlap and frees
  the rail to be a five-mode switcher instead of an 11-item flat list.

### `App`
- **Does**: Chooses launcher versus project workspace layout, initializes listeners, and renders the active page.
- **Interacts with**: project/job/model/playback/UI stores and page components.
- **Launcher behavior**: Before a project is open, the project picker and Settings use launcher-local panel state so persisted project-workspace views cannot force startup into Settings.

### Server health tracker
- **Does**: Shows TTS, SFX, music, and AudioSR/Post server status in the topbar.
- **Interacts with**: `modelStore.ts`.
- **Rationale**: AudioSR runs as the Post inference server, so it needs the same remote-health visibility as generation servers.

### Post-processing navigation
- **Does**: Adds Clip Studio and Audio Upscale pages to the rail, breadcrumbs, sidebar, and canvas.
- **Interacts with**: `ClipStudioView.tsx`, `UpscaleView.tsx`.
- **Rationale**: Clip editing and neural upscaling are separate post-production tasks, so each gets its own page.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `types.ts` | `ViewId` contains every page ID used here | Adding page IDs without updating the union |
| Stores | Listener initialization happens once per app mount | Re-running listeners repeatedly |
| Page components | Project-only pages are not rendered before a project is open | Removing the launcher guard |

## Notes
- The right rail remains global; post-processing pages can still inspect jobs/assets while open.
- Gruve multiplayer: a mount effect calls `initGruveCollab()` (lib/gruveCollab.ts) and, for mesh viewers, polls `reloadProjectFromDisk` every 10s. `MeshViewerBadge` marks non-Tauri sessions.
