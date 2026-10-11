# DissectSpeakerLines.tsx

## Purpose
Every line (diarization turn) attributed to one speaker, opened from the speaker card's **Lines (N)**. Search by transcript, play a line (cut on demand from the dialogue stem via `dissect_clip`, cached), tick lines (click the row), **Select all / matches**, and move the selection with [MoveToSelect](./MoveToSelect.md). Shows 100 at a time.

## Contracts
| Dependent | Expects |
|---|---|
| `DissectSpeakerCard` | `onMove(turnStarts, target)` |
