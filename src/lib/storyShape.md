# storyShape.ts

## Purpose
Curve math for the story-shape view (tier II of the pyramid). Converts sparse,
per-scene authored `tension` values into a smooth polyline. Pure functions —
no React, no DOM, no store — so the shape can be reasoned about and tested
without mounting the view.

## Design commitments

**`null` tension is unshaped, not zero.** A scene the writer has not placed on
the curve is skipped entirely; it is never coerced to 0. An unshaped project
renders as an empty band, not a flat line along the floor. This is the whole
reason the feature stays non-prescriptive: you can shape three scenes and leave
the rest blank without the view asserting a valley you never drew.

**Monotone cubic, not Catmull-Rom.** Catmull-Rom overshoots between control
points, inventing peaks and troughs. In a tool whose premise is "show me the
shape I actually made", inventing shape is the one unacceptable failure. The
Fritsch–Carlson tangent clamp guarantees the curve stays within the authored
values on every segment.

**Gaps are visible.** A segment spanning unshaped scenes is flagged
`spansGap`, and the renderer dashes it. Interpolation across a hole is a guess
and must never be drawn with the same confidence as an authored run.

## Components

### `toShapePoints`
- **Does**: Scenes in storyboard order → authored points, skipping
  null/undefined/non-finite tension. Clamps surviving values to 0–1.
- **Interacts with**: `StoryShapeView` (its only caller today).

### `buildCurve`
- **Does**: Authored points → per-adjacent-pair `CurveSegment`s of sampled
  `{x, y}` in data space (x = scene index, y = tension). Under two points
  returns `[]` — the caller still draws individual nodes.
- **Interacts with**: `StoryShapeView`, which maps data space to pixels.

### `interpolatedDefault`
- **Does**: Suggested tension for a newly inserted scene — linear between the
  nearest authored neighbours, or the nearest authored value past an end.
  Returns `null` when nothing is authored, so inserting into an unshaped
  project does not silently begin shaping it.
- **Interacts with**: scene creation (not yet wired — see Status).

### `clamp01`
- **Does**: Range clamp shared by the drag handler and the point collector.

## Status
`interpolatedDefault` is implemented and tested but not yet called from the
scene-create path; new scenes currently arrive unshaped, which is a safe
default. Wire it in when insert-into-a-shaped-curve becomes a real workflow.

## Related
- `src/components/pyramid/StoryShapeView.tsx` — the only consumer.
- `Scene.tension` in `src/lib/types.ts` / `src-tauri/src/models.rs` — storage.
