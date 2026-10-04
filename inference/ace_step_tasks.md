# ace_step_tasks.py

## Purpose
ACE-Step v1 calls shared by `music_server.py` (ACE-Step as the music engine) and `ace_step_worker.py` (repaint/cover for the YuE2 server). Loads nothing heavy at import.

## Components
- `model_dir_status()`: checks `PHARAOH_MUSIC_MODEL_DIR` for the four checkpoint dirs.
- `load_pipeline()`: builds `ACEStepPipeline` and loads its weights eagerly.
- `run_task(pipeline, endpoint, params, out_path)`: text2music, cover (audio2audio) or repaint.

## Notes
- Repaint windows arrive in ms and are passed to ACE-Step in **seconds**. Passing ms made ACE-Step treat 15000 as 15,000 s and crash in its extend path.
- Repaint and cover use the source file's real length, not the request's `duration_seconds`.
