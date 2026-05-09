# `FinalAssemblyView.tsx` — episode-level deliverable

## Intent

The Phase-7 deliverable surface. Concatenates per-scene `render.wav` files
into one `output/final.wav` with crossfades between adjacent scenes and an
episode-wide master pass (loudnorm + alimiter) so the final hits the chosen
target LUFS even if individual scene renders drifted.

## Why an episode-level master

Per-scene `render_scene` already runs loudnorm at the chosen target, but
single-pass loudnorm on short content (a 30-second scene) can drift 0.5–1 LU
from target — measurement uncertainty. Across 20 scenes those drifts compound
at scene boundaries. Running one final loudnorm over the whole episode
flattens out the boundary-to-boundary inconsistency and makes the deliverable
hit spec exactly.

## Layout

```
Header                          (Episode title + intent)
Summary card                    Scenes rendered / projected duration / last-render loudness
Controls                        Crossfade duration · master target · Render button
Scene strip list                One row per scene in episode order:
                                  ▲▼ reorder | render-state pip | title | loudness | audition | status
```

## Render flow

1. User clicks **Render episode**.
2. Frontend calls `renderEpisode({ projectId, crossfadeMs, targetLufs, sceneSlugs })`.
3. Rust side (`render_episode_with_projects_dir`):
   - Reads `storyboard.json` for default scene order if no override.
   - For each scene: if no `render.wav`, calls `render_scene_with_projects_dir`
     to produce one (with the chosen target).
   - Builds an ffmpeg `filter_complex` that does pairwise `acrossfade=d=...:c1=tri:c2=tri`
     (or straight concat when crossfade is 0).
   - Runs the same loudnorm + alimiter master chain that scenes use, but at
     episode level.
   - Writes `output/final.wav` and `output/final.wav.meta.json` (target,
     measured, scene order, crossfade).
4. Frontend reads back the meta and shows it in the summary card with the
   compliance color bands the transport bar uses.

## Reorder

Scene strips have ▲▼ buttons. The order is local UI state, not yet persisted
to `storyboard.json` — the active order is passed as `sceneSlugs` to
`renderEpisode`. Persistence is a v2 question: do we want a separate
"episode order" from "storyboard order"? For now: edit-on-render.

## What this is not

- Not a multi-track timeline. Scenes are atoms here; their internal track
  composition is editable in the Composition workspace.
- Not a publishing/export gateway (no MP3/AAC encode, no cover art, no
  metadata embedding). final.wav is the master; encoding for a delivery
  target is a follow-up.
