# servers/mcp/tools_compose.py

MCP tools: scene composition and final render (pure Python + ffmpeg).

## Purpose

Turn a resolved script.csv into audio: `compose_scene` mixes one scene,
`render_final` chains all scene renders into the deliverable.

## Tools

| Tool | Output | Notes |
|------|--------|-------|
| `compose_scene` | scenes/{slug}/render/scene_{slug}.wav | one ffmpeg amix graph: per-track gain/pan/fades, adelay timeline placement, `-stream_loop` for loop rows, atrim to declared duration, apad to equal lengths, amix normalize=0 |
| `render_final` | output/final.wav | storyboard-ordered acrossfade chain (default 500 ms); single scene is a plain copy; errors list the missing scene renders |

## Contracts

- `_compose_scene_ffmpeg` pre-flights every referenced file and fails with the
  missing list **before** launching ffmpeg.
- Rows included: type in {DIALOGUE, SFX, MUSIC, AMBIENCE, EFFECT, EFFECT_SFX}
  with a non-empty `file` column. DIRECTION rows never carry audio.
- Timeline length = max(start+duration) + 500 ms tail (30 s fallback when no
  durations are set).
- Requires a local `ffmpeg` on PATH (600 s timeout). No QA-status gating —
  whatever the script references gets mixed.
- Note: the spatial columns written by `spatialize_row` are consumed by the
  Rust/Tauri renderer, not by this ffmpeg fallback path (it applies legacy
  L/R `pan` only).
