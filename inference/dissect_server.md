# dissect_server.py

## Purpose
FastAPI shell on port 18007 around `dissect_pipeline.py`: takes an existing audio drama and returns separated stems, who-spoke-when, transcripts, and a shortlist of clean reference clips per speaker, so voices can be imported into the Character Library.

## Components

### `DissectParams`
- **Does**: Request body for `/generate/dissect`: `input_path`, `output_path` (the import directory; empty in remote mode), and the pipeline knobs (`separate`, `transcribe`, `max_candidates`, `min_clip_s`, `max_clip_s`, `chunk_minutes`, `link_threshold`).
- **Interacts with**: `commands/dissect.rs::submit`.

### `_run`
- **Does**: Runs `dissect_pipeline.run` in a worker thread under `inference_lock()`, mirrors stage progress + a human message into the job, and deletes a remote client's uploaded source when the job ends.
- **Rationale**: Uploads are whole episodes; unlike short reference clips they would fill `server-output/uploads/` quickly.

### `/files/{job_id}`
- **Does**: Streams the finished import directory as a stored (uncompressed) zip. Deletes it afterwards only when it is server-owned scratch (`is_server_owned`).
- **Interacts with**: `commands/dissect.rs::poll`, which unpacks it.
- **Rationale**: One job produces many files (stems + candidates + manifest); a zip keeps the single-download contract of the other servers.

### `/health`, `/load`, `/unload`
- **Does**: Standard server surface. `/health` also reports `stub`, `stub_reason`, `separator_ready`, and which models are resident.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `commands/dissect.rs` | `/generate/dissect` → `{job_id}`; `/jobs/{id}` has `status`, `progress`, `message`, `error`; `/files/{id}` is a zip whose root holds `manifest.json` | Response shape, zip layout |
| `start_servers.sh` | Runs under `.venv-dissect` on port 18007 | Venv or port changes |
| Remote clients | Empty `output_path` → server scratch dir; input uploaded via `/upload` | Requiring shared filesystem |

## Notes
- Linux + NVIDIA only in practice. NeMo on macOS is untested; without NeMo the server runs in stub mode.
- The ufw firewall on an inference box must allow 18007 for LAN clients.
