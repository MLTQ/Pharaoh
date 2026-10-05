# CompareTakes.tsx

## Purpose
Blind comparison of every take of one script line: play, rate 1–5, put one on the row, then reveal which is which.

## Components

### `CompareTakes`
- **Does**: Lists the row's takes from `rowTakes` (disk, so older sessions count) in a fresh random order lettered A, B, C…. Shows Breeze's take check blind; Reveal adds engine (+ voice lock / AudioSR), seed, direction and date. Ratings save through `rateTake`; the highest-rated take is outlined. Use calls `onUse(path)`.
- **Interacts with**: [takes.rs](../../../src-tauri/src/commands/takes.md), `ScriptCanvas` (the row's **compare** button).

## Notes
- Portalled to `document.body` because it opens from inside draggable script cards.
