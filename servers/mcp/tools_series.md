# servers/mcp/tools_series.py

MCP tools: series (show bibles) and episodes.

## Purpose
Lets an MCP client (Claude Desktop) make "an episode of X" with itself as the writer: `get_series_brief` → write Fountain → `import_series_episode`. No API key is involved; the client's own model writes.

## Tools
- `list_series()`: filesystem read of `_series/*/series.json`, with episode counts from `project.json` `series_id`.
- `get_series_brief(series)`: `pharaoh series brief` (the same brief the in-app writer uses).
- `import_series_episode(series, fountain, title?, logline?, synopsis?, canon_*?)`: `pharaoh episode import <series> -` with the script on stdin. Creates the episode, imports the Fountain, links the cast's library voices, binds `#tag` sound cues, logs canon.

## Notes
- The CLI is found via `$PHARAOH_CLI`, the newer of the repo's `src-tauri/target/{release,debug}/pharaoh`, `/Applications/Pharaoh.app`, then `PATH`.
- The CLI reads the projects folder from the app config, not this server's `--projects-dir`; they agree on a normal install.
- Episode generation through Claude's API (pitch, beat sheet, writers' room) is in the app and `pharaoh episode new`.
