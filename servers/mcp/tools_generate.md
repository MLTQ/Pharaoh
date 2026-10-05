# servers/mcp/tools_generate.py

MCP tools: audio generation for script rows (TTS, SFX, music).

## Purpose

Each tool validates the target script row (type + index via the shared
`_row_range_error` helper), then proxies to the matching inference server
through `remote._post`, which handles remote upload/download path remapping.
All tools return a job record — poll with `job_status` / `wait_for_job`.

## Tools

| Tool | Row type | Server | Notes |
|------|----------|--------|-------|
| `generate_tts` | DIALOGUE | tts | a character with a gold reference is cloned with /generate/voice_clone (the row emotion's palette reference and direction when it names one; Breeze performs the direction, Qwen3-TTS ignores it); else voice_description → /generate/voice_design, else speaker+instruct → /generate/custom_voice |
| `generate_sfx` | SFX/BED | sfx | server default: MOSS-SoundEffect v2 (≤30 s) where installed, else Woosh-DFlow |
| `generate_music` | MUSIC | music | batch_size > 1 fans out seeds into `_takeN` output paths (gacha workflow); `instrumental` (default true) and `bpm` apply to YuE2 |

## Invariants

- Prompt text always comes from the row's `prompt` field, never from args.
- Heavy generations call `_auto_unload_others` first (single-model mode).
- Palette refs go through `_resolve_voice_path` (Pharaoh-1qp relative paths).
