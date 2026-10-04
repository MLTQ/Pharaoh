# rvc.rs

## Purpose
Tauri commands for the optional voice lock: train an RVC model on a character's corpus and pass finished takes through it.

## Components

### `submit_rvc_train`
- **Does**: Sends the character's `rvc_corpus/*.wav` to the RVC server (uploaded, named per character, when the server is remote) and starts training. A local server writes the model into the bundle's `rvc/`; a remote one keeps it in its `.rvc-models/`.

### `finish_rvc_train`
- **Does**: After a remote job completes, downloads the `.pth` (`/files/{job}`) and `.index` (`/files/{job}/index`) into `rvc/` and records the server's paths in `rvc/<name>.server.json`.

### `locks_line`
- **Does**: Whether a line gets the lock: `rvc.enabled`, and either `lock_lines == "all"` or a calm line (no vocal events in the text, no whisper/sigh/laugh/cry/shout/fear words in text or direction).

### `submit_voice_lock`
- **Does**: For a qualifying line, makes sure the server has the model (`server_model_paths`: reuse the recorded paths if the server still lists them, otherwise upload the bundle copies once), converts the take into `<take>.lock.wav`, and polls; completion is a `job-complete` event with model `rvc`. Returns `None` for lines that keep the engine's take.

### `submit_rvc_convert`, `get_rvc_job`, `list_rvc_models`, `get_corpus_status`, `get_rvc_model_info`
- **Does**: Lower-level convert, job polling, and bundle inspection.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `jobStore.ts` | `submit_voice_lock` returns a job id or null; completion arrives as `job-complete` (model `rvc`, empty scene) | Changing the event model or adding a scene binding here |
| `cli/generate_scene.rs` | `locks_line`, `local_model`, `server_model_paths`, `voice_lock_body`, `lock_output_path` | Signature changes |
| `inference/rvc_server.py` | `/train` with empty output paths reports `result.model_path/index_path`; `/convert` accepts an empty `output_path` | Server API drift |

## Notes
- The calm rule comes from the 2026-10-04 blind test: the lock made calm lines sound more like Dumbledore but took the edge off anger and the air out of sighs and whispers.
