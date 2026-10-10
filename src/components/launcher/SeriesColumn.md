# SeriesColumn.tsx

## Purpose
Left column of the launcher: series cards (format, cast and episode counts) and the New series form. The form's optional "Describe the show" runs `draft_series_bible` after creating the series, so Claude drafts the cast, sets, formula, style and sound cues; if drafting fails the series still opens. Clicking a series sets `seriesStore.openSeriesId`, which swaps the launcher shell to `SeriesHomeView`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ProjectLauncherView.tsx` | `series`, all `projects` (for episode counts), `loading` | Prop changes |
