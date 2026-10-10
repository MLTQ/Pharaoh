# SeriesHomeView.tsx

## Purpose
The home of one series, shown in the launcher shell (no project open) when `seriesStore.openSeriesId` is set. Tabs: **Episodes** (create and open), **Bible** (premise, format, tone, themes, world, continuity, length), **Cast** (the troupe: archetype, want, flaw, engine, how they talk, catchphrases, lazzi, never, relationships, library voice).

## Behaviour
- Edits go to a local draft and autosave (700 ms debounce) through `updateSeries`. `clean()` drops blank lines from one-per-line fields before saving.
- Opening or creating an episode saves first, then calls `openProjectById`, which enters the ordinary project workspace. `openSeriesId` stays set, so leaving the episode returns here.
- Archetypes (`lib/archetypes.ts`) fill only empty fields.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | `<SeriesHomeView seriesId>` keyed by id | Prop changes |
| `series.rs` | `get_series`, `update_series`, `list_series_episodes`, `create_series_episode` | Command shape changes |
