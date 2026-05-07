# `FountainEditor.tsx` — prose script editor

## Intent

The primary surface for **authoring** a scene. Where `ScriptCanvas.tsx` is for
managing rows you already have, `FountainEditor` is for writing the scene from
scratch (or revising one drafted by the LLM).

## Layout

Two panes:

- **Left**: a textarea over a syntax-highlighted overlay. The textarea stays
  the source of truth for caret/selection; the overlay paints colors and
  indentation underneath.
- **Right**: each parsed Fountain block as a card with its status badge
  (`draft / generating / ready / placed`) and a per-block **Generate** button.
  This preserves and improves on the per-line/per-character generation UX of
  the original `ScriptCanvas`.

## Why this design

- A textarea is editable and accessible; a fully custom contenteditable would
  cost orders of magnitude more code and inevitably break selection / IME / undo.
- The overlay is layered with `pointer-events: none` so clicks fall through.
- The right pane shows compiled state (status, audio attachment) without
  modifying the prose. Users author on the left, generate on the right.

## Contract

```ts
<FountainEditor
  rows={scriptRows}                  // current ScriptRow[]
  characters={characters}            // for DIALOGUE → speaker lookup
  sceneNo={scene.no}                 // S01, S02, …
  sceneSlug={activeSceneSlug}        // for job submission keys
  onCommitRows={(rows) => …}         // emits compiled rows on every edit
/>
```

`onCommitRows` fires on every edit. The parent (`CompositionView`) debounces
the write to `script.csv` (~600ms) and flushes on scene switch.

## Generation flow

The Generate button on a block calls `useGenerateJob().submitTts/Sfx/Music`
with `rowIndex = blockIndex`. Because `compileBlocksToRows` emits one row per
block in order, the index is the same in both views — the existing job
tracking in `jobStore` works without modification.

The "✦ Draft scene / Revise scene" header button calls
`tauriCommands.draftScene` (Anthropic API) to generate or revise a Fountain
draft from the project context.

## Tab key

`Tab` cycles the current line through:
`action → CHARACTER → SFX: → MUSIC: → BED: → action`.
Quality-of-life shortcut for converting an action line into a cue without
retyping.

## What this is not

- Not a timeline. Mode toggle in `CompositionView.tsx` (Write / Direct / Mix)
  controls layout — this editor only renders for `mode === "write"`.
- Not a Fountain conformance test bed: see `lib/fountain.md` for the supported
  subset.
