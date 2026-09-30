# DissectSoundList.tsx

## Purpose
One kind of found sound (effects, ambience or music) as a filterable, selectable list that extracts into a scene.

## Components

### `SpanPlayButton`
- **Does**: Audition a span of a stem. The first click cuts it with `dissectClip` (cached under the import's `clips/`), then toggles playback.
- **Rationale**: Playing from the stem would decode the whole file — gigabytes for a long book.

### `DissectSoundList`
- **Does**: Filter box plus the ten commonest top labels as chips; rows with checkbox, audition, name, role (sting / cue), AudioSet scores, duration, position, chapter and prominence. "Add to scene" copies every ticked sound into the chosen scene's `assets/` via `dissectExtractSound` and marks it "added".

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `DissectReview.tsx` | Props `importId`, `sounds`, `chapters`, `scenes`, `projectId`, `empty` | Prop changes |
| `commands/dissect.rs` | `dissect_clip(importId, stem, start, end)`, `dissect_extract_sound({… kind, stem, scene_slug …})` | Command shapes |
