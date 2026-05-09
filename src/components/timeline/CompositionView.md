# CompositionView.tsx

## Purpose
Main composition workspace for one scene. It shows the script panel, derived timeline tracks, and render controls while syncing with `script.csv`.

## Components

### `handleUpdateRow`, `handleClipMove`
- **Does**: Persist script edits and timeline placement changes back to the backend.
- **Interacts with**: `updateScriptRow` in `tauriCommands.ts`.

### Asset drag/drop placement
- **Does**: Accepts Pharaoh asset payloads from native drop or pointer-drop fallback, converts the release x-position into `start_ms`, and updates or appends `script.csv` rows.
- **Interacts with**: `writeScript`, `updateScriptRow`, `SCRIPT_ASSETS_CHANGED_EVENT` in `assetRouting.ts`.
- **Rationale**: Timeline clips must be durable script rows, not ephemeral UI-only objects.

### Script loading effect
- **Does**: Reads the active scene script and refreshes again when completed jobs land or asset assignment events fire.
- **Interacts with**: `jobStore.ts`, `readScript` in `tauriCommands.ts`.
- **Rationale**: Automatic backend take binding should show up in the open composition view without needing a manual refresh.

### `handleRender`
- **Does**: Calls the Rust render command and captures the resulting output path or error.
- **Interacts with**: `audio_engine.rs`.

### Scene strip playback
- **Does**: Adds play/stop controls to each scene chip; if a scene has no existing render metadata, it renders that scene before playback.
- **Interacts with**: `renderScene`, `readRenderMeta`, `audioStore.ts`, `renderMetaStore.ts`.
- **Rationale**: Scene preview needs to work from the scene navigator without forcing users through the render button first.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Timeline UI | `scriptRows` reflects backend placement and file binding | Removing script refreshes |
| `AssetBrowser.tsx` | Drag payload MIME is `application/x-pharaoh-asset`, with JSON/text/snapshot/pointer fallbacks | Changing payload format without updating both sides |
| `audio_engine.rs` | Render returns a file path or throws | Return type changes |
| Scene strip controls | `render.wav` lives under `{projectsDir}/{projectId}/scenes/{sceneSlug}/render.wav` | Moving render output |

## Notes
- Track derivation remains intentionally optimistic: rows without placement data stay off the timeline even if they have generated files.
- Dropping onto incompatible tracks, such as SFX onto a dialogue track, creates or reuses a compatible track instead of corrupting the target track type.
- Dialogue drops reuse existing character tracks by name. SFX and music drops onto empty timeline space create unique `SFX`, `SFX 2`, `MUSIC`, etc. tracks so overlapping layers are easy.
