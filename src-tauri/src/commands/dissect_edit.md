# dissect_edit.rs

## Purpose
Speaker corrections for a finished dissect import. Diarization confuses voices, most often when one actor plays several parts: lines land on the wrong speaker, or one character is split across two. These edits fix the attribution before voices are named or a rebuild is made.

## Components

### `apply(manifest, ReassignRequest)`
- **Does**: Moves turns (by start time) and candidate clips from `from` to `to`, or to a new speaker (`to: None`; id `S{max+1}`, label `new_label` or "Speaker N", `split: true`). `all` merges the whole speaker, credits included.
- **Cascade**: a moving clip takes the line(s) it was cut from; a moving line takes the clips cut from it. Moved clips lose `similarity` (it was measured against the old speaker).
- **Stats**: `total_speech_s` and `turn_count` move by the moved turns' duration and count, so the pipeline's own measure is kept. `first_heard_s`, `chapters` and `sample_text` (kept if still one of theirs) are recomputed for both speakers. A speaker left with nothing is removed; speakers are re-sorted by speech. `corrections` counts edits.
- **Rejects** (nothing written): unknown speakers, same source and target, a merge without a target, a clip or line not on `from`.

### `reassign_in` / `reset_in` / `forget_original`
- **Does**: Apply to `manifest.json`, copying the server's manifest to `manifest.server.json` before the first edit; reset copies it back and removes it. A retry drops the saved original, since the re-run's manifest supersedes it.
- **Rationale**: Editing the manifest in place means the review, `dissect_assign_speaker`, rebuild and the CLI read corrected speakers with no other changes.

## Commands
Tauri `dissect_reassign(request)` → manifest, `dissect_reset_speakers(import_id)` → manifest. CLI `pharaoh dissect reassign` / `reset-speakers`.
