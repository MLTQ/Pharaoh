# cli.rs

## Purpose
Headless command entrypoint for Pharaoh. It exposes a minimal but real agent-usable surface for project inspection, row generation, and scene rendering without requiring the Tauri GUI.

## Components

### `run`
- **Does**: Parses top-level CLI commands, loads shared app config, and dispatches to subcommands.
- **Interacts with**: `app_support.rs`, `audio_engine.rs`, `inference.rs`.

### `project_list`, `project_status`, `project_create`
- **Does**: Provides non-GUI project management and visibility commands.
- **Interacts with**: `Project` and `Storyboard` models in `models.rs`.

### `generate_row`, `generate_all`, `generate_script_row`
- **Does**: Reads `script.csv`, chooses the proper inference endpoint per row type, waits for completion, and binds outputs back into the script.
- **Interacts with**: `finalize_generation_output` in `commands/inference.rs`, path helpers in `app_support.rs`.
- **Rationale**: Keeps the first useful headless workflow small while still being end-to-end real.

### `compose_render_scene`
- **Does**: Renders a scene using the same Rust audio engine used by the GUI.
- **Interacts with**: `render_scene_with_projects_dir` in `commands/audio_engine.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `main.rs` | `run(args)` handles all CLI behavior and returns `Result<()>` | Signature or error semantics |
| Agents/scripts | JSON is emitted on stdout for successful commands | Switching to plain text output |
| `inference.rs` | Generation finalization writes sidecars and optional script bindings | Changing finalization payload semantics |

## Notes
- This is intentionally narrower than the architecture aspirational CLI. It covers the implemented generation and render path without inventing unfinished story/LLM stages.
