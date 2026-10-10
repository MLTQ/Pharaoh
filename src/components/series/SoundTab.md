# SoundTab.tsx

## Purpose
The sound package: theme, stingers, bumpers, music, beds and effects reused by every episode. Each cue has a label, a tag (`#tag` in scripts; locked once takes exist, since they're filed under it; renames carry set links), kind, length, prompt and "when to use it" (read by the writer).

## Takes
**Generate** submits through [seriesSound](../../lib/seriesSound.md) (music server for theme/stinger/bumper/music, SFX for bed/effect); running jobs are matched by their synthetic scene slug. Takes are listed from disk newest first, played with `audioStore.toggle`, and **Approve** sets `file`. Episodes copy the approved take bit-exact (`bind_sound_cues`).

## Contracts
| Dependent | Expects |
|---|---|
| `series.rs` | `list_series_sound_takes`, `prepare_series_sound_dir` |
| `SetsTab` | `newCue(kind, label, taken, prompt)` |
