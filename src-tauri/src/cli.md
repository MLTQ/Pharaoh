# cli.rs

## Purpose
Headless command entrypoint for Pharaoh. It exposes a minimal but real agent-usable surface for project inspection, row generation, scene rendering, and post-processing without requiring the Tauri GUI.

## Components

### `run`
- **Does**: Parses top-level CLI commands, loads shared app config, and dispatches to subcommands.
- **Interacts with**: `app_support.rs`, `audio_engine.rs`, `audio_enhance.rs`, `inference.rs`.

### `project_list`, `project_status`, `project_create`
- **Does**: Provides non-GUI project management and visibility commands.
- **Interacts with**: `Project` and `Storyboard` models in `models.rs`.

### `generate_row`, `generate_all`, `generate_script_row`
- **Does**: Reads `script.csv`, chooses the proper inference endpoint per row type, waits for completion, and binds outputs back into the script.
- **Interacts with**: `finalize_generation_output` in `commands/inference.rs`, path helpers in `app_support.rs`.
- **Rationale**: Keeps the first useful headless workflow small while still being end-to-end real.

### `generate_sfx`
- **Does**: Generates `SFX` rows with Woosh by default and `BED` or >5-second rows with AudioLDM.
- **Interacts with**: `SfxT2ARequest`, SFX server `/generate/t2a`.
- **Rationale**: Headless agents should not have to stitch many short Woosh chunks for rain, wind, traffic, or room-tone beds.
- **AudioLDM defaults**: Uses upstream's recommended `audioldm-m-full` checkpoint, 200 diffusion steps, and one candidate for cross-platform reliability. Upstream multi-candidate ranking requires CUDA.

### `generate_dialogue`
- **Does**: Builds CustomVoice TTS requests from script row `prompt` text, row `instruct` direction, and project character voice assignments.
- **Interacts with**: `TtsCustomVoiceRequest` in `models.rs`.
- **Rationale**: Production dialogue needs explicit delivery direction. Clone/design assignments remain useful for character design probes, but headless dialogue generation always sends `instruct` to CustomVoice.

### `compose_render_scene`
- **Does**: Renders a scene using the same Rust audio engine used by the GUI.
- **Interacts with**: `render_scene_with_projects_dir` in `commands/audio_engine.rs`.

### `post_upscale`
- **Does**: Runs AudioSR upscaling on a generated WAV and prints the new output path as JSON.
- **Interacts with**: `upscale_audio_asset_path` in `commands/audio_enhance.rs`.
- **Rationale**: Agents need the same post-production upscaling path as the GUI.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `main.rs` | `run(args)` handles all CLI behavior and returns `Result<()>` | Signature or error semantics |
| Agents/scripts | JSON is emitted on stdout for successful commands | Switching to plain text output |
| `inference.rs` | Generation finalization writes sidecars and optional script bindings | Changing finalization payload semantics |
| `audio_enhance.rs` | CLI upscaling can run without `AppHandle` | Making helper GUI-only |

## Notes
- This is intentionally narrower than the architecture aspirational CLI. It covers the implemented generation and render path without inventing unfinished story/LLM stages.
