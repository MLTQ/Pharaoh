# Pharaoh

AI-powered audio drama production suite. Generate dialogue, sound design, and score from script — then compose, review takes, and render scenes in a timeline editor.

## What it is

Pharaoh is a Tauri 2 desktop app (React + Rust) that connects to three local Python inference servers:

| Port | Model | What it does |
|------|-------|-------------|
| 18001 | Qwen3-TTS | Character dialogue synthesis |
| 18002 | Woosh | Sound effects / foley generation |
| 18003 | ACE-Step | Score / music composition |

In **stub mode** (default), the servers return silent WAV files with simulated progress — no GPU required. Swap in real models by setting `PHARAOH_REAL_MODELS=1`.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.77+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js | 20+ | `brew install node` or [nodejs.org](https://nodejs.org) |
| Python | 3.11+ | `brew install python@3.11` |
| ffmpeg | any recent | `brew install ffmpeg` — required for Render Scene |
| Xcode CLT | (macOS) | `xcode-select --install` |

---

## Quick start

```bash
# 1. Clone and install JS dependencies
git clone <repo-url>
cd pharaoh
npm install

# 2. Set up Python inference servers
cd inference
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ..

# 3. Start inference servers (stub mode — no GPU needed)
./inference/start_servers.sh

# 4. In a separate terminal, start the Tauri dev app
npm run tauri dev
```

The app opens at the Pyramid view with demo data. All three server status dots in the topbar should turn green within ~30 seconds.

---

## Project workflow

### Demo mode (no project open)
All generation panels, the timeline, and the asset browser work with mock data. You can explore the UI, drag clips, preview mock assets, and see how the job queue responds — but no files are written to disk and the Render button is disabled.

### Real project mode

1. Click the **folder icon** in the left rail → **New project** or **Open existing**
2. Projects live in `~/pharaoh-projects/{project-id}/`
3. Each scene has a `script.csv` at `scenes/{slug}/script.csv`
4. Generated audio is written to `scenes/{slug}/assets/` with a `.wav.meta.json` sidecar

Once a project is open:
- Generate buttons in the **Voice / SFX / Score** panels submit real jobs
- The **Script panel** in the timeline header shows and edits `script.csv` inline
- The **timeline** shows live tracks derived from placed script rows
- **Render scene** calls ffmpeg to mix all placed clips into `render.wav`

---

## Inference servers

```bash
# Stub mode (default — returns silent WAVs, simulates progress)
./inference/start_servers.sh

# Real model mode (requires model weights installed)
./inference/start_servers.sh --real

# Health check
curl http://localhost:18001/health
curl http://localhost:18002/health
curl http://localhost:18003/health
```

Server URLs can be overridden in the app's settings panel if you're running on a remote machine or Tailscale.

### Real model setup (optional)

Uncomment the relevant lines in `inference/requirements.txt` and install:

```bash
# TTS (Qwen3-TTS — needs ~8 GB VRAM or Apple Silicon unified memory)
pip install transformers==4.51.3 torch torchaudio soundfile accelerate

# SFX (Woosh)
pip install woosh-audio   # or install from source per README

# Music (ACE-Step)
pip install ace-step      # or install from source per README
```

Then run with `--real`:
```bash
PHARAOH_REAL_MODELS=1 ./inference/start_servers.sh --real
```

---

## Script CSV format

Each scene's `script.csv` has these columns:

| Column | Description |
|--------|-------------|
| `scene` | Scene slug (e.g. `04_the_vault_beneath`) |
| `track` | Track lane name (e.g. `VERA`, `FOLEY`, `SCORE`) |
| `type` | `DIALOGUE`, `SFX`, `BED`, `MUSIC`, or `DIRECTION` |
| `character` | Speaker name (DIALOGUE rows) |
| `prompt` | Generation prompt or stage direction |
| `file` | Path to generated WAV (set when take is selected) |
| `start_ms` | Timeline position in milliseconds |
| `duration_ms` | Clip duration |
| `gain_db` | Volume adjustment (default `0`) |
| `fade_in_ms` / `fade_out_ms` | Fade envelope |
| `pan` | Stereo position `-1.0` to `1.0` |
| `instruct` | Voice instruction / style tag |

DIRECTION rows are skipped during generation and rendering.

---

## Key bindings (transport bar)

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → | Skip back / forward |

---

## Architecture overview

```
src/                    React 18 + TypeScript frontend
  components/
    pyramid/            Project overview + scene cards
    timeline/           CompositionView + DraggableClip
    generators/         TTS / SFX / Music panels
    shared/             AssetBrowser, JobQueue, PlayButton, atoms
  store/
    projectStore        Active project + scene state
    jobStore            Live job tracking + take management
    audioStore          Web Audio preview player (singleton AudioContext)
    modelStore          Server health polling
  hooks/
    useGenerateJob      Shared TTS/SFX/Music submission logic
  lib/
    tauriCommands       Typed wrappers for all Tauri IPC calls
    types               Shared TypeScript types

src-tauri/src/          Rust backend
  commands/
    project             Project CRUD (~/pharaoh-projects/)
    script              Script CSV read/write/update
    inference           Job submission + background polling + Tauri events
    audio               WAV peak extraction, duration, zero-crossings
    audio_engine        ffmpeg normalize, resample, render_scene
    sidecar             .wav.meta.json read/write/QA

inference/              Python FastAPI servers
  tts_server.py         Port 18001 — Qwen3-TTS
  sfx_server.py         Port 18002 — Woosh SFX
  music_server.py       Port 18003 — ACE-Step
  _common.py            Shared job store + WAV stub helpers
```

---

## Development

```bash
# Frontend only (browser mode — no Tauri IPC, uses mock data)
npm run dev

# Full Tauri dev build (opens native window)
npm run tauri dev

# Release build
npm run tauri build

# Type-check only
npx tsc --noEmit
```

---

## Known limitations (v0.1)

- **Agent Assist** button is a stub — LLM scene analysis not yet wired
- **Timeline playback** uses Web Audio preview only (no full transport sync)
- **Drag-to-place** writes `start_ms` back to script.csv only when a real project is open and the clip was derived from a script row (mock clips are visual-only)
- **Real model weights** must be installed separately; see inference server setup above
- **ffmpeg** must be on `$PATH` for Render Scene to work
- Windows not yet tested (Tauri 2 supports it; path separators and ffmpeg discovery may need adjustment)
