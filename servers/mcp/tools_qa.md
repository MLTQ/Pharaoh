# servers/mcp/tools_qa.py

MCP tools: asset QA and take management.

## Purpose

Everything works off the `.meta.json` sidecars written next to generated WAVs
— the sidecar is the single source of truth for QA state.

## Tools

| Tool | Notes |
|------|-------|
| `list_assets` | scene assets, filterable by qa_status |
| `qa_approve` / `qa_reject` | write qa_status + qa_notes to the sidecar; reject requires notes |
| `read_asset_meta` | raw sidecar contents |
| `list_asset_takes` | all takes sharing a stem prefix, sorted by take_index |
| `regenerate_asset` | re-submits the original generation using sidecar params; routes by sidecar `model` (qwen/tts → tts, ace/music → music, else sfx); output defaults to `{stem}_take{N+1}.wav` |

## Invariants

- Missing-sidecar errors share `_no_sidecar_error`, which names the expected
  sidecar path and explains that only generated/imported assets have sidecars.
- Composition (tools_compose.py) does not check QA status — approval is a
  workflow convention for agents, not an enforcement gate.
