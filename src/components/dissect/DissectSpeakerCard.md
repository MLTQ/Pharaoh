# DissectSpeakerCard.tsx

## Purpose
One detected speaker in a dissect import: stats, a sample line, candidate clips to audition, and the controls to send chosen clips to a new or existing Library character.

## Components

### Candidate rows
- **Does**: Checkbox (keep as a reference source), play, gold radio (the clip Chatterbox clones from), transcript, and quality chips: duration, position, `bleed_db` (dialogue over music+effects; green ≥ 12 dB), and voice match % (TitaNet similarity to the speaker; green ≥ 80 %).
- **Rationale**: The chips explain the ranking so the user can override it, e.g. dropping a high-scoring clip that belongs to a different character the diarizer merged.

### Assign row
- **Does**: Target select (new character / add to existing), name field, and Add. Disabled (and dimmed) until the parent's rights box is ticked and a target is valid.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `DissectImportModal.tsx` | `onAssign({candidateIds, goldId, libraryId, newName})`; `goldId` ∈ `candidateIds` | Changing `AssignChoice` |
