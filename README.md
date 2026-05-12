# Pharaoh

AI-powered audio drama production suite. Pharaoh is built around the Pyramid workflow:

```text
Story Bible -> Storyboard -> Script -> Assets -> Composition -> Render
```

The app is meant to be fully operable both by humans in the Tauri GUI and by agents through the headless CLI. Both surfaces use the same project files, script CSV rows, sidecar metadata, inference servers, and ffmpeg/audio-engine commands.

## What It Is

Pharaoh is a Tauri 2 desktop app (React + TypeScript frontend, Rust backend) connected to local or remote Python inference servers:

| Port | Service | Models / work |
|------|---------|---------------|
| 18001 | TTS | Qwen3-TTS CustomVoice, VoiceDesign, and voice clone probes |
| 18002 | SFX | Woosh short foley plus optional AudioLDM long soundscapes |
| 18003 | Music | ACE-Step score/music generation |
| 18004 | Post | Optional AudioSR neural upscaling |

The GUI can run locally while the Python servers run on another machine, as long as both sides can address the same audio paths. Server URLs are editable in Settings and through the CLI.

## Current Capabilities

- Pyramid project view with project/storyboard state, scene creation, scene status, and persisted project files under `~/pharaoh-projects`.
- Write/Direct/Mix composition workflow with a Fountain scene editor, syntax-aware audio-drama cues, and live compilation back to `script.csv`.
- Anthropic-backed scene drafting/revision from project context when `ANTHROPIC_API_KEY` (or the configured env var) is available.
- Dialogue generation through Qwen CustomVoice with separate editable spoken `line` and delivery `direction` (`instruct`) fields.
- Character Designer for cast records, voice assignments, VoiceDesign probes, clone probes, and reusable reference clips.
- SFX generation through Woosh for short foley and AudioLDM for long ambiences/sound beds.
- Score generation through ACE-Step with duration, BPM, key, lyrics, reference audio, seed, and model controls.
- Persisted generated-asset lists for dialogue, SFX, and score pages; pages show real sidecar-indexed takes, not mock variations.
- Audio Upscale page for running AudioSR against already-generated assets through the Post server.
- Clip Studio for importing long recordings, zooming/cropping, previewing from the crop start, applying gain/filter/normalization, drawing fade envelopes, saving child assets, and sending clips to scene rows.
- Scene rendering through ffmpeg with script-row placement, gain, fades, pan, and render output.
- Headless CLI coverage for project/scene/script/character/asset/generation/composition/post/setup workflows.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.77+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js | 20+ | `brew install node` or install from nodejs.org |
| Python | 3.11+ | `brew install python@3.11`; AudioSR uses a Python 3.9 venv created by setup |
| uv | recent | `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| ffmpeg | recent | `brew install ffmpeg`; required for render, import, clip processing, resample, normalize |
| SoX | recent | `brew install sox`; used by Qwen3-TTS reference-audio preprocessing |
| Xcode CLT | macOS | `xcode-select --install` |

## Quick Start

```bash
# 1. Install JS dependencies
npm install

# 2. Set up required TTS/Music envs and check Woosh.
./inference/setup.sh

# 3. Optional: install long soundscape and upscaling envs.
PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh
PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh

# 4. Start inference servers.
./inference/start_servers.sh

# 5. In a separate terminal, start the Tauri dev app.
npm run tauri dev
```

The top bar should show green health dots for TTS, SFX, Music, and AudioSR/Post when the optional Post server is installed.

## Inference Setup

`./inference/setup.sh` creates isolated environments because the model stacks pin incompatible runtime versions:

| Environment | Path | Purpose |
|-------------|------|---------|
| TTS | `inference/.venv-tts` | Qwen3-TTS server |
| Music | `inference/.venv-music` | ACE-Step server |
| SFX | `~/Code/Woosh/.venv` | Woosh, managed by the Woosh checkout |
| SFX+ | `inference/.venv-audioldm` | Optional native AudioLDM runner |
| Post | `inference/.venv-audiosr` | Optional AudioSR upscaler |

Useful setup commands:

```bash
# Woosh checkout expected by default
git clone https://github.com/SonyResearch/Woosh "$HOME/Code/Woosh"
cd "$HOME/Code/Woosh" && uv sync

# Optional AudioLDM Python env
PHARAOH_INSTALL_AUDIOLDM=1 ./inference/setup.sh

# Optional AudioSR Python env
PHARAOH_INSTALL_AUDIOSR=1 ./inference/setup.sh
```

Model/checkpoint locations:

| Area | Default path |
|------|--------------|
| Qwen3-TTS | `~/pharaoh-models/tts/{voice_design,base,custom_voice,tokenizer}/` |
| Woosh | `~/Code/Woosh/checkpoints/` |
| AudioLDM native | `~/pharaoh-models/sfx/audioldm/audioldm-m-full.ckpt` |
| AudioLDM diffusers fallback | `~/pharaoh-models/sfx/audioldm-s-full-v2/` |
| ACE-Step | `~/pharaoh-models/music/ACE-Step/ACE-Step-v1-3.5B/` |
| AudioSR | downloaded by AudioSR on first upscale |

The Settings/Models page contains copyable download commands, including the resumable AudioLDM checkpoint download. AudioLDM native is the production default; `PHARAOH_AUDIOLDM_ENGINE=diffusers` remains available for debugging only.

## Server Commands

```bash
./inference/start_servers.sh

curl http://127.0.0.1:18001/health
curl http://127.0.0.1:18002/health
curl http://127.0.0.1:18003/health
curl http://127.0.0.1:18004/health
```

Useful overrides:

| Variable | Effect |
|----------|--------|
| `PHARAOH_TTS_MODEL_DIR` | Qwen3-TTS model root |
| `PHARAOH_MUSIC_MODEL_DIR` | ACE-Step model root |
| `PHARAOH_WOOSH_DIR` | Woosh checkout root |
| `PHARAOH_AUDIOLDM_CACHE_DIR` / `AUDIOLDM_CACHE_DIR` | Native AudioLDM checkpoint cache |
| `PHARAOH_AUDIOLDM_PYTHON` | AudioLDM runner interpreter |
| `PHARAOH_POST_PYTHON` | Post server interpreter |
| `PHARAOH_AUDIOSR_CLI` | AudioSR CLI path |

AudioLDM notes:

- Use Woosh for short, sharp foley; use AudioLDM for long beds and ambience.
- Native AudioLDM defaults to upstream `audioldm-m-full`.
- AudioLDM rounds duration to 2.5 second increments.
- Multi-candidate ranking requires CUDA; on Apple Silicon/CPU Pharaoh forces one candidate.
- Upstream checkpoint progress on stderr, such as `8% |#####|`, is a download progress bar, not an inference error.

## GUI Workflow

### Project Mode

1. Click the folder icon in the left rail.
2. Create or open a project under `~/pharaoh-projects/{project-id}/`.
3. Create scenes in the Pyramid view or import a Fountain script through the CLI.
4. Author/revise scene text in Write mode or edit row data directly.
5. Generate dialogue/SFX/music assets, review takes, and assign the selected outputs to script rows.
6. Use Clip Studio and Audio Upscale for post-production.
7. Render the scene from Mix mode.

### Write Mode / Fountain

The scene writer supports a practical audio-drama Fountain subset:

- Standard dialogue blocks with character cues.
- Parentheticals compiled into row `instruct` direction.
- `SFX:`, `BED:`, and `MUSIC:` cue prefixes.
- Stable block IDs stored in `ScriptRow.notes`.
- `Tab` cycles a line between action, character, SFX, MUSIC, BED, and back.
- `Draft scene` / `Revise scene` calls the Anthropic LLM command if configured.

### Generation Pages

- Dialogue uses Qwen CustomVoice for production lines so delivery direction can be sent as `instruct`. Voice clone/design remain in Character Designer for probes and reference building.
- SFX exposes backend, model variant, duration, steps, seed, CFG/guidance, candidate count, and AudioLDM negative prompt.
- Music exposes caption, lyrics, duration, BPM, key, language, LM size, diffusion steps, thinking mode, reference audio, seed, and batch size.
- Each generation page lists current jobs plus persisted sidecar assets for the selected scene.

### Post Pages

- Audio Upscale submits AudioSR jobs to the Post server and writes enhanced 48 kHz child assets next to the source.
- Clip Studio imports arbitrary source audio, shows long clips with zoom/pan, supports crop handles, fade-envelope handles, gain, highpass/lowpass, LUFS normalization, and row assignment.
- Cropped/imported clips are sidecar-indexed, so Character Designer can reuse them as clone references.

## Project Files

Projects live under `~/pharaoh-projects` by default:

```text
~/pharaoh-projects/{project-id}/
  project.json
  storyboard.json
  scenes/{scene-slug}/
    script.csv
    assets/
      *.wav
      *.wav.meta.json
    render/
      render.wav
  characters/{character-id}/
    *.wav
    *.wav.meta.json
```

Generated and post-processed WAVs use `.wav.meta.json` sidecars for prompts, model details, parent/child relationships, take history, QA notes, and scene/row assignment metadata.

## Script CSV Format

Each scene's `script.csv` uses these columns:

| Column | Description |
|--------|-------------|
| `scene` | Scene number or slug |
| `track` | Track lane name, such as a character, `FOLEY`, or `SCORE` |
| `type` | `DIALOGUE`, `SFX`, `BED`, `MUSIC`, or `DIRECTION` |
| `character` | Speaker character id/name for dialogue |
| `prompt` | Spoken text, cue prompt, or direction text |
| `file` | Path to selected/generated WAV |
| `start_ms` | Timeline placement |
| `duration_ms` | Clip duration |
| `gain_db` | Gain adjustment |
| `fade_in_ms` / `fade_out_ms` | Fade durations |
| `pan` | Stereo position, `-1.0` to `1.0` |
| `instruct` | Voice direction or generation instruction |
| `notes` | Stable Fountain block id and notes |

`DIRECTION` rows are skipped during generation and rendering.

## Headless CLI

The Tauri binary switches into CLI mode when invoked with arguments. In development, run commands with:

```bash
cargo run --manifest-path src-tauri/Cargo.toml -- <command>
```

Release builds expose the same commands through the packaged `pharaoh` binary.

Common commands are shown below with the release binary name. During development, prefix them with `cargo run --manifest-path src-tauri/Cargo.toml --`.

```bash
# Server/config/setup
pharaoh server health all
pharaoh server config
pharaoh server config-set --post-url http://remote-host:18004
pharaoh setup status
pharaoh setup hardware

# Projects/scenes/scripts
pharaoh project list
pharaoh project create --title "The Salt Vault" --tone "intimate, dread"
pharaoh scene create <project_id> --title "The Door Below"
pharaoh script read <project_id> <scene_slug>
pharaoh script fountain-read <project_id> <scene_slug>
pharaoh script fountain-write <project_id> <scene_slug> ./scene.fountain
pharaoh script update-row <project_id> <scene_slug> 3 --prompt "new line" --instruct "low, afraid"
pharaoh script import <project_id> ./episode.fountain --dry-run

# Agent writing/review
pharaoh llm draft-scene <project_id> <scene_slug> --write-fountain true
pharaoh storyboard review <project_id>

# Characters and voice probes
pharaoh character list <project_id>
pharaoh character create <project_id> --name Mira --description "weary archivist"
pharaoh character voice-set <project_id> <character_id> --model CustomVoice --instruct "tired, controlled"
pharaoh character voice-design-test <project_id> <character_id> --voice-description "low alto, dry, precise"
pharaoh character voice-clone-test <project_id> <character_id> --ref-audio-path ./mira_ref.wav

# Direct generation
pharaoh generate tts-custom --text "We are not alone." --instruct "whispered" --output-path ./line.wav
pharaoh generate sfx --backend audioldm --prompt "rain on tin roof" --duration-seconds 90 --output-path ./rain.wav
pharaoh generate music --caption "slow bowed strings, dread" --duration-seconds 45 --output-path ./score.wav

# Scene automation
pharaoh generate row scene <project_id> <scene_slug> 4
pharaoh generate all scene <project_id> <scene_slug>
pharaoh compose render scene <project_id> <scene_slug>
pharaoh compose meta ~/pharaoh-projects/<project_id>/scenes/<scene_slug>/render/render.wav

# Assets and post
pharaoh asset list <project_id> --kind sfx --scene <scene_slug>
pharaoh asset meta ./take.wav
pharaoh audio duration ./take.wav
pharaoh audio peaks ./take.wav 120
pharaoh audio zero-crossings ./take.wav 4500
pharaoh asset qa ./take.wav --status approved --notes "usable after trim"
pharaoh asset use <project_id> <scene_slug> 4 ./take.wav
pharaoh post import <project_id> ./field_recording.wav --label "booth selects"
pharaoh post process ./field_recording.wav --start-ms 12000 --end-ms 18500 --fade-in-ms 150 --fade-out-ms 250
pharaoh post upscale ./take.wav --model basic --steps 50 --guidance 3.5
```

All successful CLI commands emit JSON on stdout so agents can parse results.

## Architecture Overview

```text
src/
  components/
    pyramid/              Project overview, story bible, scenes
    timeline/             Write/Direct/Mix composition views and Fountain editor
    generators/           Dialogue, SFX, and Music panels
    characters/           Character and voice-design workspace
    models/               Server/model lifecycle panel
    upscale/              AudioSR post page
    post/                 Clip Studio
    shared/               Asset browser, job queue, play buttons, atoms
  store/
    projectStore          Active project/storyboard/characters/scenes
    jobStore              Live jobs and generated takes
    audioStore            Web Audio preview player
    modelStore            Server health and model load state
  lib/
    fountain              Browser Fountain parser/compiler
    tauriCommands         Typed Tauri IPC wrappers
    types                 Shared TS types

src-tauri/src/
  cli                     Headless command surface
  fountain                Rust Fountain parser for CLI import
  commands/
    project               Project/storyboard CRUD
    script                script.csv read/write/update
    inference             Job submission and sidecar finalization
    llm                   Anthropic scene draft/revision
    audio                 Peaks, duration, zero-crossing helpers
    audio_engine          ffmpeg import/process/render
    audio_enhance         Post server / AudioSR polling
    sidecar               .wav.meta.json metadata
    settings              App config and health

inference/
  tts_server.py           Port 18001, Qwen3-TTS
  sfx_server.py           Port 18002, Woosh + AudioLDM
  music_server.py         Port 18003, ACE-Step
  post_server.py          Port 18004, AudioSR
  setup.sh                Isolated venv setup
  start_servers.sh        Starts available servers
```

See `ARCHITECTURE.md` for the original Pyramid specification and companion `*.md` files next to source files for implementation contracts.

## Development

```bash
# Frontend browser mode
npm run dev

# Full Tauri dev app
npm run tauri dev

# Frontend type-check and build
npm run build

# Rust backend check
cargo check --manifest-path src-tauri/Cargo.toml

# Release build
npm run tauri build
```

## Known Limitations

- Fully remote deployments still assume shared filesystem paths between GUI/CLI and inference host. Upload/download transport is not implemented yet.
- AudioLDM native candidate ranking requires CUDA; CPU/Apple Silicon runs one candidate.
- AudioSR can take several minutes on long clips and downloads checkpoints on first use.
- The LLM scene drafter is Anthropic-only for now; `project.json.llm_config.provider` is reserved for future providers.
- Fountain support is practical, not complete: dual dialogue, transitions, centered text, explicit scene numbers, and full title-page metadata are not implemented.
- Windows is not yet tested; Tauri supports it, but ffmpeg discovery, path handling, and model runtimes may need work.
