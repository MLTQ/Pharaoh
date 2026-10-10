# seriesStore.ts

## Purpose
Series state kept apart from `projectStore`: which series the launcher shell shows (`openSeriesId`), and the episode writer's progress.

## `startWrite(args)`
Calls `write_episode` and records `writing[series_id]` ({stage, message, startedAt}), updated from `episode-writer` events (listened to once, lazily). On success: a toast with **Open →**, and `episodesVersion` bumps so the episode list and canon reload. On failure: an error toast. One write per series at a time.

## Notes
- `App.tsx` sets `openSeriesId` from the open project's `series_id` and clears it for one-shots, so leaving an episode returns to its series.
