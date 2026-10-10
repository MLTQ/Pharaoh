# episode_writer.rs

## Purpose
"Make me an episode of X." A series bible becomes a prompt brief; Claude pitches, plans a beat sheet, writes the episode in audio-drama Fountain and punches it up; the script lands as an ordinary episode project. Also drafts a whole bible from a paragraph about a show.

## Components

### `series_brief(series, canon)`
- **Does**: The bible as Markdown: format and length (~150 spoken words a minute), premise, world, cast (engine, want, flaw, how they talk, catchphrases capped at one use each, lazzi, never, relationships), sets with their exact headings and bed lines (`BED: #tag` when a recorded bed is linked), sound package tags, formula (or "the classic structure of a …"), style (narrator mode, house style, banned phrases), golden scenes, and the newest 24 canon entries.
- **Interacts with**: every prompt below, `pharaoh series brief`, MCP `get_series_brief`, the `series_brief_text` command.

### `Claude::ask`
- **Does**: One structured-output request to `POST /v1/messages`: `claude-opus-5-5`, adaptive thinking, an explicit effort, `output_config.format` json_schema, `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. Streamed (SSE) so long scripts don't hit HTTP timeouts; text deltas are collected, and a `fallback` content block restarts the collection (the fallback model answers from scratch). `refusal` and `max_tokens` stops are errors.
- **Rationale**: Rust has no official SDK; this mirrors `prose_script.rs`'s raw HTTP request, adding streaming.
- **Key**: `ANTHROPIC_API_KEY`, or the env var named in `WriterSettings.api_key_env`. Never logged or returned.

### Stages
- `pitch_impl` (effort medium): three loglines, different from canon.
- `plan_impl` (high): `EpisodePlan` — title, logline, synopsis, scenes (heading, set_id, act, summary, characters, beats), up to two guests with a voice description, callbacks.
- `write_impl`: plan (unless given) → write (high, 64k) → writers'-room punch-up (high; on unless `punch_up: false`) → `land_episode`. Both writing calls return `{fountain, canon}`. Emits progress through a callback (`episode-writer` events in the app, stderr in the CLI).

### `land_episode`
- **Does**: Create the episode (or reuse `episode_id`, which must belong to the series), `import_fountain`, `finish_project`, `bind_sound_cues`, write `series_episode.json` (premise, plan, script, model, tokens), and append the canon entry (replacing one for the same episode).
- **Interacts with**: `write_impl`, `pharaoh episode import`, MCP `import_series_episode`.

### `finish_project`
- **Does**: Title, logline and synopsis from the plan. Characters the import created blank get a description and a `base_voice_description`: series cast without a library voice from their description and how they talk; guests from the plan.

### `bind_sound_cues`
- **Does**: A row whose prompt starts with `#tag` takes that sound cue's prompt; if the cue has an approved file, it is copied bit-exact to `<scene>/assets/series_<tag>.wav` and bound as the row's `file`, so generation skips it and layout places it. Unknown tags lose their `#`.
- **Rationale**: Copies keep every episode self-contained and lossless; the series take can be replaced later without changing finished episodes.

### `draft_bible_impl` / `merge_bible`
- **Does**: A paragraph about the show → format, logline, premise, tone, themes, world, continuity, length, cast (with relationships by name), sets, formula, style, sound cues. Merging keeps everything the user already wrote, skips cast names already present, links relationships to cast ids, and slugs unique ids for sets and sound cues.

## Tauri commands
`series_brief_text`, `draft_series_bible`, `pitch_episodes`, `plan_episode`, `write_episode` (emits `episode-writer` {series_id, stage, message}). Generation commands are host-only on the mesh; the brief is mirrored.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `seriesStore.ts` | `write_episode({args})` → `WriteEpisodeResult`; `episode-writer` events | Shape or event changes |
| `cli/series.rs` | `pitch_impl`, `plan_impl`, `write_impl`, `land_episode`, `draft_bible_impl`, `series_brief` | Signatures |
| `cli::scene_script::import_fountain` | Fountain with INT./EXT. headings | Import semantics |
