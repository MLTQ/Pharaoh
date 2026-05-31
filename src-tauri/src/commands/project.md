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

### `migrate_project_in_place` + `relativize_for_write`
- **Does**: `migrate_project_in_place` runs on every read path (`get_project`, `open_project`, `list_projects`): lifts legacy flat `rvc_*` fields into nested `RvcConfig`, absolutizes in-bundle voice paths so the UI sees absolute paths, refreshes transient corpus stats, stamps `schema_version = CURRENT_CHARACTER_SCHEMA`. `relativize_for_write` runs on the write side in `update_project`: walks each character's `voice_assignment` and rewrites in-bundle paths to relative so on-disk `project.json` stays portable.
- **Interacts with**: `VoiceAssignment::consolidate_legacy_rvc`, `app_support::absolutize_voice_paths`, `app_support::relativize_voice_paths`, `app_support::scan_rvc_corpus_dir`, `app_support::character_dir`.
- **Rationale**: Pharaoh-1qp introduced the on-disk relative-path convention; these two functions are the seam. The UI never sees a relative path; on-disk `project.json` never has an absolute path inside a bundle (external Clip Studio refs stay absolute). Migration is idempotent in both directions.

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
