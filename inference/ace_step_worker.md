# ace_step_worker.py

## Purpose
One-shot ACE-Step v1 job for `yue2_music_server.py`, run in `.venv-music` because ACE-Step's pins (transformers 4.50) can't share YuE2's environment. Pattern borrowed from RVC's Applio workers.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `yue2_music_server._run_ace` | argv[1] JSON `{endpoint, params, output_path}`; exit 0 with the file written, else non-zero and the error on stderr | Changing the argument shape |

## Notes
- Loads the model on every call (~10 s). Fine for occasional repaints; make it a persistent worker if repaint becomes frequent.
