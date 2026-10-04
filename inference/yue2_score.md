# yue2_score.py

## Purpose
Shapes YuE2's planned ABC scores so Pharaoh controls what YuE2 has no input for: length, tempo and vocals. Pure Python (no torch), so it's tested without a GPU (`tests/test_yue2_score.py`).

## Components
- `repair(abc)`: drops trailing lines until the score parses. The planner's token cap can stop it mid-line.
- `set_tempo(abc, bpm)`: rewrites the `Q:` header. The planner treats a BPM in the style as a suggestion.
- `instrumental(abc)`: moves every Vocal note to Ins (vendored `instrumentalize.convert_score`); chords stay on Vocal.
- `trim(abc, seconds)`: keeps the whole bars that fit. `parse_abc` times are quarter-note beats.
- `section_tags`, `planning_lyrics`, `style_text`: lyrics and style for instrumental requests.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `yue2_music_server.py` | `trim` output is a valid instrumental score YuE2 accepts | Returning scores with Vocal notes |

## Notes
- Imports the vendored helpers from `yue2_abc/` (MIT, from the YuE repo's `skills/yue2-music/instrumental/scripts`).
- Rendered audio usually runs 0–13 s past the trimmed length while the piece plays out its ending.
