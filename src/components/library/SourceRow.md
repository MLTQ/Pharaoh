# SourceRow.tsx

## Purpose
One uploaded / generated take in a voice-reference sources list (Pharaoh-0b3l). Renders the gold-pick radio dot, play button, filename (with a "concat" badge when the row represents a derived combined file), and remove control.

## Components

### `SourceRow`
- **Props**: `path`, `isGold`, `derivedConcat`, `onPickGold()`, `onRemove()`, `disabled`.
- **Does**: The radio dot picks the "gold" — the single file Chatterbox actually uses for 0-shot cloning. When `derivedConcat` is true the dot is inert (the gold is a concat-derived file outside the sources list) and remove means "drop the concat and revert to a source".
- **Interacts with**: `PlayButton` from shared.
- **Rationale**: Shared widget so the per-emotion palette can adopt the same affordance later without duplicating styling. Used today by [LibraryVoiceTab](./LibraryVoiceTab.md).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryVoiceTab` | `onPickGold` is never invoked when `derivedConcat` | Wiring the dot for concat rows would set a bogus gold |
