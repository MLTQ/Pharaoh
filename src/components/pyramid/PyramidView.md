# PyramidView.tsx

## Purpose
The project's front page: the story bible at the apex, scene plates in tier II (or the story-shape curve), and the composition tier and episode timeline at the base.

## Components

### `PyramidView`
- **Does**: Lays scene plates out with [pyramidLayout](../../lib/pyramidLayout.md). A few scenes sit in one row under the classic triangle; more stack in widening courses and the outline steps out to hug them. The canvas grows with the scene count, fit-to-window scales it, and drag, scroll and pinch pan and zoom. Each plate shows status, duration and its asset pips (placed / planned TTS, SFX, music).
- **Interacts with**: `projectStore` (scenes, `createScene`, `updateScene`), `jobStore` (refreshes pips when jobs complete), [StoryShapeView](./StoryShapeView.tsx).

## Notes
- The story-shape projection keeps the one-row canvas; only plates stack.
- Tier labels follow the top course so they stay beside the pyramid on wide canvases.
