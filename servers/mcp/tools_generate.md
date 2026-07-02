# servers/mcp/tools_generate.py

MCP tools: audio generation for script rows (TTS, Chatterbox, SFX, music).

## Purpose

Each tool validates the target script row (type + index via the shared
`_row_range_error` helper), then proxies to the matching inference server
through `remote._post`, which handles remote upload/download path remapping.
All tools return a job record — poll with `job_status` / `wait_for_job`.

## Tools

| Tool | Row type | Server | Notes |
|------|----------|--------|-------|
| `generate_tts` | DIALOGUE | tts (or chatterbox) | auto-routes to Chatterbox clone when the character's voice_assignment.model is "Chatterbox" (palette ref resolved per row emotion); else voice_description → /generate/voice_design, else speaker+instruct → /generate/custom_voice |
| `generate_chatterbox` | DIALOGUE | chatterbox | explicit 0-shot clone; ref_audio_path auto-resolves from the emotional palette when omitted |
| `generate_sfx` | SFX/BED | sfx | Woosh-DFlow, 4-step |
| `generate_music` | MUSIC | music | batch_size > 1 fans out seeds into `_takeN` output paths (gacha workflow) |

## Invariants

- Prompt text always comes from the row's `prompt` field, never from args.
- Heavy generations call `_auto_unload_others` first (single-model mode).
- Palette refs go through `_resolve_voice_path` (Pharaoh-1qp relative paths).
