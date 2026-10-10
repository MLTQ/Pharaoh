# seriesSound.ts

## Purpose
Generate takes for a series sound cue. Jobs use the synthetic project id `_series` and slug `__series_sound__<series>__<cue>` (as the character library uses `_library`): the backend finds no script to bind, so the take just lands in `_series/<id>/sound/<cue>/take_<ts>.wav` (folder made by `prepare_series_sound_dir`). Music kinds go to the music server (instrumental); beds and effects to SFX with the scene panels' engine choice (MOSS when served, else Woosh/AudioLDM by length). Each job is added to `jobStore` so the queue and the Sound tab see it.
