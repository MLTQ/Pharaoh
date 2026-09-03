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

The app integrates four open-source generative models:
- **Chatterbox Turbo** (Resemble AI 0.5B) — primary dialogue model; 0-shot voice cloning from a reference WAV, inline paralinguistic tags (`[sigh]`, `[chuckle]`, etc.)
- **Qwen3-TTS** — palette reference synthesis (VoiceDesign) and legacy voice modes (CustomVoice, Clone)
- **Woosh (Sony AI)** — sound effects (text-to-audio, video-to-audio)
- **ACE-Step 1.5** — music (text2music, cover, repaint, lego, extract)

**Character voice workflow (current):**
1. Author 1–5 named *emotional states* per character (e.g. `neutral`, `sardonic`, `dread`) in the Character Designer.
2. Generate Qwen3 VoiceDesign reference takes for each state — audition and **approve** the best one as the palette reference.
3. In the script, set the `emotion` column on each DIALOGUE row to select the matching palette state.
4. Chatterbox Turbo 0-shot clones the approved reference take for every production line, preserving voice identity across all takes while emotional colouring varies per beat.

This keeps voice identity stable across all takes (Chatterbox always clones the same reference) while letting performance vary per emotional beat.

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
Pharaoh/
├── src-tauri/                  # Rust backend (Tauri 2) — also the CLI binary
│   ├── src/
│   │   ├── main.rs             # entry: args → CLI, no args → GUI
│   │   ├── lib.rs              # Tauri builder + generate_handler! (78 commands)
│   │   ├── models.rs           # every serialized type + AppState
│   │   ├── app_support.rs      # paths, project/script I/O, wav_info, asset binding
│   │   ├── fountain.rs         # Fountain parse/serialize
│   │   ├── share.rs            # Gruve share server (static + HTTP command mirror)
│   │   ├── error.rs
│   │   ├── integration_tests.rs
│   │   ├── commands/           # the Tauri command surface, one module per domain
│   │   │   ├── project.rs   script.rs     sidecar.rs
│   │   │   ├── audio.rs     audio_engine.rs  audio_spatial.rs  audio_enhance.rs
│   │   │   ├── inference.rs corpus.rs     rvc.rs      character.rs
│   │   │   ├── llm.rs       settings.rs   setup.rs    setup_check.rs
│   │   │   └── recording.rs archive.rs
│   │   └── cli/                # headless subcommands
│   │       ├── mod.rs          # arg parsing + usage()
│   │       ├── project.rs   scene_script.rs  character.rs
│   │       ├── generate.rs  generate_scene.rs  compose.rs
│   │       └── asset_post.rs llm.rs        helpers.rs  server_setup.rs
│   └── Cargo.toml
│
├── inference/                  # Python inference servers (FastAPI)
│   ├── _common.py              # shared job store, path remap, /upload, /files
│   ├── tts_server.py           # 18001 — Qwen3-TTS
│   ├── sfx_server.py           # 18002 — Woosh + AudioLDM
│   ├── music_server.py         # 18003 — ACE-Step
│   ├── post_server.py          # 18004 — AudioSR
│   ├── chatterbox_server.py    # 18005 — Chatterbox clone
│   ├── rvc_server.py           # 18006 — RVC convert/train (Applio workers)
│   ├── setup.sh  start_servers.sh  download_spatial_assets.sh
│   └── requirements*.txt
│
├── servers/mcp/                # MCP control plane (18000) — agent surface
│   ├── run.py                  # entry point; stdio or SSE
│   ├── server.py config.py projectfs.py remote.py resources.py
│   └── tools_*.py              # 49 registered tools
│
├── src/                        # React/TypeScript frontend
│   ├── App.tsx main.tsx styles.css
│   ├── store/                  # projectStore jobStore modelStore audioStore
│   │                           # uiStore toastStore peaksStore regenerateStore
│   │                           # renderMetaStore
│   ├── lib/                    # transport tauriCommands types fountain
│   │                           # assetRouting storyShape scenePips errors
│   │                           # gruveCollab flush
│   ├── hooks/useGenerateJob.ts
│   └── components/
│       ├── pyramid/            # PyramidView StoryBibleView StoryShapeView
│       ├── timeline/           # CompositionView FountainEditor ScriptCanvas
│       │                       # SpatializeModal TakesPopover
│       ├── generators/         # TTSPanel SFXPanel MusicPanel RichDirector
│       ├── characters/         # CharacterDesignerView CorpusBuilder RvcModelStage
│       ├── library/            # LibraryView + voice/palette/corpus tabs
│       ├── post/               # ClipStudioView FinalAssemblyView
│       ├── launcher/ models/ settings/ upscale/ shared/
│
├── tests/                      # pytest over the Python side
├── scripts/                    # check-invoke-commands.mjs
├── assets/                     # spatial IR catalog + SOFA HRTF (downloaded)
├── gruve/                      # Gruve mesh integration kit + JS SDK
└── docs/voice-pipeline.md
```

Projects live outside the repo, under `projects_dir` (default
`~/pharaoh-projects`):

```
[project-id]/
├── project.json
├── storyboard.json
├── characters/[character_id]/     # voice refs, rvc_corpus/, rvc/
├── scenes/[scene_slug]/
│   ├── script.csv
│   ├── script.fountain
│   ├── assets/*.wav + *.wav.meta.json
│   └── render/render.wav
└── output/final.wav
```

Every code file has a companion `.md` describing intent, contracts and
rationale (the modular-docs pattern).

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
        "model": "Chatterbox | CustomVoice | VoiceDesign | Clone | FineTuned",
        "speaker": null,
        "instruct_default": "tired, edge of tears",
        "ref_audio_path": null,
        "ref_transcript": null,
        "base_voice_description": "A female voice, late 30s, British-Nigerian...",
        "emotional_palette": [
          {
            "emotion": "neutral",
            "label": "Neutral",
            "direction": "Controlled, professional. Holding something back.",
            "ref_audio_path": "/path/to/characters/CHAR_MIRA/palette/neutral_7.wav",
            "ref_transcript": null,
            "qa_status": "approved"
          },
          {
            "emotion": "dread",
            "label": "Dread",
            "direction": "The control is cracking. Almost private.",
            "ref_audio_path": null,
            "ref_transcript": null,
            "qa_status": "unreviewed"
          }
        ]
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
      "status": "draft | generating | assets_ready | composed | rendered",
      "tension": 0.73
    }
  ]
}
```

**`tension`** — authored dramatic tension, `0.0`–`1.0`, drives the story-shape
view. `null` (or absent, in storyboards written before the field existed) means
**unshaped**: the writer has not placed this scene on the curve. Never coerce
it to `0.0`, which is an authored trough — the distinction is what lets a
writer shape three scenes and leave the rest alone without the view asserting a
valley they never drew.

### script.csv

One row per audio event. This is the core working document for each scene.

22 columns, in this order (matching the `ScriptRow` struct in `models.rs` and
`SCRIPT_FIELDS` in the MCP server's `projectfs.py` — all three must agree):

```
scene,track,type,character,prompt,file,start_ms,duration_ms,loop,pan,gain_db,
instruct,fade_in_ms,fade_out_ms,reverb_send,emotion,notes,gain_envelope,
spatial_azimuth,spatial_elevation,spatial_path,spatial_space
```

**Field notes:**
- `type`: `DIALOGUE | SFX | BED | MUSIC | DIRECTION`
- `file`: empty string = unresolved; populated = resolved asset path
- `start_ms`: empty = unresolved (pre-backfill); integer = placed on timeline
- `duration_ms`: auto-populated from the WAV header when `file` is assigned; never set manually
- `loop`: `true` for beds and continuous ambience tracks
- `pan`: L/R amplitude pan, clamped to `-1.0`–`1.0` by the render graph
- `reverb_send`: 0.0–1.0 wet send amount
- `emotion`: palette emotion key (e.g. `neutral`, `sardonic`); selects which reference take Chatterbox clones; empty = first palette entry
- `notes`: free text, and the home of the `id:r-xxx` tag that lets the Fountain editor keep row identity across edits
- `gain_envelope`: `ms:db` breakpoints for the per-clip gain lane, empty = flat
- `spatial_azimuth` / `spatial_elevation`: degrees; azimuth 0 = front, 90 = right, 180 = behind. Empty = not spatialized (the clip uses `pan` instead)
- `spatial_path`: JSON waypoint list for a moving source, empty = static
- `spatial_space`: room IR slug from `assets/spaces/spaces.json`, empty = anechoic
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

Six persistent FastAPI servers, one per model family, plus the MCP control
plane. They are started out of band by `./inference/start_servers.sh` — the Rust
backend does not spawn them, it only health-polls and drives them over HTTP.
Model weights load once; subsequent generations pay only inference cost.

### Ports (configurable in Settings, or `pharaoh server config-set`)

| Server      | Default port | Models |
|-------------|--------------|--------|
| MCP         | 18000        | none — agent control plane, proxies to the rest |
| TTS         | 18001        | Qwen3-TTS CustomVoice / VoiceDesign / VoiceClone |
| SFX         | 18002        | Woosh (short foley), AudioLDM (long ambience) |
| Music       | 18003        | ACE-Step |
| Post        | 18004        | AudioSR upscale |
| Chatterbox  | 18005        | Chatterbox clone |
| RVC         | 18006        | Applio convert + train |

### Common endpoints (every generation server)

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

### MCP server — port 18000

AI agent control plane. Exposes the full Pharaoh pipeline to any MCP-capable
client (Claude Desktop, Claude Code agents) without requiring the Tauri GUI.

Lives at `servers/mcp/run.py`. Runs in one of two transport modes:
- **stdio** — for Claude Desktop and direct agent integration (default)
- **sse** — for network clients; spawned by the Rust backend alongside inference servers

Does not load any ML models. Reads project/scene/script state directly from
the filesystem and proxies generation requests to ports 18001–18004.

**MCP resources** (read-only, no auth required):

```
pharaoh://projects                              list of all projects
pharaoh://projects/{id}                         project.json
pharaoh://projects/{id}/storyboard              storyboard.json
pharaoh://projects/{id}/scenes/{slug}/script    script.csv as JSON array
pharaoh://projects/{id}/scenes/{slug}/assets    assets + QA status + metadata
pharaoh://projects/{id}/pipeline                per-scene per-stage completion matrix
```

**MCP tools:**

```
── Project & script ──────────────────────────────────────────────────────────
project_status        { project_id }                        → stage completion matrix
read_script           { project_id, scene_slug }            → script rows as JSON
update_script_row     { project_id, scene_slug, row_index, updates }

── Generation ────────────────────────────────────────────────────────────────
generate_tts          { project_id, scene_slug, row_index, output_path, ... }
                      Auto-routes to Chatterbox when character model=="Chatterbox"
                      and row has a non-empty emotion field. No extra params needed.
                      Falls back to Qwen3 VoiceDesign/Clone/CustomVoice otherwise.
                      → job_id

generate_chatterbox   { project_id, scene_slug, row_index, output_path,
                        ref_audio_path?, emotion?, exaggeration?, cfg_weight?, seed? }
                      Direct Chatterbox Turbo call. ref_audio_path auto-resolves
                      from emotional palette if omitted.
                      → job_id

generate_sfx          { project_id, scene_slug, row_index, output_path, ... } → job_id
generate_music        { project_id, scene_slug, row_index, output_path,
                        batch_size }                        → job_id | job_id[]

── Emotional palette (character voice identity) ──────────────────────────────
generate_palette_take { project_id, character_id, emotion, direction,
                        test_line, seed? }
                      Generate a Qwen3 VoiceDesign reference take for one palette
                      slot. Combines base_voice_description + direction automatically.
                      Saves to characters/{id}/palette/{emotion}_{seed}.wav.
                      → { job_id, output_path }

approve_palette_take  { project_id, character_id, emotion, audio_path }
                      Lock a palette take as the reference for this emotion.
                      Sets voice_assignment.model = "Chatterbox" if not already set.

list_character_palette { project_id, character_id }
                      → all palette entries with qa_status and ref_audio_path

── Jobs & QA ─────────────────────────────────────────────────────────────────
job_status            { server, job_id }                    → status, progress, output_path
wait_for_job          { server, job_id, timeout_seconds }   → blocks until done
list_assets           { project_id, scene_slug, qa_status? } → asset list
qa_approve            { audio_path, notes? }
qa_reject             { audio_path, notes }
regenerate_asset      { audio_path, output_path? }          → job_id
unload_model          { server }

── Composition ───────────────────────────────────────────────────────────────
server_health         { server? }                           → health for all or one
compose_scene         { project_id, scene_slug }            → render.wav path
render_final          { project_id, crossfade_ms? }         → final.wav path
```

**Typical agent workflow for a new character:**
```python
# 1. Design the base voice
generate_palette_take(project_id, "CHAR_MIRA", "neutral",
    direction="Warm but controlled. Professional mask over suppressed fear.",
    test_line="I knew what they'd find before they opened the door.")

# 2. Audition takes (different seeds), approve the best one
approve_palette_take(project_id, "CHAR_MIRA", "neutral", "/path/neutral_7.wav")

# 3. Generate production lines — routing is automatic
generate_tts(project_id, "s01_the_office", row_index=3, output_path="mira_01.wav")
# → Chatterbox clones neutral_7.wav; no explicit ref_audio_path needed
```

**Claude Desktop configuration** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pharaoh": {
      "command": "python",
      "args": [
        "/path/to/Pharaoh/servers/mcp/run.py",
        "--projects-dir", "/path/to/pharaoh-projects"
      ]
    }
  }
}
```

**GET /health** (SSE mode only) — returns `{ status, model_loaded, model_variant, vram_mb }`
so the Rust model_manager can include it in the `AllServerHealth` poll.

---

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

### Chatterbox server — port 18005

Wraps Chatterbox Turbo (Resemble AI, 0.5B). Primary dialogue synthesis engine.
Lives at `inference/chatterbox_server.py`. Isolated venv: `inference/.venv-chatterbox`.

```
POST /generate/clone
     body: { text, ref_audio_path, ref_transcript?, exaggeration?, cfg_weight?,
             temperature?, seed?, output_path, job_id? }

POST /load / POST /unload
GET  /health
GET  /jobs/{job_id}
```

**Key parameters:**
- `text`: dialogue text, may include inline paralinguistic tags: `[sigh]`, `[chuckle]`, `[laugh]`, `[gasp]`, etc.
- `ref_audio_path`: the approved palette `.wav` — sets the vocal identity to clone
- `exaggeration`: 0–1; how strongly to colour the performance toward the reference take's style (default 0.5)
- `cfg_weight`: classifier-free guidance strength (default 0.5)
- `ref_transcript`: optional; Chatterbox Turbo doesn't require it

**Important:** `ref_audio_path` must be a **clean, isolated voice sample** (no music, SFX, or reverb). Use Qwen3 VoiceDesign palette takes for this, not scene audio. The palette workflow exists specifically to produce clean reference material.

**Sidecar:** written to `{output}.meta.json` with `model="chatterbox-turbo"`, `parent=ref_audio_path`. The `parent` field is the lineage link back to the palette take used.

**Known gotchas:**
- Venv is isolated from TTS venv (different torch pin). Never install into the same env.
- Cloning quality degrades sharply on references shorter than 3 seconds or longer than 15 seconds.
- On first load, downloads ~1GB of weights from HuggingFace. Subsequent starts are instant.
- VRAM: ~3GB at 0.5B.

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

> Command inventory below is generated from `generate_handler!` in
> `src-tauri/src/lib.rs` (78 commands). Run `npm run check:commands` to verify
> the frontend never calls a name that is not registered there.

### Module map

| Module | Responsibility |
|--------|----------------|
| `app_support.rs` | Paths, project/script/JSON I/O, voice-path relativize/absolutize, `wav_info`, asset→row binding |
| `models.rs` | Every serialized type plus `AppState` |
| `commands/project.rs` | Project and scene CRUD, on-load migration |
| `commands/script.rs` | `script.csv` and `script.fountain` read/write |
| `commands/sidecar.rs` | `.meta.json` read/write, takes, QA status, asset listing |
| `commands/audio.rs` | Waveform peaks (full + windowed), duration, zero crossings |
| `commands/audio_engine.rs` | ffmpeg `filter_complex` builder, clip processing, scene and episode render |
| `commands/audio_spatial.rs` | HRTF/binaural prerender, room IR catalog |
| `commands/audio_enhance.rs` | AudioSR upscale proxy |
| `commands/inference.rs` | Server health, model load/unload, generation job submit + poll |
| `commands/corpus.rs` | Chatterbox corpus build for RVC training (stage 3) |
| `commands/rvc.rs` | RVC convert/train proxies, corpus and model status (stage 4) |
| `commands/character.rs` | Character library: save, import, export, corpus import |
| `commands/llm.rs` | Anthropic scene drafting and storyboard review |
| `commands/settings.rs` | App config and aggregate server health |
| `commands/setup.rs`, `setup_check.rs` | Installer invocation and integrity checks |
| `commands/recording.rs` | CPAL input capture |
| `commands/archive.rs` | Project zip export |
| `share.rs` | Gruve share server: static frontend, HTTP mirror of the command surface, Range-aware `/file` |
| `fountain.rs` | Fountain parse/serialize |

There is no `model_manager.rs` or `ipc.rs`. VRAM is not budgeted or LRU-offloaded
in Rust; each inference server reports its own `vram_mb` from `/health`, and
`settings::get_server_health_all` aggregates the seven servers for the status
bar. Model load/unload is explicit, driven from the Models view.

### audio_engine.rs

Builds and executes ffmpeg `filter_complex` graphs from a scene's `script.csv`.
Renders are idempotent — the same rows and assets produce the same output.

```rust
// Per-clip processing: trim, gain, fades, filters. Writes a child asset.
process_clip_asset(app, params: ClipProcessParams) -> Result<String>

// Loudness normalization to a target LUFS
normalize_clip(app, input_path: String, target_lufs: Option<f32>) -> Result<String>

// Everything lands at 48kHz (Qwen3-TTS emits 24kHz)
resample_to_48k(input_path: String, output_path: String) -> Result<()>

// Read script.csv, build filter_complex, write scenes/<slug>/render/render.wav
render_scene(app, project_id, scene_slug, target_lufs: Option<f32>) -> Result<String>

// Concatenate scene renders into output/final.wav
render_episode(app, project_id, crossfade_ms, target_lufs) -> Result<String>
```

Ducking is applied inline as a `sidechaincompress` stage in the scene graph
rather than a separate pass. Spatialized rows are prerendered to binaural
intermediates by `audio_spatial.rs` before the main graph runs.

### sidecar.rs

```rust
// Atomic write: write to .tmp, then rename (prevents partial writes)
write_sidecar(audio_path: String, meta: SidecarMeta) -> Result<()>
read_sidecar(audio_path: String) -> Result<Option<SidecarMeta>>

// All takes for a base filename, ordered by take_index
get_takes(base_audio_path: String) -> Result<Vec<GeneratedAudioAsset>>

// QA workflow
update_sidecar_qa(audio_path: String, status: String, notes: String) -> Result<()>
```

`app_support::write_json`, `write_script_rows`, the sidecar writer and the
fountain writer all use temp-file + rename, so a crash mid-write never leaves a
truncated project file.

### Job lifecycle (Rust side)

`commands/inference.rs` submits to the relevant Python server, gets a `job_id`
back, and spawns a poll task per job. On completion it writes the sidecar, then
calls `app_support::bind_generated_asset`, which claims a script row only when
that row's `file` is empty **and** the row's `type` matches the asset kind
(speech→DIALOGUE, score→MUSIC, foley→SFX/BED). Progress, completion and failure
are emitted to the frontend as `job-progress` / `job-complete` / `job-failed`.

## FRONTEND

### Shell — App.tsx

The app is organised as *workspaces* (left rail) rather than a zooming pyramid.
`WORKSPACE_OF` in `lib/types.ts` maps each `ViewId` to its workspace; `App.tsx`
renders the rail, a per-workspace sidebar, the scene sub-tab strip, the active
view, and the transport bar.

### pyramid/PyramidView.tsx

The project overview: story bible at the apex, scene cards below, episode
timeline at the base. It has a `plates | shape` toggle (the second is
`StoryShapeView`, a per-scene tension curve) and scales to fit — there is no
zoom state machine and no animated drill-down.

### timeline/CompositionView.tsx

The scene workspace, in two modes:

- **Write** — `FountainEditor`, a Fountain source editor whose blocks compile
  back to `script.csv` rows. Row identity survives edits via an `id:` tag tucked
  into the row's `notes`.
- **Direct/Mix** — a canvas timeline of clip rectangles with embedded waveforms,
  drag/trim, per-clip gain lanes, pan, spatial placement and render.

Peaks are rendered by `shared/atoms.tsx` (`PeaksWave` / `Wave`), backed by the
`peaksStore` cache over the Rust `get_waveform_peaks` and `get_window_peaks`
commands. There is no separate `Timeline.tsx` or `WaveformCanvas.tsx`.

### Transport — lib/transport.ts

Every command call goes through `invoke()` here, which dispatches to Tauri IPC
in the desktop app and to `POST /invoke/{cmd}` on the share server for mesh
viewers in a browser. `lib/tauriCommands.ts` holds the typed wrappers.

Mesh viewers reach a deliberately narrower surface: reads are always allowed,
mutations are gated behind the host's `share_collab` flag, and host-only
commands (config writes, filesystem imports/exports, recording, library
deletion) are not mirrored at all.

### Job lifecycle

1. A panel calls a `submit_*` command and gets a `job_id`.
2. `jobStore` adds the job as `running` and renders it in the queue.
3. Rust polls the Python server and emits `job-progress` events.
4. On `job-complete` the store marks the job done, refreshes the scene's asset
   list, and fetches peaks for the new file.
5. Rust has already written the sidecar and, when the target row is empty and
   type-compatible, bound the asset to it.

### State management (Zustand stores)

```typescript
// projectStore — project, scenes, characters, and the active scene
{
  realProject: Project | null
  realScenes: Scene[]
  realProjectId: string | null
  activeSceneSlug: string | null
  projectsDir: string
  characters: Character[]
  reloadProjectFromDisk: () => Promise<void>
}

// jobStore — generation job queue (an array, not a Map)
{
  jobs: Job[]
  activeTakes: Record<string, string>
  initListeners: () => Promise<() => void>   // no-op outside Tauri
}

// modelStore — per-kind load status and health
{
  status: Record<ModelKind, ModelStatus>
  health: Record<ModelKind, ServerHealth | null>
  loadProgress: Record<ModelKind, number>
}

// audioStore    — single-element playback and transport position
// uiStore       — active view, workspace, modal state
// toastStore    — transient notifications
// peaksStore    — waveform peak cache keyed by path + resolution
// regenerateStore — hand-off of sidecar params into a generator panel
// renderMetaStore — LUFS/peak readout for the current render
```

There is no `playbackStore` — transport state lives in `audioStore`.

## HEADLESS CLI

The same binary is the GUI and the CLI: `pharaoh <args>` runs headless, no args
opens the window. JSON goes to stdout, errors to stderr.

Composition and render go through the same `commands::*` functions the Tauri
surface uses. Several other areas (asset listing, project listing, scene and
fountain creation, per-scene generation) still carry their own copies in `cli/`,
which have drifted from the GUI paths — see Pharaoh-20kp.

**Exit codes:** 0 success, 1 failure. (The finer-grained 2 = model unavailable /
3 = project not found split described in earlier drafts is not implemented —
`main.rs` exits 1 on any error.)

Inference servers are **not** auto-started; run `./inference/start_servers.sh`
first, or point the CLI at remote servers with `pharaoh server config-set`.
Lifecycle commands are tracked as Pharaoh-wnf.

```bash
  pharaoh project list
  pharaoh project status <project_id>
  pharaoh project create --title <title> [--logline <text>] [--tone <text>]
  pharaoh project update <project_id> [--title <text>] [--synopsis <text>] [--tone <text>]
  pharaoh project archive <project_id> [--output <path>]
  pharaoh scene list <project_id>
  pharaoh scene get <project_id> <scene_slug_or_id>
  pharaoh scene create <project_id> --title <title> [--slug <slug>] [--index <n>]
  pharaoh scene update <project_id> <scene_slug_or_id> [--status draft|generating|assets_ready|composed|rendered]
  pharaoh script read <project_id> <scene_slug>
  pharaoh script write <project_id> <scene_slug> <script.csv|script.json>
  pharaoh script fountain-read <project_id> <scene_slug>
  pharaoh script fountain-write <project_id> <scene_slug> <script.fountain|-> [--compile true|false]
  pharaoh script update-row <project_id> <scene_slug> <row_index> [--prompt <text>] [--instruct <text>] [--file <path>]
  pharaoh script spatialize <project_id> <scene_slug> <row_index> [--azimuth <deg>] [--elevation <deg>] [--path <json>] [--space <slug>] [--wet <0-1>] [--clear]
  pharaoh script import <project_id> <fountain_file> [--dry-run] [--prefix <slug-prefix>] [--start-index <n>] [--character-prefix CHAR_]
  pharaoh character list <project_id>
  pharaoh character create <project_id> --name <name> [--description <text>]
  pharaoh character update <project_id> <character_id> [--name <name>] [--description <text>]
  pharaoh character delete <project_id> <character_id>
  pharaoh character voice-set <project_id> <character_id> [--model CustomVoice|VoiceDesign|VoiceClone] [--instruct <text>]
  pharaoh character voice-design-test <project_id> <character_id> --voice-description <text> [--text <text>]
  pharaoh character voice-clone-test <project_id> <character_id> --ref-audio-path <wav> [--text <text>]
  pharaoh server health [tts|sfx|music|post|all]
  pharaoh server config
  pharaoh server config-set [--tts-url <url>] [--sfx-url <url>] [--music-url <url>] [--post-url <url>]
  pharaoh model load <tts|sfx|music|post> [--variant <name>]
  pharaoh model unload <tts|sfx|music|post>
  pharaoh asset list <project_id> [--kind tts|sfx|music] [--scene <slug>]
  pharaoh asset meta <audio_path>
  pharaoh asset qa <audio_path> --status <status> [--notes <text>]
  pharaoh asset takes <audio_path>
  pharaoh asset use <project_id> <scene_slug> <row_index> <audio_path>
  pharaoh generate tts-custom --text <text> --output-path <wav> [--speaker <name>] [--instruct <text>]
  pharaoh generate tts-design --text <text> --voice-description <text> --output-path <wav>
  pharaoh generate tts-clone --text <text> --ref-audio-path <wav> --output-path <wav>
  pharaoh generate sfx --prompt <text> --output-path <wav> [--backend woosh|audioldm] [--model-variant <name>] [--duration-seconds <n>] [--steps <n>] [--seed <n>] [--cfg-scale <n>] [--guidance-scale <n>] [--negative-prompt <text>] [--num-waveforms-per-prompt <n>]
  pharaoh generate music --caption <text> --output-path <wav> [--lyrics <text>] [--duration-seconds <n>] [--bpm <n>] [--key <key>] [--language <code>] [--lm-model-size <name>] [--diffusion-steps <n>] [--thinking-mode true|false] [--reference-audio-path <wav>] [--seed <n>] [--batch-size <n>]
  pharaoh compose render scene <project_id> <scene_slug>
  pharaoh compose meta <render_wav>
  pharaoh compose final <project_id> [--crossfade <ms>] [--target-lufs <n>]
  pharaoh llm draft-scene <project_id> <scene_slug> [--model <name>] [--api-key-env <var>] [--write-fountain true|false] [--compile true|false]
  pharaoh storyboard review <project_id> [--model <name>] [--api-key-env <var>]
  pharaoh storyboard rewrite <project_id> [--model <name>] [--api-key-env <var>]
  pharaoh audio peaks <audio_path> <num_peaks>
  pharaoh audio duration <audio_path>
  pharaoh audio zero-crossings <audio_path> <near_ms>
  pharaoh post import <project_id> <source_audio> [--label <text>]
  pharaoh post process <input_wav> [--start-ms <n>] [--end-ms <n>] [--gain-db <n>] [--fade-in-ms <n>] [--fade-out-ms <n>] [--fade-in-curve tri|qsin|qua] [--fade-out-curve tri|qsin|qua]
  pharaoh post normalize <input_wav> [--target-lufs -16]
  pharaoh post resample <input_wav> <output_wav>
  pharaoh post upscale <input_wav> [--model basic|speech] [--steps 50] [--guidance 3.5] [--seed 0]
  pharaoh setup status
  pharaoh setup hardware
  pharaoh generate row scene <project_id> <scene_slug> <row_index>
  pharaoh generate all scene <project_id> <scene_slug>
```

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
| Model            | VRAM (small)    | VRAM (large)  |
|------------------|-----------------|---------------|
| Chatterbox Turbo | ~3GB (0.5B)     | —             |
| Qwen3-TTS        | ~4GB (0.6B)     | ~6GB (1.7B)   |
| Woosh            | ~2GB (DFlow)    | ~4GB (Flow)   |
| ACE-Step         | ~4GB (base)     | ~12–20GB (XL) |

The model manager should default to loading only one model at a time on
consumer hardware (<= 16GB VRAM). Users with 24GB+ can configure concurrent loading.

### Audio drama composition priorities
1. Dialogue intelligibility above everything — never let beds or music mask dialogue
2. Auto-ducking is not optional — implement from Phase 5 day one
3. Woosh output is monaural — stereo widening should be a default post-process
4. ACE-Step is for underscore and ambience, not sung dialogue — vocal quality is coarse
5. Use Repaint to fix specific sections rather than regenerating entire music cues
