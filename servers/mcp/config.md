# servers/mcp/config.py

Shared configuration for the Pharaoh MCP server.

## Purpose

Single home for the CLI arguments and the globals derived from them, so every
other module imports the same resolved values instead of re-parsing argv.

## Contracts

- Args are parsed **at import time** with `parse_known_args`, so unknown flags
  are tolerated and `--help` works from any entry point that imports config.
- Exposes: `args` (Namespace), `PROJECTS_DIR` (Path, `~`/env expanded),
  `SERVER_URLS` (dict keyed `tts|sfx|music|post|chatterbox|rvc`), and the
  shared `log` logger (`pharaoh-mcp`).
- `_cfg()` reads the Tauri app's persisted AppConfig (config.json under the
  platform config dir, bundle id `ai.aureum.pharaoh`); returns `{}` when
  missing or unparseable. Used by remote.py for single-model-mode.

## Rationale

Import-time parsing keeps run.py thin and lets tool modules be imported in
isolation (tests, REPL) with sane defaults. Changing a flag default here
changes it for the whole server.
