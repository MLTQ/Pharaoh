# SeriesHomeView.tsx

## Purpose
The home of one series, shown in the launcher shell (no project open) when `seriesStore.openSeriesId` is set. A shell around eight tabs, one file each:

| Tab | File | What |
|---|---|---|
| Episodes | [EpisodesTab](./EpisodesTab.md) | Make an episode (premise, pitches, beat sheet, write), the episode list |
| Bible | [BibleTab](./BibleTab.md) | Premise, format, tone, themes, world, continuity, length, formula |
| Cast | [CastTab](./CastTab.md) | The troupe, archetypes, library voices, "Design voice" |
| Sets | [SetsTab](./SetsTab.md) | Recurring locations, headings, beds |
| Sound | [SoundTab](./SoundTab.md) | The sound package: cues, takes, approval |
| Style | [StyleTab](./StyleTab.md) | Narrator, rating, house style, banned phrases, golden scenes |
| Canon | [CanonTab](./CanonTab.md) | What each episode established |
| Voices | `LibraryView` | The character library, opened on the entry "Design voice" just made |

## Behaviour
- Bible edits go to a local draft and autosave (700 ms debounce) through `updateSeries`; `clean()` drops blank lines from one-per-line fields first. Canon saves separately.
- Opening an episode saves first, then `openProjectById` enters the ordinary project workspace. `openSeriesId` stays set, so leaving the episode returns here.
- The episode list refreshes when `seriesStore.episodesVersion` bumps (a write landed).
- On mount it puts the projects dir into `projectStore` if none is there, which the library editor needs to resolve bundles.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | `<SeriesHomeView seriesId>` keyed by id | Prop changes |
| `series.rs` | `get_series`, `update_series`, `list_series_episodes` | Command shape changes |
