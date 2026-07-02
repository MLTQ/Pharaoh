# servers/mcp/tools_jobs.py

MCP tools: generation job polling.

## Purpose

The async half of every generate_* tool: `job_status` is a single poll,
`wait_for_job` blocks (2 s interval) until the job resolves or the timeout
passes.

## Contracts

- Both tools route through `remote._get` and then
  `remote._resolve_job_output`, so when a remote job completes its output file
  is downloaded and `output_path` always ends up local.
- `wait_for_job` returns `{"ok": true, ...record}` on complete,
  `{"ok": false, ...record}` on failed, and on timeout an `ok: false` record
  with the last-seen job state under `last` — the job keeps running server-side.
