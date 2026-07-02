# servers/mcp/resources.py

`pharaoh://` MCP resources — read-only JSON views of project state.

## Purpose

Cheap situational awareness for agents without invoking tools. Importing this
module registers all resources on the shared FastMCP instance.

## Resources

| URI | Contents |
|-----|----------|
| `pharaoh://projects` | id/title/logline/created_at for every project |
| `pharaoh://projects/{id}` | full project.json |
| `pharaoh://projects/{id}/storyboard` | storyboard.json |
| `pharaoh://projects/{id}/scenes/{slug}/script` | script.csv as JSON rows |
| `pharaoh://projects/{id}/scenes/{slug}/assets` | assets with QA status + metadata |
| `pharaoh://projects/{id}/pipeline` | per-scene stage completion matrix |

## Invariants

Strictly read-only — resources never write to disk and never contact the
inference servers. All heavy lifting lives in projectfs.py.
