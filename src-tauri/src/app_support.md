# app_support.rs

## Purpose
Shared filesystem and config helpers for both Tauri commands and the headless CLI. This file exists to keep project-root resolution, config loading, and `script.csv` mutation behavior consistent across entrypoints.

## Components

### `default_config_path`, `load_or_default_app_config`, `ensure_app_dirs`
- **Does**: Resolves the shared config file location, loads app config, and ensures configured directories exist.
- **Interacts with**: `AppConfig` in `models.rs`, startup in `lib.rs`, CLI boot in `cli.rs`.

### `state_projects_dir`, `app_projects_dir`
- **Does**: Reads the configured `projects_dir` from in-memory app state.
- **Interacts with**: `AppState` in `models.rs`, Tauri command modules in `commands/`.
- **Rationale**: Prevents command modules from reintroducing hardcoded `~/pharaoh-projects` paths.

### `project_dir`, `scene_dir`, `script_path`
- **Does**: Central path builders for project and scene resources.
- **Interacts with**: `project.rs`, `script.rs`, `audio_engine.rs`, `inference.rs`, `cli.rs`.

### `read_json`, `write_json`
- **Does**: Small JSON persistence helpers used by both GUI and CLI flows.
- **Interacts with**: `project.rs`, `cli.rs`.

### `read_script_rows`, `write_script_rows`, `update_script_row_fields`
- **Does**: Reads, writes, and updates `script.csv` rows atomically.
- **Interacts with**: `script.rs`, `cli.rs`.

### `bind_generated_asset`
- **Does**: Writes generated asset paths back into `script.csv` when a row has not already been assigned a competing take.
- **Interacts with**: `inference.rs`, `cli.rs`.
- **Rationale**: Keeps automatic take binding safe when multiple generations complete for the same row.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `commands/script.rs` | Script paths come from configured `projects_dir` | Reverting to hardcoded home paths |
| `commands/audio_engine.rs` | Render input scene resolves through `scene_dir` | Changing path semantics |
| `cli.rs` | Config and script helpers work without a Tauri window | Adding AppHandle-only dependencies |

## Notes
- `bind_generated_asset` intentionally refuses to overwrite a row that already points at a different file. Alternate-take selection remains an explicit user or agent action.
