# CharacterPipeline.tsx

## Purpose
The stage bar above a character's editor: Voice → Palette, plus the optional voice lock (Corpus → Model) folded behind a quiet toggle.

## Components

### `CharacterPipeline`
- **Does**: Renders a chip per stage with its status line and lock state. Voice and Palette always show; Corpus and Model show only when `voiceLockOpen`. The toggle reads "voice lock (optional) ›" (with "· on" when a trained model is switched on) and "hide voice lock ‹" when open.
- **Interacts with**: [LibraryView](../library/LibraryView.md) (owns `voiceLockOpen` and the active tab).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView.tsx` | `onToggleVoiceLock(open)` only changes what's shown; `onSelectStage(1-4)` | Making the toggle mutate the character |

## Notes
- The corpus is never locked: it fills from the recording's real lines, no palette needed. The model unlocks at five minutes of corpus audio.
