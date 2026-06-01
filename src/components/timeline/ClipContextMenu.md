# ClipContextMenu.tsx

## Intent

A tiny floating menu that opens at the right-click cursor position for a
timeline clip. It is the *only* surface that should appear directly on
right-click — actual editors (TakesPopover, SpatializeModal) are launched
from menu items rather than being conflated with the right-click gesture
itself. That keeps the gesture meaning stable as we add more clip actions
later (Properties…, Replace, Regenerate, etc.).

## Why a menu rather than direct dispatch

Until now the timeline's right-click handler opened the Takes popover
directly. Adding new clip-level actions without breaking that muscle
memory required either (a) overloading right-click again, or (b) inserting
a one-step menu. We chose (b) because:

1. Discoverability — users see "Spatialize…" in the menu, they don't have
   to read docs or guess keybindings.
2. Future-proofing — Properties / Replace / Regenerate all want to live on
   the same right-click without piling onto a single popover.
3. The cost is one extra click for the existing "show takes" flow,
   which is acceptable for the gain in expressivity.

## Behavior

- Closes on outside mousedown, Escape, or any scroll event.
- Position is clamped to keep the menu visible near viewport edges.
- Each menu item closes the menu *before* invoking its action so the
  invoked dialog/popover can take focus cleanly.
- `hasSpatial` retitles the Spatialize entry to "Edit spatial position…"
  when the row already has spatial data — small affordance that signals
  the menu item will open with the existing values populated.

## Contract

- `onClose` is called on any dismissal path and after every item action.
- Caller owns position state; this component is purely presentational.
- Z-index 1000 sits above the timeline (which uses up to ~10 for dragging
  clips and ~30 for the playhead).
