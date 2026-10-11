# SeriesColumn.tsx

## Purpose
Left column of the launcher: series cards (cast and episode counts) and the New series form. Clicking a series sets `seriesStore.openSeriesId`, which swaps the launcher shell to `SeriesHomeView`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ProjectLauncherView.tsx` | `series`, all `projects` (for episode counts), `loading` | Prop changes |
