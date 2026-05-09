# `TakesPopover.tsx` — take-family management for timeline clips

## Intent

Right-click any clip in the Composition timeline and get a list of every
take that's been generated for that script row. Audition them, mark
approved/rejected (sidecar QA), or "use" any of them — which rewrites
`script.csv` so subsequent renders use that take's audio.

## Why this matters

The data model has tracked take families since Phase 2 (sidecar `parent` /
`take_index`, `jobStore.activeTakes`, multiple jobs per row across
TTSPanel/SFXPanel/MusicPanel) but there was no place inside the timeline to
*see* them, *compare* them, or *swap* between them — which is the actual
iteration loop for an audio-drama writer dialing in a line.

## Where takes come from

```
jobStore.jobs
  .filter(j => j.scene_slug === sceneSlug && j.row_index === rowIndex && j.model !== "post")
```

Every generation that targeted this row in this scene shows up, in reverse
chronological order. Failed and running takes render too (with their
respective states) so you can see the timeline of attempts.

## "Use" semantics

Clicking **use** does two things:

1. `jobStore.setActiveTake(sceneSlug, rowIndex, jobId)` — in-memory tracking.
2. `updateScriptRow({ projectId, sceneSlug, rowIndex, fields: { file: outputPath } })`
   — persists the choice to `script.csv` so renders pick up the right take.

The popover marks the active take by either:
- Matching `row.file === job.output_path` (post-persist), or
- Matching `jobStore.activeTakes[takeKey(...)] === job.id` (pre-persist).

## What this is not

- Not a side-by-side A/B comparison surface. You audition takes one at a
  time via PlayButton. A real A/B mode (alternating playback) is a v2.
- Not a destructive editor. "Reject" is QA metadata only — the take stays
  on disk. Cleanup is a separate operation (not yet exposed).
- Not a regenerate trigger. Right-click → "regenerate with same params" was
  in the architecture spec; could be added by reading the source job's
  sidecar and re-submitting.
