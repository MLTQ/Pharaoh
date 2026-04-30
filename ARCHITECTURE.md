# PHARAOH
# AI-Powered Audio Drama Production Suite
# Architecture Plan, Purpose & Specification

**Repo:** ~/Code/Pharaoh  
**Stack:** Tauri 2 + React 18 + TypeScript (frontend) · Rust (backend) · Python FastAPI (inference servers)

---

## PURPOSE

Pharaoh is a unified desktop application for producing AI-generated audio dramas.
The name reflects the central metaphor: the user or AI agent commands a pyramid
to be built — the audio drama is the monument.

The app integrates three open-source generative models:
- **Qwen3-TTS** — voice synthesis (clone, design, preset)
- **Woosh (Sony AI)** — sound effects (text-to-audio, video-to-audio)
- **ACE-Step 1.5** — music (text2music, cover, repaint, lego, extract)

These are organized around a "pyramidal story structure" that mirrors the natural
hierarchy of dramatic production:

```
Story Bible → Storyboard → Script → Assets → Composition → Render
```

The application must be fully operable by a human via GUI and by an AI agent
via headless CLI, sharing the same underlying data model and operations.

---

## REPOSITORY STRUCTURE

```
~/Code/Pharaoh/
├── src-tauri/                  # Rust backend (Tauri 2)
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   │   ├── project.rs      # CRUD for project/scene/clip
│   │   │   ├── audio.rs        # ffmpeg ops, normalization, render
│   │   │   ├── inference.rs    # spawn/manage Python servers
│   │   │   ├── sidecar.rs      # read/write .meta.json files
│   │   │   └── fs.rs           # file I/O, archive, export
│   │   ├── audio_engine.rs     # ffmpeg filter_complex builder
│   │   ├── model_manager.rs    # VRAM tracking, offload logic
│   │   └── ipc.rs              # event streaming to frontend
│   └── Cargo.toml
│
├── inference/                  # Python inference servers
│   ├── tts_server.py           # Qwen3-TTS FastAPI server
│   ├── sfx_server.py           # Woosh FastAPI server
│   ├── music_server.py         # ACE-Step FastAPI server
│   ├── requirements.txt
│   └── README.md
│
├── src/                        # React/TypeScript frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── store/
│   │   ├── projectStore.ts     # project, scenes, clips (Zustand)
│   │   ├── jobStore.ts         # generation job queue
│   │   ├── playbackStore.ts    # transport state
│   │   └── modelStore.ts       # model load/VRAM state
│   ├── components/
│   │   ├── pyramid/
│   │   │   ├── PyramidCanvas.tsx
│   │   │   ├── StoryBibleCard.tsx
│   │   │   ├── SceneCard.tsx
│   │   │   └── CompositionView.tsx
│   │   ├── generators/
│   │   │   ├── TTSPanel.tsx
│   │   │   ├── SFXPanel.tsx
│   │   │   └── MusicPanel.tsx
│   │   ├── timeline/
│   │   │   ├── Timeline.tsx        # HTML Canvas, not DOM
│   │   │   ├── Track.tsx
│   │   │   ├── Clip.tsx
│   │   │   └── WaveformCanvas.tsx  # shared peaks renderer
│   │   └── shared/
│   │       ├── AssetBrowser.tsx
│   │       ├── JobQueue.tsx
│   │       ├── ModelManager.tsx
│   │       ├── PlaybackBar.tsx
│   │       └── FinalAssembly.tsx
│   ├── hooks/
│   │   ├── useProject.ts
│   │   ├── usePlayback.ts
│   │   ├── useInference.ts
│   │   └── useWaveform.ts
│   └── lib/
│       ├── csvParser.ts        # script CSV read/write/update
│       ├── tauriCommands.ts    # typed invoke() wrappers
│       └── audioUtils.ts       # duration, time formatting
│
├── cli/                        # Headless agent CLI
│   ├── main.ts
│   ├── commands/
│   │   ├── project.ts
│   │   ├── generate.ts
│   │   ├── compose.ts
│   │   └── render.ts
│   └── README.md
│
└── projects/                   # Default project root
    └── [project-slug]/
        ├── project.json
        ├── story.md
        ├── storyboard.json
        ├── scenes/
        │   └── 03_the_return/
        │       ├── script.csv
        │       ├── assets/
        │       │   ├── mira_line_01.wav
        │       │   ├── mira_line_01.wav.meta.json
        │       │   └── ...
        │       └── render/
        │           └── scene_03.wav
        └── output/
            └── final.wav
```

---

## DATA MODEL

### project.json

```json
{
  "id": "uuid",
  "title": "The Reach",
  "logline": "string",
  "tone": "string",
  "global_audio_notes": "dry, intimate, minimal reverb under dialogue",
  "target_duration_minutes": 30,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "characters": [
    {
      "id": "uuid",
      "name": "Mira",
      "description": "string",
      "voice_assignment": {
        "model": "CustomVoice | VoiceDesign | Clone | FineTuned",
        "speaker": "Vivian",
        "instruct_default": "tired, edge of tears",
        "ref_audio_path": null,
        "ref_transcript": null
      }
    }
  ],
  "llm_config": {
    "provider": "anthropic | openai | local",
    "model": "claude-sonnet-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  }
}
```

### storyboard.json

```json
{
  "scenes": [
    {
      "id": "uuid",
      "index": 3,
      "slug": "03_the_return",
      "title": "The Return",
      "description": "string",
      "location": "interior, night, Mira's apartment",
      "characters": ["Mira", "Elias"],
      "notes": "tense reunion, claustrophobic ambience",
      "connects_from": "uuid | null",
      "connects_to": "uuid | null",
      "status": "draft | generating | assets_ready | composed | rendered"
    }
  ]
}
```

### script.csv

One row per audio event. This is the core working document for each scene.

```
scene,track,type,character,prompt,file,start_ms,duration_ms,loop,pan,gain_db,instruct,fade_in_ms,fade_out_ms,reverb_send,notes
```

**Field notes:**
- `type`: `DIALOGUE | SFX | BED | MUSIC | DIRECTION`
- `file`: empty string = unresolved; populated = resolved asset path
- `start_ms`: empty = unresolved (pre-backfill); integer = placed on timeline
- `loop`: `true` for beds and continuous ambience tracks
- `pan`: -100 (full left) to 100 (full right)
- `reverb_send`: 0.0–1.0 wet send amount
- `DIRECTION` rows carry no audio — composition notes only, used by agent

**Example (mixed resolved/unresolved):**
```
03,dialogue,DIALOGUE,Mira,,mira_line_01.wav,0,3200,false,0,0,"tired edge of tears",50,50,0.1,
03,bed,BED,,rain on glass quiet distant,rain_exterior_03.wav,0,,true,-10,-6,,200,200,0,loops for full scene
03,sfx,SFX,,door creak slow interior wood,,,,false,20,0,,,,,unresolved
03,music,MUSIC,,tension underscore sparse piano,,,,false,0,-12,,500,1000,0,unresolved
03,dialogue,DIALOGUE,Elias,,elias_line_01.wav,4100,2600,false,0,0,"flat controlled hiding fear",50,50,0.1,
```

### Asset sidecar — `filename.wav.meta.json`

Stored adjacent to every generated audio file. Enables right-click → Regenerate
with identical parameters, and provides full take lineage.

```json
{
  "model": "qwen3-tts-customvoice | woosh-dflow | ace-step-1.5",
  "model_variant": "1.7B",
  "prompt": "string",
  "instruct": "string | null",
  "speaker": "string | null",
  "language": "string | null",
  "seed": 4821,
  "temperature": 0.7,
  "top_p": 0.9,
  "duration_target_ms": null,
  "duration_actual_ms": 2100,
  "sample_rate": 24000,
  "generated_at": "ISO8601",
  "parent": "filename | null",
  "take_index": 2,
  "qa_status": "unreviewed | approved | rejected",
  "qa_notes": "string"
}
```

---

## INFERENCE SERVER SPEC

Three persistent FastAPI servers, one per model family.
The Rust backend spawns them on demand and keeps them alive between generations.
Model weights are loaded once — subsequent generations pay only inference cost.

### Ports (configurable in settings.json)

| Server | Default port |
|--------|-------------|
| TTS    | 18001       |
| SFX    | 18002       |
| Music  | 18003       |

### Common endpoints (all three servers)

```
GET  /health
     → { status, model_loaded, model_variant, vram_mb }

POST /generate
     → { job_id }   (returns immediately, generation is async)

GET  /jobs/{job_id}
     → { status: "pending|running|complete|failed",
         progress: 0.0-1.0,
         output_path: "string | null",
         error: "string | null" }

POST /unload
     → unloads model weights from VRAM
```

### TTS server — port 18001

Wraps Qwen3-TTS. Three generation modes corresponding to three model variants.

```
POST /generate/custom_voice
     body: { text, speaker, language, instruct, seed,
             temperature, top_p, max_new_tokens, output_path }

POST /generate/voice_design
     body: { text, voice_description, language, seed,
             temperature, top_p, max_new_tokens, output_path }

POST /generate/voice_clone
     body: { text, ref_audio_path, ref_transcript, language,
             icl_mode, seed, temperature, top_p, output_path }

GET  /speakers
     → list of 9 preset speakers with name and description

GET  /languages
     → list of supported languages
```

**Qwen3-TTS model variants:**
- `Qwen3-TTS-12Hz-1.7B-CustomVoice` — 9 preset voices, instruction-steerable
- `Qwen3-TTS-12Hz-1.7B-VoiceDesign` — free-form voice creation from description
- `Qwen3-TTS-12Hz-1.7B-Base` — 3-second voice cloning from reference audio
- `Qwen3-TTS-12Hz-0.6B-*` — lighter variants for low-VRAM setups

**Preset speakers:**
| Name | Character |
|------|-----------|
| Vivian | Bright, slightly edgy young female |
| Lili | Warm, gentle young female |
| Magnus | Seasoned male, low mellow timbre |
| Jinchen | Youthful Beijing male, clear natural |
| (Chengdu) | Lively male, slightly husky |
| (Dynamic) | Male, strong rhythmic drive |
| Ryan | Sunny American male, clear midrange |
| (Japanese) | Playful female, light nimble timbre |
| (Korean) | Warm female, rich emotion |

**Known gotchas:**
- Incompatible with `transformers >= 5.0` — pin version in requirements
- FlashAttention 2 unavailable on Windows without significant setup; fall back to SDPA
- Can enter infinite generation loops (known upstream issue) — set `max_new_tokens` conservatively, expose seed control
- Output sample rate: 24kHz — normalize to 48kHz before composition

### SFX server — port 18002

Wraps Woosh (Sony AI SFX Foundation Model).

```
POST /generate/t2a
     body: { prompt, duration_seconds, model_variant,
             steps, seed, output_path }

POST /generate/v2a
     body: { video_path, prompt_override, model_variant,
             steps, seed, output_path }
```

**Woosh model variants:**
- `Woosh-Flow` — full T2A diffusion model
- `Woosh-DFlow` — distilled, 4-step fast inference (preferred for iteration)
- `Woosh-VFlow` — video-to-audio
- `Woosh-DVFlow` — distilled video-to-audio

**Known gotchas:**
- Open weights are CC-BY-NC (non-commercial). Commercial use requires contacting Sony AI.
- Output is **monaural** — apply stereo widening post-FX for spatial placement
- Output sample rate: 48kHz
- Quality gap between public weights (trained on public datasets) and Sony's internal model (studio SFX libraries)

### Music server — port 18003

Wraps ACE-Step 1.5. Six generation modes; three are base-model-only.

```
POST /generate/text2music
     body: { caption, lyrics, duration_seconds, bpm, key,
             language, lm_model_size, diffusion_steps,
             thinking_mode, reference_audio_path, seed,
             batch_size, output_path }

POST /generate/cover
     body: { source_audio_path, caption, cover_strength,
             diffusion_steps, seed, output_path }

POST /generate/repaint
     body: { source_audio_path, caption, start_ms, end_ms,
             diffusion_steps, seed, output_path }

POST /generate/lego
     body: { source_audio_path, caption, track_name,
             diffusion_steps, seed, output_path }

POST /generate/extract
     body: { source_audio_path, track_class, output_path }

POST /generate/complete
     body: { source_audio_path, caption, diffusion_steps,
             seed, output_path }
```

**ACE-Step generation modes:**

| Mode | Description | Model requirement |
|------|-------------|-------------------|
| text2music | Generate from text + lyrics | All variants |
| cover | Restyle existing audio, keep structure | All variants |
| repaint | Regenerate a time segment in place | All variants |
| lego | Add a new instrument layer to existing audio | Base/SFT only |
| extract | Isolate a stem from mixed audio | Base/SFT only |
| complete | Generate backing for a vocal recording | Base/SFT only |

**LM planner sizes** (for text2music, lego, complete):
`none (disabled) | 0.6B | 1.7B | 4B`
Larger = better planning, slower. Disable for direct control when you know exactly what you want.

**Extractable stems:**
`vocals, backing_vocals, drums, bass, guitar, keyboard, percussion, strings, synth, fx, brass, woodwinds`

**Known gotchas:**
- Output is highly seed-sensitive ("gacha" results) — expose seed control and batch generation
- Lego/Extract/Complete require base or SFT model, not turbo
- LM planner is bypassed automatically for cover/repaint/extract (source audio replaces planning)
- Vocal synthesis quality is coarse — use for underscore and ambience, not sung dialogue

---

## RUST BACKEND

### audio_engine.rs

Builds and executes ffmpeg `filter_complex` graphs from a scene's `script.csv`.
All operations are idempotent — same inputs always produce same output.

**Key operations:**

```rust
// Per-clip loudness normalization before composition
normalize_clip(path: &Path, target_lufs: f32 = -23.0) -> Result<PathBuf>

// Resample all assets to 48kHz (Qwen3-TTS outputs 24kHz, others 48kHz)
resample_to_48k(path: &Path) -> Result<PathBuf>

// Read script.csv, build filter_complex, render scene WAV
render_scene(scene_path: &Path) -> Result<PathBuf>

// Final assembly with crossfade between scenes
concat_scenes(paths: Vec<PathBuf>, crossfade_ms: u64) -> Result<PathBuf>

// Auto-ducking: DIALOGUE clips duck BED/MUSIC by configured dB
// with configurable attack/release curves
apply_ducking(timeline: &Timeline, duck_db: f32, attack_ms: u64, release_ms: u64)
```

**filter_complex strategy:** Build graph as a string, write to temp file, pass to
`ffmpeg -filter_complex_script`. This avoids shell escaping issues with complex graphs
and keeps the graph readable for debugging.

### model_manager.rs

- Tracks VRAM budget across all three inference servers via `/health` polling
- On load request: check available VRAM, offload LRU model if needed, then trigger load
- Health-polls all servers every 30s
- Emits Tauri events to frontend for live VRAM status bar indicator
- Configurable VRAM budget ceiling (leave headroom for OS and other apps)

### sidecar.rs

```rust
// Atomic write: write to .tmp, then rename (prevents partial writes)
write_sidecar(audio_path: &Path, params: &SidecarData) -> Result<()>

// Returns None if no sidecar exists (un-generated asset)
read_sidecar(audio_path: &Path) -> Result<Option<SidecarData>>

// Discover all takes for a base filename, ordered by take_index
// e.g. mira_line_01_take1.wav, mira_line_01_take2.wav, ...
get_takes(base_path: &Path) -> Result<Vec<SidecarData>>
```

### commands/audio.rs (Tauri commands exposed to frontend)

```rust
#[tauri::command]
get_waveform_peaks(path: String, num_peaks: usize) -> Result<Vec<f32>>

#[tauri::command]
get_duration_ms(path: String) -> Result<u64>

#[tauri::command]
find_zero_crossings(path: String, near_ms: u64) -> Result<Vec<u64>>

#[tauri::command]
trim_clip(src: String, dst: String, start_ms: u64, end_ms: u64) -> Result<()>

#[tauri::command]
render_scene(scene_id: String) -> Result<String>  // returns output path

#[tauri::command]
render_final(project_id: String, crossfade_ms: u64) -> Result<String>
```

---

## FRONTEND

### PyramidCanvas.tsx

Main workspace. Three visual zones with explicit zoom state machine.

```typescript
type ZoomLevel = "full" | "story" | "scene"
type PyramidState = {
  zoom: ZoomLevel
  active_scene_id: string | null
}
```

Transitions animate at 200ms ease-out. When zoomed into a scene, the middle
tier collapses to a mini scene strip at the top of the canvas for lateral
navigation without zooming back out.

Zones are separated by thin horizontal rules. The full pyramid view shows all
three tiers simultaneously; clicking drills down.

### Timeline.tsx

Built on HTML Canvas (not DOM elements) for performance at scale.

**Renders:** track lanes, clip rectangles with embedded waveforms, time ruler,
playhead cursor, loop region markers.

**Interactions:**
- Drag clips horizontally → updates `start_ms` in CSV immediately
- Drag clip left/right edges → calls `trim_clip` Tauri command
- Click clip → select (shows per-clip controls in sidebar)
- Right-click clip → context menu: Regenerate, Replace, Properties, Remove

All mutations write back to `script.csv` immediately. No unsaved state.

### WaveformCanvas.tsx

Shared peaks renderer used across the entire app.

```typescript
type WaveformCanvasProps = {
  peaks: Float32Array
  width: number
  height: number
  color: string
  playhead_position?: number  // 0.0-1.0, optional
}
```

Used in: timeline clip interiors, asset browser thumbnails, playback bar mini-preview.
Rendered via Canvas 2D API for performance.

### Job lifecycle

```
1. User triggers generation from any panel
2. Frontend calls Tauri command (invoke)
3. Rust POSTs to inference server → receives job_id immediately
4. Rust polls /jobs/{id} at 500ms intervals
5. Rust emits Tauri events: job-progress, job-complete, job-failed
6. Frontend jobStore updates in real time (progress bars, status badges)
7. On complete:
   a. Sidecar written with all generation params
   b. Asset browser refreshes for active scene
   c. Matching unresolved CSV rows updated (file + duration_ms populated)
```

### State management (Zustand stores)

```typescript
// projectStore — source of truth for all project data
{
  project: Project | null
  scenes: Scene[]
  active_scene_id: string | null
  getScene: (id: string) => Scene
  updateClip: (scene_id, row_index, fields) => void  // writes CSV
}

// jobStore — generation job queue
{
  jobs: Map<string, Job>
  addJob: (job: Job) => void
  updateJob: (id: string, update: Partial<Job>) => void
}

// playbackStore — transport state
{
  is_playing: boolean
  context: "clip" | "scene" | "final"
  context_id: string | null
  position_ms: number
}

// modelStore — model load/VRAM state
{
  servers: Map<"tts"|"sfx"|"music", ServerStatus>
  vram_used_mb: number
  vram_budget_mb: number
}
```

---

## HEADLESS CLI

All operations available as CLI commands. JSON to stdout, errors to stderr.
Inference servers are auto-started when CLI is invoked headlessly.

**Exit codes:** 0 success · 1 generation failure · 2 model unavailable · 3 project not found

```bash
# Project management
pharaoh project create --title "The Reach" --llm claude
pharaoh project list
pharaoh project status [project_id]

# Story generation (LLM-driven)
pharaoh story generate [project_id]
pharaoh storyboard generate [project_id]
pharaoh storyboard rewrite [project_id]     # Chekhov's Gun continuity pass
pharaoh script generate [project_id] --scene [scene_id]

# Asset generation
pharaoh generate tts   --scene [id] --row [n]
pharaoh generate sfx   --scene [id] --row [n]
pharaoh generate music --scene [id] --row [n]
pharaoh generate all   --scene [id]           # all unresolved rows in scene

# QA workflow
pharaoh qa list       --scene [id] --status unreviewed
pharaoh qa approve    [asset_path]
pharaoh qa reject     [asset_path] --notes "too bright, try again"
pharaoh qa regenerate [asset_path]            # reads sidecar, reruns with same params

# Composition
pharaoh compose backfill  --scene [id]        # timestamp pass: populate start_ms + duration_ms
pharaoh compose render    --scene [id]
pharaoh compose render-all [project_id]
pharaoh compose final     [project_id] --crossfade 500

# Full pipeline — agent entry point
pharaoh run [project_id]                      # walks entire pyramid top to bottom
pharaoh run [project_id] --from storyboard    # resume from a specific stage
pharaoh run [project_id] --from script        # resume from script generation
pharaoh run [project_id] --from assets        # resume from asset generation
pharaoh run [project_id] --from compose       # resume from composition
pharaoh run [project_id] --scene [id]         # single scene only
```

**Pipeline stages for `pharaoh run`:**
`story → storyboard → storyboard-rewrite → script → assets → qa → backfill → compose → render → final`

Each stage checks prerequisites before running. A failed stage exits with the
appropriate code and leaves the project in a resumable state.

---

## BUILD PHASES

### Phase 1 — Foundation
- Tauri 2 scaffold with React 18 / TypeScript
- Project data model: `project.json`, `storyboard.json`, `script.csv`
- `csvParser.ts` with full read/write/update (unresolved → resolved transition)
- Rust: project CRUD commands, directory structure creation
- Static pyramid canvas (three zones, no animation yet)
- Companion `.md` files from day one (modular-docs pattern)

### Phase 2 — Inference pipeline
- Python FastAPI servers (stub endpoints first, real models second)
- Rust: spawn servers, health polling, job tracking, Tauri event emission
- Job queue frontend component with live progress
- TTS panel wired end-to-end (fastest feedback loop, smallest model footprint)
- Sidecar read/write system

### Phase 3 — Asset management
- Asset browser with waveform thumbnails (peaks via Rust)
- Right-click → Regenerate (reads sidecar, pre-fills generation panel)
- Take grouping and selection (collapsible take families)
- QA status workflow (approve/reject/flag)

### Phase 4 — Composition
- Timeline canvas with clip rectangles and embedded waveforms
- Drag/trim interactions writing back to CSV
- Backfill timestamp pass (`pharaoh compose backfill`)
- Playback bar with Web Audio API
- Per-clip controls: volume envelope, pan, reverb send

### Phase 5 — Audio engine
- ffmpeg filter_complex builder in Rust
- Per-clip normalization and resampling pipeline (everything to 48kHz)
- Scene render (idempotent)
- Auto-ducking with configurable curves
- Final concat with crossfade

### Phase 6 — CLI
- `pharaoh` CLI scaffold
- All commands wired to same Rust/Python backends
- JSON output formatting, exit codes
- `pharaoh run` full pipeline command with stage resumption

### Phase 7 — Polish
- Pyramid zoom animations (200ms ease-out)
- Agent observer mode (pulsing indicator, Take Over button)
- Model manager UI (download, VRAM, load/unload toggles)
- LLM orchestrator wiring (story/storyboard/script generation)
- Settings panel (paths, API keys, defaults, keybindings)
- Project archive and export (self-contained directory with all sources)

---

## NOTES ON MODEL INTEGRATION

### Sample rate normalization
| Model | Output SR | Action |
|-------|-----------|--------|
| Qwen3-TTS | 24kHz | Resample to 48kHz before composition |
| Woosh | 48kHz | No action needed |
| ACE-Step | 44.1kHz | Resample to 48kHz before composition |

All composition and rendering operates at 48kHz / 24-bit.

### VRAM budget guidance (approximate)
| Model | VRAM (0.6B) | VRAM (1.7B) | VRAM (XL/4B) |
|-------|-------------|-------------|--------------|
| Qwen3-TTS | ~4GB | ~6GB | — |
| Woosh | ~2GB (DFlow) | ~4GB (Flow) | — |
| ACE-Step | ~4GB | ~8GB | ~12–20GB |

The model manager should default to loading only one model at a time on
consumer hardware (<= 16GB VRAM). Users with 24GB+ can configure concurrent loading.

### Audio drama composition priorities
1. Dialogue intelligibility above everything — never let beds or music mask dialogue
2. Auto-ducking is not optional — implement from Phase 5 day one
3. Woosh output is monaural — stereo widening should be a default post-process
4. ACE-Step is for underscore and ambience, not sung dialogue — vocal quality is coarse
5. Use Repaint to fix specific sections rather than regenerating entire music cues
