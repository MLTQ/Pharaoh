# yue2_abc (vendored)

ABC score helpers from the official YuE repository
(`skills/yue2-music/instrumental/scripts`, commit `1dc1c50`), MIT licensed (see `LICENSE`).
They aren't part of the `yue2-infer` package. Unmodified. Update by copying the files again
from a newer YuE commit and re-running `tests/test_yue2_score.py`.

- `abc_tools.py`: parses YuE2's native ABC (voices, bars, notes, chords, tempo).
- `compile_score.py`: builds native ABC back from note events.
- `instrumentalize.py`: moves the Vocal melody to the Ins voice.
- `common.py`: small file/JSON helpers the others import.
