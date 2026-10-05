# pyramidLayout.ts

## Purpose
Where the Pyramid view's scene plates go: one row for a handful of scenes, then courses that widen downward so a long project (a 60-chapter rebuild) stays pyramid-shaped instead of becoming one long strip.

## Components

### `pyramidRows(cards)`
- **Does**: Cards per row, top to bottom. Up to `SINGLE_ROW_MAX` (6) cards: one row. Beyond that: rows of 5, 6, 7, …, trimmed from the top round-robin so no row is wider than the one below it. `cards` counts the "+ Add scene" card.

### `pyramidGeometry(cards, opts)`
- **Does**: Canvas size (`W`, `H`), each row's extent, and each card's slot. Rows are centred; the canvas is at least `minW` wide.
- **Interacts with**: [PyramidView](../components/pyramid/PyramidView.md).

## Notes
- Reading order is left to right, top to bottom, so scene order matches the episode.
