# takes.rs

## Purpose
Find every take of a script line on disk, and store take ratings, for the Compare takes panel.

## Components

### `row_takes(project_id, scene_slug, row_index)`
- **Does**: Groups the scene's audio by file name up to the first dot (`take.wav`, `take.lock.wav`, `take.upscaled.speech.….wav` are one take; the newest is what gets placed). A group belongs to the row when a sidecar carries the row's line or it holds the row's current file. Returns engine, seed, direction and take-check notes from the sidecars, the rating, and whether it's in use.

### `rate_take(project_id, scene_slug, key, rating)`
- **Does**: Saves a 1–5 rating (or clears it) in `scenes/<slug>/take_ratings.json`, keyed by take group.

## Notes
- Ratings live beside the scene, not in sidecars, so a take's versions share one rating.
