# servers/mcp/tools_voice.py

MCP tools: character voice pipeline — emotional palette and RVC training.

## Purpose

The four-stage voice identity workflow (docs/voice-pipeline.md):
design palette takes → approve references → (optional voice lock) corpus status →
train an RVC model → convert audio with it.

## Tools

| Tool | Stage | Notes |
|------|-------|-------|
| `generate_palette_take` | 2 | base_voice_description + emotion direction → Qwen3 VoiceDesign; upserts palette entry (qa_status=unreviewed) |
| `approve_palette_take` / `list_character_palette` / `list_palette_takes` | 2 | approval stores the ref relative to the character bundle (Pharaoh-1qp) |
| `corpus_status` | 3 | corpus at characters/{id}/rvc_corpus/ (the character's real lines, filled in the app or with `pharaoh dissect corpus`); 5-minute minimum |
| `train_rvc_model` / `list_rvc_models` | 4 | RVC server /train; outputs {name}.pth + .index under characters/{id}/rvc/ |
| `rvc_convert` | 4+ | single-file conversion; falls back to the conventional rvc/{name}.pth path when voice_assignment has no model path |

## Invariants

- Long-running operations return job_ids — callers poll `job_status`.
- All palette/corpus paths resolve through projectfs helpers so bundles stay
  portable across machines.
