# cli.rs

## Purpose
Headless command entrypoint for Pharaoh. It exposes the GUI workflows as JSON-emitting commands so agents can manage projects, author scenes/scripts, create characters, run generation, review assets, process clips, and inspect setup/server state without requiring the Tauri GUI.

## Components

### `run`
- **Does**: Parses top-level CLI commands, loads shared app config, and dispatches to subcommands.
- **Interacts with**: `app_support.rs`, `audio_engine.rs`, `audio_enhance.rs`, `inference.rs`, `sidecar.rs`.

### Project And Scene Commands
- **Does**: Provides non-GUI project creation/update/status plus storyboard scene list/get/create/update.
- **Interacts with**: `Project` and `Storyboard` models in `models.rs`.
- **Commands**: `project list`, `project status`, `project create`, `project update`, `scene list`, `scene get`, `scene create`, `scene update`.

### Script Commands
- **Does**: Reads, writes, and patches scene `script.csv` rows; persists and compiles per-scene `script.fountain` prose used by the GUI editor.
- **Interacts with**: `read_script_rows`, `write_script_rows`, `update_script_row_fields` in `app_support.rs`, `parse_document` / `blocks_to_rows` in `fountain.rs`.
- **Commands**: `script read`, `script write`, `script fountain-read`, `script fountain-write`, `script update-row`.

### Character Commands
- **Does**: Manages project characters and voice assignments, including headless voice design/clone probe generation.
- **Interacts with**: `Character`, `VoiceAssignment`, TTS request models, and the configured TTS server.
- **Commands**: `character list`, `character create`, `character update`, `character delete`, `character voice-set`, `character voice-design-test`, `character voice-clone-test`.

### Server And Setup Commands
- **Does**: Reports inference server health, reads/updates configured endpoint paths, triggers model load/unload endpoints, summarizes local setup paths, and exposes hardware detection used by Settings.
- **Interacts with**: App config, `/health`, `/load`, `/unload` endpoints, `detect_hardware` in `inference.rs`.
- **Commands**: `server health`, `server config`, `server config-set`, `model load`, `model unload`, `setup status`, `setup hardware`.

### LLM Authoring Commands
- **Does**: Runs the GUI's Anthropic-backed scene draft/revision pass from on-disk project and scene context, optionally persisting and compiling the result.
- **Interacts with**: `draft_scene_impl` and `storyboard_review_impl` in `llm.rs`, Fountain helpers in `fountain.rs`.
- **Commands**: `llm draft-scene`, `storyboard review`, `storyboard rewrite`.
- **Rationale**: Agents need the same first-draft and continuity-review loops as GUI users, but with explicit write/compile controls.

### Scene Row Generation
- **Does**: Reads `script.csv`, chooses the proper inference endpoint per row type, waits for completion, and binds outputs back into the script.
- **Interacts with**: `finalize_generation_output` in `commands/inference.rs`, path helpers in `app_support.rs`.
- **Rationale**: Keeps the first useful headless workflow small while still being end-to-end real.
- **Commands**: `generate row scene`, `generate all scene`.

### Direct Generation Commands
- **Does**: Runs TTS, SFX, and music generation directly to caller-provided output paths without needing a script row.
- **Interacts with**: TTS, SFX, and Music server generation endpoints plus sidecar writing.
- **Commands**: `generate tts-custom`, `generate tts-design`, `generate tts-clone`, `generate sfx`, `generate music`.
- **SFX control**: Exposes backend, model variant, duration, steps, seed, CFG/guidance scale, negative prompt, and candidate count.
- **Music control**: Exposes lyrics, duration, BPM, key, language, model size, diffusion steps, thinking mode, reference audio, seed, and batch size.
- **Rationale**: Agents often need probes, scratch assets, and reference clips before they are ready to bind a row.

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

### Composition And Audio Inspection Commands
- **Does**: Renders scenes/episodes, reads render metadata, and exposes waveform-oriented helpers for duration, peaks, and zero-crossing lookup.
- **Interacts with**: `audio_engine.rs` render helpers and `audio.rs` WAV inspection helpers.
- **Commands**: `compose render scene`, `compose final`, `compose meta`, `audio peaks`, `audio duration`, `audio zero-crossings`.
- **Rationale**: Clip Studio and Mix workflows need scriptable inspection primitives so agents can crop, place, and verify audio without the GUI canvas.

### Asset Commands
- **Does**: Lists generated/imported assets from sidecars, reads metadata, updates QA status/notes, lists takes, and assigns an asset to a script row.
- **Interacts with**: `sidecar.rs`, script row patch helpers.
- **Commands**: `asset list`, `asset meta`, `asset qa`, `asset takes`, `asset use`.

### Clip/Post Commands
- **Does**: Imports arbitrary source recordings, crops/processes clips with ffmpeg, applies curved fades, normalizes, resamples, and upscales through the remote-safe Post server.
- **Interacts with**: `audio_engine.rs`, `audio_enhance.rs`, Post server `/generate/upscale`.
- **Commands**: `post import`, `post process`, `post normalize`, `post resample`, `post upscale`.

### `post_upscale`
- **Does**: Submits AudioSR upscaling to the configured Post server, polls to completion, writes sidecar metadata, and prints the output path as JSON.
- **Interacts with**: `post_server.py`, helpers in `commands/audio_enhance.rs`.
- **Rationale**: Agents need the same remote-safe post-production upscaling path as the GUI.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `main.rs` | `run(args)` handles all CLI behavior and returns `Result<()>` | Signature or error semantics |
| Agents/scripts | JSON is emitted on stdout for successful commands | Switching to plain text output |
| `inference.rs` | Generation finalization writes sidecars and optional script bindings | Changing finalization payload semantics |
| `audio_enhance.rs` | CLI upscaling can run without `AppHandle` | Making helper GUI-only |
| GUI parity | CLI reads and writes the same project JSON, script CSV, sidecar metadata, and server config as the GUI | Creating CLI-only state paths |

## Notes
- CLI flags are `--kebab-case`; internally they normalize to snake case for shared Rust helpers.
- ML work stays on the configured inference servers. Local post commands use ffmpeg for deterministic file edits; AudioSR remains routed through the Post server.
- Story/LLM planning stages are still not invented here; the CLI exposes implemented workflows and file contracts.
