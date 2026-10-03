# RecordingClips.tsx

## Purpose
"From the recording" in a palette emotion: the character's own clips from its dissected source whose delivery matches that emotion, best first, to play and use as the emotion's reference.

## Components

### `RecordingClips`
- **Does**: Groups the character's Dissect provenance by import (a character can merge several speakers), asks `dissectEmotionClips` for each, and lists clips with ▶ (cut on demand with `dissectClip`, played through `audioStore`) and Use. An untagged import offers "Read emotions" (`dissectStore.tagEmotions`, a job-queue row); an emotion the tagger has no class for (whisper, tender) says so.
- **Interacts with**: [LibraryPaletteTab](./LibraryPaletteTab.md) (renders it in each `PaletteRow`, owns `onUse`), `commands/emotions.rs`, [dissectStore](../../store/dissectStore.md).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryPaletteTab` | `onUse(importId, clip)` resolves after the reference is saved | Calling onUse without awaiting |
