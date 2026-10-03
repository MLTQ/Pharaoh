# RecordingClips.tsx

## Purpose
"From the recording" in a palette emotion: the character's own clips from its dissected source, ranked by the emotion's recipe, to play and use as the emotion's reference — plus "≈" to find clips that sound like any one of them.

## Components

### `RecordingClips`
- **Does**: Groups the character's Dissect provenance by import (a character can merge several speakers) and asks `dissectEmotionClips` with the entry's recipe (debounced, so slider drags re-rank live). Each clip shows its top emotion (or "unclear tone" when under 30% of the reader's belief is on the seven classes), delivery traits against the character's average ("soft, slow, breathy"), time and length, with ● on clear examples (`strong`), ▶ (cut on demand via `dissectClip`, played through `audioStore`), ≈ (`dissectSimilarClips` — embedding similarity) and Use.
- **Recipe editor**: seven class weights (-1..1, negative = avoid) and five delivery targets (loud, pace, pitch, movement, breathy). Shows the entry's recipe, else the built-in one the server used; edits go through `onRecipeChange` (marks the character dirty; Save keeps them); "Reset to built-in" clears it.
- **States**: untagged import → "Read emotions"; tagged before delivery features (`needs_update`) → "Re-read"; no recipe for a custom name → points to the editor and ≈.
- **Interacts with**: [LibraryPaletteTab](./LibraryPaletteTab.md) (owns `onUse` / `onRecipeChange`), `commands/emotions.rs`, [dissectStore](../../store/dissectStore.md).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryPaletteTab` | `onUse(importId, clip)` resolves after the reference is saved; `onRecipeChange(undefined)` restores the built-in recipe | Calling onUse without awaiting |
