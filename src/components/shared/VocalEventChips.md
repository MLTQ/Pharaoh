# VocalEventChips.tsx

## Purpose
One-click vocal events for a line of dialogue, inserted at the caret.

## Components

### `VocalEventChips`
- **Does**: Renders the 15 events Breeze performs (laugh, chuckle, sigh, gasp, breath, whisper, sob, crying, scream, groan, cough, clear throat, sniff, yawn, hum) — six with `compact` — and inserts `[laughs]`-style tags at the textarea's caret.
- **Interacts with**: TTSPanel (line field), ScriptCanvas (row editor and add-row form), FountainEditor (toolbar).

### `insertEvent`
- **Does**: Pure helper: the text with `[tag]` spaced into place, and where the caret goes.

## Notes
- Brackets, not parentheses: Breeze maps `[x]` to its `(x)` events, and Fountain would turn a parenthesis on its own line into a parenthetical.
- Tagged lines count as expressive, so voice lock leaves them alone.
