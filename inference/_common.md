# _common.py

## Purpose
Shared helpers for Pharaoh Python inference servers. It provides small dependency-free primitives that must import under every server virtualenv, including AudioSR's Python 3.9 environment.

## Components

### `new_job_id`
- **Does**: Creates a UUID string for asynchronous inference jobs.
- **Interacts with**: TTS, SFX, music, and Post servers.

### `JobStore`
- **Does**: Keeps in-memory job state and returns the common `/jobs/{id}` response shape.
- **Interacts with**: `tts_server.py`, `sfx_server.py`, `music_server.py`, `post_server.py`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| Python servers | Imports on Python 3.9+ | Using Python 3.10-only syntax |
| Rust pollers | `response()` includes `job_id`, `status`, `progress`, `output_path`, and `error` | Response shape changes |

## Notes
- Keep this module conservative; it is imported by isolated model environments with different Python versions and dependency stacks.
