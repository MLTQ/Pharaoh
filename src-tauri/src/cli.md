# cli/ (headless CLI)

## Purpose
Headless command entrypoint for Pharaoh. It exposes the GUI workflows as JSON-emitting commands so agents can manage projects, author scenes/scripts, create characters, run generation, review assets, process clips, and inspect setup/server state without requiring the Tauri GUI.

`cli.rs` was split into the `cli/` module directory; `mod cli;` in `lib.rs` resolves to `cli/mod.rs`. The command surface — names, flags, JSON stdout shapes, exit codes, stderr errors — is a stable agent-facing API and must not change when moving code between submodules.

## Module Map

| File | Owns | Commands |
|------|------|----------|
| `cli/mod.rs` | `run` dispatcher + `usage()` text | routes every argv pattern into a submodule |
| `cli/helpers.rs` | shared plumbing: `print_json`, flag parsing, `load_project`/`save_project`/`load_storyboard`, `find_scene`/`scene_not_found`, `submit_job`/`poll_job`, `cli_wav_info`, `random_seed` | none directly |
| `cli/project.rs` | project CRUD + status + archive | `project list/status/create/update/archive` |
| `cli/scene_script.rs` | storyboard scene CRUD, script.csv/fountain authoring, row patching, spatialize, Fountain import | `scene list/get/create/update`, `script read/write/fountain-read/fountain-write/update-row/spatialize/import` |
| `cli/character.rs` | character CRUD, voice assignment, voice probes | `character list/create/update/delete/voice-set/voice-design-test/voice-clone-test` |
| `cli/server_setup.rs` | server health/config, model load/unload, setup inspection | `server health/config/config-set`, `model load/unload`, `setup status/hardware` |
| `cli/generate.rs` | direct generation to caller paths; shared TTS submit/finalize helpers used by `character.rs` | `generate tts-custom/tts-design/tts-clone/sfx/music` |
| `cli/generate_scene.rs` | script-row generation bound back into script.csv | `generate row scene`, `generate all scene` |
| `cli/asset_post.rs` | sidecar-backed asset listing/QA/takes/binding; clip import/process/normalize/resample/upscale | `asset list/meta/qa/takes/use`, `post import/process/normalize/resample/upscale` |
| `cli/compose.rs` | scene/episode rendering, render meta, waveform inspection | `compose render scene`, `compose final`, `compose meta`, `audio peaks/duration/zero-crossings` |
| `cli/llm.rs` | Anthropic-backed drafting and continuity review | `llm draft-scene`, `storyboard review/rewrite` |

## Components

### `run` (`cli/mod.rs`)
- **Does**: Parses top-level CLI commands, loads shared app config, and dispatches to submodules.
- **Interacts with**: `app_support.rs` for config; every `cli/*` submodule.

### Project And Scene Commands (`cli/project.rs`, `cli/scene_script.rs`)
- **Does**: Provides non-GUI project creation/update/status plus storyboard scene list/get/create/update.
- **Interacts with**: `Project` and `Storyboard` models in `models.rs`.

### Script Commands (`cli/scene_script.rs`)
- **Does**: Reads, writes, and patches scene `script.csv` rows; persists and compiles per-scene `script.fountain` prose used by the GUI editor; sets spatial placement; imports whole Fountain screenplays.
- **Interacts with**: `read_script_rows`, `write_script_rows`, `update_script_row_fields` in `app_support.rs`, `parse_document` / `blocks_to_rows` in `fountain.rs`, `audio_spatial.rs` space manifest.

### Character Commands (`cli/character.rs`)
- **Does**: Manages project characters and voice assignments, including headless voice design/clone probe generation.
- **Interacts with**: `Character`, `VoiceAssignment`, TTS request models, and the shared TTS finalize helpers in `cli/generate.rs`.

### Server And Setup Commands (`cli/server_setup.rs`)
- **Does**: Reports inference server health, reads/updates configured endpoint paths, triggers model load/unload endpoints, summarizes local setup paths, and exposes hardware detection used by Settings.
- **Interacts with**: App config, `/health`, `/load`, `/unload` endpoints, `detect_hardware` in `inference.rs`.

### LLM Authoring Commands (`cli/llm.rs`)
- **Does**: Runs the GUI's Anthropic-backed scene draft/revision pass from on-disk project and scene context, optionally persisting and compiling the result.
- **Interacts with**: `draft_scene_impl` and `storyboard_review_impl` in `commands/llm.rs`, Fountain helpers in `cli/scene_script.rs`.
- **Rationale**: Agents need the same first-draft and continuity-review loops as GUI users, but with explicit write/compile controls.

### Scene Row Generation (`cli/generate_scene.rs`)
- **Does**: Reads `script.csv`, chooses the proper inference endpoint per row type, waits for completion, and binds outputs back into the script.
- **Interacts with**: `finalize_generation_output` in `commands/inference.rs`, path helpers in `app_support.rs`.
- **Rationale**: Keeps the first useful headless workflow small while still being end-to-end real.

### Direct Generation Commands (`cli/generate.rs`)
- **Does**: Runs TTS, SFX, and music generation directly to caller-provided output paths without needing a script row.
- **Interacts with**: TTS, SFX, and Music server generation endpoints plus sidecar writing.
- **SFX control**: Exposes backend, model variant, duration, steps, seed, CFG/guidance scale, negative prompt, and candidate count.
- **Music control**: Exposes lyrics, duration, BPM, key, language, model size, diffusion steps, thinking mode, reference audio, seed, and batch size.
- **Rationale**: Agents often need probes, scratch assets, and reference clips before they are ready to bind a row.

### `generate_sfx` (`cli/generate_scene.rs`)
- **Does**: Generates `SFX` rows with Woosh by default and `BED` or >5-second rows with AudioLDM.
- **Interacts with**: `SfxT2ARequest`, SFX server `/generate/t2a`.
- **Rationale**: Headless agents should not have to stitch many short Woosh chunks for rain, wind, traffic, or room-tone beds.
- **AudioLDM defaults**: Uses upstream's recommended `audioldm-m-full` checkpoint, 200 diffusion steps, and one candidate for cross-platform reliability. Upstream multi-candidate ranking requires CUDA.

### `generate_dialogue` (`cli/generate_scene.rs`)
- **Does**: Builds CustomVoice TTS requests from script row `prompt` text, row `instruct` direction, and project character voice assignments.
- **Interacts with**: `TtsCustomVoiceRequest` in `models.rs`.
- **Rationale**: Production dialogue needs explicit delivery direction. Clone/design assignments remain useful for character design probes, but headless dialogue generation always sends `instruct` to CustomVoice.

### Composition And Audio Inspection Commands (`cli/compose.rs`)
- **Does**: Renders scenes/episodes with the same Rust audio engine used by the GUI, reads render metadata, and exposes waveform-oriented helpers for duration, peaks, and zero-crossing lookup.
- **Interacts with**: `render_scene_with_projects_dir` / `render_episode_with_projects_dir` in `commands/audio_engine.rs` and `commands/audio.rs` WAV inspection helpers.
- **Rationale**: Clip Studio and Mix workflows need scriptable inspection primitives so agents can crop, place, and verify audio without the GUI canvas.

### Asset Commands (`cli/asset_post.rs`)
- **Does**: Lists generated/imported assets from sidecars, reads metadata, updates QA status/notes, lists takes, and assigns an asset to a script row.
- **Interacts with**: `sidecar.rs`, script row patch helpers.

### Clip/Post Commands (`cli/asset_post.rs`)
- **Does**: Imports arbitrary source recordings, crops/processes clips with ffmpeg, applies curved fades, normalizes, resamples, and upscales through the remote-safe Post server.
- **Interacts with**: `audio_engine.rs`, `audio_enhance.rs`, Post server `/generate/upscale`.

### `post_upscale` (`cli/asset_post.rs`)
- **Does**: Submits AudioSR upscaling to the configured Post server, polls to completion, writes sidecar metadata, and prints the output path as JSON.
- **Interacts with**: `post_server.py`, helpers in `commands/audio_enhance.rs`.
- **Rationale**: Agents need the same remote-safe post-production upscaling path as the GUI.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `lib.rs` | `cli::run(args)` handles all CLI behavior and returns `Result<()>` | Signature or error semantics |
| Agents/scripts | JSON is emitted on stdout for successful commands; errors go to stderr with exit code 1 | Switching to plain text output; changing exit codes |
| `inference.rs` | Generation finalization writes sidecars and optional script bindings | Changing finalization payload semantics |
| `audio_enhance.rs` | CLI upscaling can run without `AppHandle` | Making helper GUI-only |
| GUI parity | CLI reads and writes the same project JSON, script CSV, sidecar metadata, and server config as the GUI | Creating CLI-only state paths |

## Notes
- CLI flags are `--kebab-case`; internally they normalize to snake case for shared Rust helpers.
- Error messages carry agent-actionable context: which project id / scene slug / character id / path / server URL failed, plus the follow-up command to run (`pharaoh project list`, `pharaoh scene list <project>`, `pharaoh character list <project>`, `pharaoh server health`). Message text may improve; exit codes and JSON shapes may not.
- ML work stays on the configured inference servers. Local post commands use ffmpeg for deterministic file edits; AudioSR remains routed through the Post server.
- Story/LLM planning stages are still not invented here; the CLI exposes implemented workflows and file contracts.
