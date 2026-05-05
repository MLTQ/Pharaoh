# App.tsx

## Purpose
Top-level React shell for Pharaoh's project workspace. It wires navigation, global server/job listeners, sidebars, the main canvas, right rail, and transport controls.

## Components

### `RAIL_ITEMS`
- **Does**: Defines the primary workspace pages shown in the icon rail.
- **Interacts with**: `ViewId` in `types.ts`, `useUiStore`.

### `App`
- **Does**: Chooses launcher versus project workspace layout, initializes listeners, and renders the active page.
- **Interacts with**: project/job/model/playback/UI stores and page components.

### Post-processing navigation
- **Does**: Adds the Audio Upscale page to the rail, breadcrumbs, sidebar, and canvas.
- **Interacts with**: `UpscaleView.tsx`.
- **Rationale**: Upscaling is a project-wide post-production task rather than a scene generator, so it gets its own page.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `types.ts` | `ViewId` contains every page ID used here | Adding page IDs without updating the union |
| Stores | Listener initialization happens once per app mount | Re-running listeners repeatedly |
| Page components | Project-only pages are not rendered before a project is open | Removing the launcher guard |

## Notes
- The right rail remains global; post-processing pages can still inspect jobs/assets while open.
