# layout.rs

## Purpose
Place a scene's generated rows on the timeline so it can render. The renderer only mixes rows with a `start_ms`, and only hand-placement in the Composition view used to assign one, so a scene scripted and generated from the CLI or the agent couldn't render.

## Components

### `layout_scene` / `layout_scene_rows` / `pharaoh script layout`
- **Does**: In script order: lines one after another (`gap_ms`, default 350, after a 1.5 s lead-in); effects where they're cued, with the next line coming in after `sfx_hold_ms` (1.2 s) so long effects overlap it; beds from their cue (0 if before the first line) to the scene end, `loop=true` when the file is shorter, 1.5 s / 2.5 s fades; music once from its cue, capped at the scene, with fades. Rows already placed keep their place unless `replace`.
- **Interacts with**: `audio_engine.rs` (renders `loop=true` rows with `-stream_loop -1`), CLI `generate all scene`.

## Notes
- Durations come from the files (WAV/FLAC headers), so lay out after generating.
