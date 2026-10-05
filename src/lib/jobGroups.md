# jobGroups.ts

## Purpose
Turn the flat job list into one group per line: the take plus its chained follow-ups (voice lock, AudioSR).

## Components

### `groupJobs(jobs)`
- **Does**: Groups by `parent_id`, adds stages still expected from the first job's `followups`, and derives the group's status (failed if any stage failed, running while any stage runs or waits) and overall progress across stages.

### `groupIds(group)`
- **Does**: Every job id in a group, for clearing it.
