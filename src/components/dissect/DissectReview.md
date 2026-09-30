# DissectReview.tsx

## Purpose
A finished import laid out for extraction: header (cover, title, author, stats), the [whole-recording overview](./DissectOverview.md), and four tabs.

## Components

### Voices
- **Does**: The rights confirmation, "also add to this episode's cast", and one [DissectSpeakerCard](./DissectSpeakerCard.md) per voice. Assigns via `dissectAssignSpeaker` (rights + performer recorded), then `importCharacterFromLibrary` for new characters when a project is open. Notes that a single narrator performing every part is one voice.
- **Rationale**: The rights gate is enforced in Rust too; the UI gate is the first line.

### Sound effects / Ambience & beds / Music
- **Does**: [DissectSoundList](./DissectSoundList.md) over `manifest.sounds`. Effects can include the `vocal` group (gasps, laughs…) via a toggle. Empty states explain why a list is empty (dry reading, separation off, bleed dropped); imports that predate sound detection say to Retry.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `DissectView.tsx` | Props `status` (complete, with manifest), `projectId`, `scenes`, `onAssigned` | Prop changes |
