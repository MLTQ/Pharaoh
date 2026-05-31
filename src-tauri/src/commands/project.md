# project.rs

## Purpose
Tauri commands for project and scene CRUD. This file owns persistence of `project.json` and `storyboard.json` under the configured projects root.

## Components

### `get_projects_dir`
- **Does**: Returns the active projects root for the frontend.
- **Interacts with**: `app_support.rs`, project launch UI.

### `create_project`, `open_project`, `get_project`, `list_projects`, `update_project`
- **Does**: Manage top-level project records and metadata.
- **Interacts with**: `Project` in `models.rs`, `projectStore.ts`.

### `migrate_project_in_place`
- **Does**: Brings each character up to `CURRENT_CHARACTER_SCHEMA` and refreshes transient RVC corpus stats from disk. Runs on every read path (`get_project`, `open_project`, `list_projects`) and before every write (`update_project`).
- **Interacts with**: `VoiceAssignment::consolidate_legacy_rvc` (lifts legacy flat `rvc_*` fields into nested `RvcConfig`), `app_support::scan_rvc_corpus_dir`, `app_support::character_dir`.
- **Rationale**: Idempotent so the UI always sees a consistent shape regardless of when the file was last written. The frontend never has to handle migration itself.

### `create_scene`, `update_scene`, `get_scene`, `list_scenes`
- **Does**: Manage `storyboard.json` scene entries and scene folder scaffolding.
- **Interacts with**: `Scene` and `Storyboard` in `models.rs`, `script.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `projectStore.ts` | Returned JSON matches frontend `Project` and `Scene` types | Shape changes |
| `cli.rs` | On-disk layout remains `project.json` + `storyboard.json` + `scenes/` | Layout changes |
| `app_support.rs` | Commands always resolve through configured `projects_dir` | Reintroducing home-dir hardcoding |

## Notes
- Scene creation seeds an empty `script.csv` so generation and composition can start immediately.
