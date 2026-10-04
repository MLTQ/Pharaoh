"""
One-shot ACE-Step v1 job, run by yue2_music_server.py in the .venv-music
interpreter (ACE-Step's dependency pins can't share YuE2's environment).

    .venv-music/bin/python ace_step_worker.py '<json>'

JSON: {"endpoint": "repaint" | "cover" | "text2music", "params": {...}, "output_path": "..."}
Loads the model, writes output_path, exits 0. Errors go to stderr, exit 1.
"""
import json
import sys

import ace_step_tasks


def main() -> int:
    job = json.loads(sys.argv[1])
    status = ace_step_tasks.model_dir_status()
    if not status["ok"]:
        print(status["reason"], file=sys.stderr)
        return 1
    pipeline = ace_step_tasks.load_pipeline()
    ace_step_tasks.run_task(pipeline, job["endpoint"], job["params"], job["output_path"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
