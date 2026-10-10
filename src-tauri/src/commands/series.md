# series.rs

## Purpose
Tauri commands for series (show bibles). A series is a cast, world and house style shared by its episodes. Stored at `<projects_dir>/_series/<id>/series.json`; the `_` prefix keeps it out of `list_projects` like `_library`.

## Components

### `list_series`, `get_series`, `create_series`, `update_series`
- **Does**: CRUD on `series.json`. `update_series` refuses ids that don't exist and keeps `created_at`.
- **Interacts with**: `Series` / `CastMember` in `models.rs`, `SeriesHomeView.tsx`, `SeriesColumn.tsx`.

### `list_series_episodes`, `create_series_episode` (core: `create_episode_at`)
- **Does**: An episode is an ordinary project with `series_id` set, created through `project::create_project_at`. It takes the series tone and episode length, and every cast member with a `library_id` is imported via `character::import_into_project` under their series name. An untitled episode is named "Episode N".
- **Rationale**: Episodes open in the unchanged one-shot workspace, so nothing downstream needs to know series exist. Copying voices from the library (rather than referencing them) matches how library import already works and keeps every episode self-contained.

### `check_id`
- **Does**: Series ids become directory names and mesh viewers can send them, so anything but `[A-Za-z0-9-]` is refused.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `tauriCommands.ts` | Series JSON matches `Series` in `types.ts` | Shape changes |
| `share.rs` | Reads mirrored; `update_series` collab-gated; create commands host-only | Exposing creation to mesh |
| `project.rs` | `create_project_at(dir, title, logline, tone, series_id)` | Signature changes |
