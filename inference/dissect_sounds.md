# dissect_sounds.py

## Purpose
Find the non-dialogue material in a dissected recording — sound effects, vocal sounds, ambience/beds and music — and label it, so the Dissect tab can offer it for extraction into scenes.

## Components

### `regions`
- **Does**: Stretches of a stem's 50 ms loudness envelope louder than its own noise floor (20th-percentile frame + `rel_db`, never below `abs_db`); merges runs closer than `gap_s`, drops runs shorter than `min_s`.

### `beds`
- **Does**: Sustained stretches above an absolute level (−48 dBFS, 1 s smoothing, ≥ 8 s).
- **Rationale**: A bed that runs under the whole recording (rain, a crowd) *is* the floor, so `regions` can't see it. Found on the positive-control mix: rain was missed until this pass existed.

### `classify`
- **Does**: Effect regions ≤ 6 s → `sfx` (with 0.1 s pre-roll / 0.3 s tail); longer → `ambience`, plus `beds` regions not already covered; music regions → `music` with `role` sting (< 8 s) or cue. Caps scale with length (60 / 25 / 25 per hour, at least 300 / 100 / 150, at most 1500 / 500 / 500), strongest kept — a flat cap truncated a 20 h book's ambience.

### `Tagger`, `find_sounds`
- **Does**: Labels each region with the AudioSet AST classifier (`MIT/ast-finetuned-audioset-10-10-0.4593`) from a ≤ 10 s excerpt of its stem. Then: effects whose top label is plain speech are dialogue bleed and dropped (unless a real non-speech sound also scores ≥ 0.1); nonverbal vocal sounds (gasp, laugh, sigh…) move to their own `vocal` group; music-stem regions whose "Music" score is < 0.15 are dropped as bleed.
- **Rationale**: On a dry reading the separator routes breaths, gasps and plosives to the effects stem and some speech to the music stem; without these rules both lists fill with voice.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `dissect_pipeline.run` | `find_sounds(env, reader, chapters, models, progress)` → `{sfx, vocal, ambience, music, tagger, warnings}` | Return shape |
| `types.ts::DissectSound` / `DissectSoundList.tsx` | Each item: `id, kind, stem, start, end, duration, prominence, chapter, name, labels[], role?` | Field renames |
| `commands/dissect.rs::extract_sound` | `kind` ∈ sfx / vocal / ambience / music; `stem` ∈ effects / music | New kinds without a Rust mapping |

## Notes
- Positive control (5-min reading + Brahms + brown-noise "rain" + synthetic thumps): 7 music cues (Orchestra, Violin, Scary music), 6 ambience regions, dialogue bleed removed. Synthetic sine thumps are tagged "Gasp" — real recorded effects give AST something to recognise.
