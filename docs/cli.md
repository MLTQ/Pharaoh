# Pharaoh CLI

`pharaoh` is the app's headless front door. It is the same Rust code the
desktop app runs, reading and writing the same project folders, so anything
you do here shows up in the app (and the reverse). It is what agents use for
end-to-end work — rebuilds, cast cleanup, generating whole scenes, layout,
renders — and what most testing is done with.

For the MCP server (the other agent surface) see [mcp.md](mcp.md); the table
at the end of that page compares the two.

## Running it

```bash
cd src-tauri && cargo build          # debug build → src-tauri/target/debug/pharaoh
src-tauri/target/debug/pharaoh --help
```

`cargo test` does not rebuild the binary; run `cargo build` after changing
CLI code. The release app bundle carries the same binary.

**Where it looks.** Projects live in the app's projects folder (default
`~/pharaoh-projects`); server URLs come from the app's config
(`~/Library/Application Support/ai.aureum.pharaoh/config.json` on macOS).
`pharaoh server config` shows both; `pharaoh server config-set` changes the
URLs. Every command prints JSON, so output can be piped to `jq`.

**Remote servers.** When a server URL isn't localhost the CLI uploads input
files and downloads results itself — reference clips, takes, RVC models,
training corpora — so the Mac and the GPU box don't need a shared disk.

**Rights.** Commands that reproduce or clone performances from a recording
(`dissect assign`, `dissect rebuild`) refuse to run without
`--confirm-rights yes`.

## Commands

### Projects, scenes, scripts

| Command | What it does |
|---|---|
| `project list` | All projects with their casts. |
| `project status <project>` | Scenes, rows, generated/missing counts. |
| `project create --title <t> [--logline] [--tone]` | New empty project. |
| `project update <project> [--title] [--synopsis] [--tone]` | Edit metadata. |
| `project archive <project> [--output <path>]` | Zip a project. |
| `scene list <project>` / `scene get <project> <slug\|id>` | Scenes. |
| `scene create <project> --title <t> [--slug] [--index] [--act <name>]` | New scene; `--act` puts it in an act (its own row on the Pyramid). |
| `scene update <project> <slug\|id> [--status …] [--act <name>]` | `--act ""` clears the act. |
| `script read <project> <slug>` | The scene's rows (script.csv) as JSON. |
| `script write <project> <slug> <file.csv\|file.json>` | Replace the rows. |
| `script fountain-read <project> <slug>` | The scene's Fountain text. |
| `script fountain-write <project> <slug> <file\|-> [--compile true]` | Write Fountain and (by default) compile it into rows. Character cues are matched to the cast by name; a name ending in a parenthetical ("Percey Weasley (GOF)") also matches its bare cue. |
| `script import <project> <file.fountain> [--dry-run] [--prefix] [--start-index] [--character-prefix CHAR_]` | Whole screenplay → scenes (one per INT./EXT. heading). `# Act One` section headings set each scene's act. New speakers become characters. |
| `script update-row <project> <slug> <row> [--prompt] [--instruct] [--file]` | Edit one row. |
| `script spatialize <project> <slug> <row> [--azimuth] [--elevation] [--path <json>] [--space <slug>] [--wet] [--clear]` | Binaural placement. |
| `script layout <project> <slug> [--replace true] [--gap-ms 350] [--lead-in-ms 1500]` | Place generated rows on the timeline in script order: lines with a short gap, effects where cued, beds under the whole scene (looped), music from its cue. Rows already placed keep their place unless `--replace true`. |

### Characters, the Library, and casts

| Command | What it does |
|---|---|
| `character list <project>` | The project's cast. |
| `character create <project> --name <n> [--description]` | Project-only character. |
| `character update <project> <id> [--name] [--description]` | Edit. |
| `character delete <project> <id>` | Remove from the project. |
| `character voice-set <project> <id> [--model …] [--instruct]` | Voice assignment. |
| `character voice-design-test …` / `voice-clone-test …` | One-off test takes. |
| `library list` | Library characters. |
| `library add-to-project <project> <library_id> [--name]` | Copy a Library character into a project (linked). |
| `library export <library_id> --output <file> [--include-corpus true]` | One character as `.pharaoh-character`. |
| `library import <file>` | A `.pharaoh-character` into the Library (always a new entry). |
| `library fix-transcripts` | Re-check every gold clip's transcript with Whisper and fix mismatches (Breeze needs them exact). |
| `cast matches <project>` | Unnamed rebuild voices ("Speaker 9") that are the same dissected speaker as a named character. |
| `cast merge <project> <into_id> <from_id>…` | Move every line of the `from` characters onto `into` (script rows, Fountain cues, scene casts) and remove them; their audio stays on disk. |
| `cast merge <project> --matches` | Merge every pair `cast matches` lists. |
| `cast export <project> --output <file.pharaoh-cast> [--characters <id,id>] [--include-corpus true]` | A cast pack: every character (or the listed ones) with voice references, palette and voice-lock model. |
| `cast import <project> <file>…` | Any mix of `.pharaoh-cast` packs and `.pharaoh-character` files. Clashing names get "(2)"; a file that fails is reported and the rest still import. A character file exported from this machine's Library links that entry instead of duplicating it. |

### Voices from a recording (dissect)

| Command | What it does |
|---|---|
| `dissect run <audio> [--separate] [--max-candidates] [--chunk-minutes] [--wait]` | Separate, diarize and transcribe a recording; scores each line's emotion. |
| `dissect list` / `status <import>` / `cancel` / `retry` / `delete` | Manage imports. |
| `dissect assign <import> <speaker> --clips <S1_c1,…> [--gold] (--name <new> \| --library-id <id>) --confirm-rights yes [--performer] [--project]` | Name a speaker: makes (or adds to) a Library character, which later rebuilds of this import use. |
| `dissect emotions <import>` | Run emotion tagging on an existing import. |
| `dissect clips <import> <speaker[,speaker]> <emotion> [--limit 8] [--like <clip>]` | A speaker's best clips for an emotion, or the clips most like a given one. |
| `dissect palette <library_id> [--per 4] [--replace true]` | Fill a Library character's emotional palette from its real lines. |
| `dissect corpus <library_id> [--minutes 15]` | Fill its voice-lock training corpus from its real lines. |
| `dissect rebuild <import> --confirm-rights yes [--title] [--chapters 0,2] [--plan true] [--sounds] [--remainders]` | Turn the recording into a project. Speakers named with `dissect assign` come in as their Library characters (linked, with palette); speakers named as one character fold together. `--plan true` previews without building. |

### Generation

| Command | What it does |
|---|---|
| `generate row scene <project> <slug> <row>` | Generate one script row the way the app would: dialogue through Breeze (clone + the line's direction, take-checked by Whisper), voice lock on calm lines if the character has it on, SFX/beds through the SFX server's default engine (MOSS-SoundEffect v2, ≤30 s), music through YuE2. Binds the take to the row. |
| `generate all scene <project> <slug>` | Every row without audio. |
| `generate tts-clone --text --ref-audio-path --output-path [--ref-transcript] [--instruct <direction>] [--cfg-scale 4]` | One-off Breeze clone with direction. |
| `generate tts-custom …` / `tts-design …` | Preset speaker / voice design. |
| `generate sfx --prompt --output-path [--backend moss\|woosh\|audioldm] [--duration-seconds] [--seed] …` | One-off effect. With no `--backend` the server picks (MOSS where installed). |
| `generate music --caption --output-path [--duration-seconds] [--bpm] [--key] [--instrumental] …` | One-off cue. |

### Mixing, post, export

| Command | What it does |
|---|---|
| `compose render scene <project> <slug>` | Render a scene (loudness-normalised mix of placed rows; loops beds, ducks under dialogue). |
| `compose final <project> [--crossfade] [--target-lufs]` | Join rendered scenes. |
| `compose m4b <project> --output <file.m4b> [--cover] [--author] [--narrator] [--bitrate]` | Audiobook with chapters. |
| `compose meta <render.wav>` | A render's metadata. |
| `post import / process / normalize / resample / upscale …` | Clip import, trims/fades/gain, loudness, resampling, AudioSR. |
| `asset list / meta / qa / takes / use …` | Browse generated audio, mark QA, put a take on a row. |
| `audio peaks / duration / zero-crossings …` | Waveform helpers. |
| `llm draft-scene <project> <slug> …` / `storyboard review\|rewrite <project>` | LLM drafting and story review. |

### Servers and setup

| Command | What it does |
|---|---|
| `server health [tts\|sfx\|music\|post\|dissect\|all]` | Each server's health JSON (engine, loaded models, VRAM). |
| `server config` / `server config-set [--tts-url] [--sfx-url] [--music-url] [--post-url] [--dissect-url]` | Server URLs. |
| `model load <kind> [--variant]` / `model unload <kind>` | Warm or free a server's model. |
| `setup status` / `setup hardware` | What's installed; what this machine can run. |

## Typical agent workflows

**Clean up a rebuilt project's cast**
```bash
pharaoh cast matches <project>          # review the pairs
pharaoh cast merge <project> --matches  # merge them all
pharaoh cast merge <project> <named_id> <speaker_id>   # one by hand
```

**Write and voice a scene**
```bash
pharaoh scene create <project> --title "The Bell" --act "Act One"
pharaoh script fountain-write <project> 00_the_bell scene.fountain
pharaoh generate all scene <project> 00_the_bell
pharaoh script layout <project> 00_the_bell
pharaoh compose render scene <project> 00_the_bell
```

**Move a cast to another project**
```bash
pharaoh cast export <from_project> --output cast.pharaoh-cast
pharaoh cast import <to_project> cast.pharaoh-cast more.pharaoh-character
```

## What the CLI doesn't do (yet)

- Train a voice-lock (RVC) model — that's in the app's Model tab (the MCP
  `train_rvc_model` tool exists but assumes the RVC server shares this
  machine's disk; issue Pharaoh-dvc1).
- Generate or approve individual palette takes (MCP `generate_palette_take`,
  `approve_palette_take`; or the app's Palette tab).
- Rate takes (the app's Compare takes panel stores ratings in
  `scenes/<slug>/take_ratings.json`).
