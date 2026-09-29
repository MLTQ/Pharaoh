# M4bExportPanel.tsx

## Purpose
Final Assembly's audiobook export: the rendered episode (`output/final.wav`) as a chaptered `.m4b` with cover art and tags — the format audiobook apps (Apple Books, BookPlayer, Smart AudioBook Player, Plex) expect.

## Components

### Cover
- **Does**: Shows the project's remembered cover (`getProjectCover`) or a newly picked one. A picked image is only persisted when an export succeeds — Rust copies it to `<project>/cover.jpg|png` and later exports reuse it.

### Tags
- **Does**: Author (artist + album_artist), narrator/cast (composer — the tag Apple uses for narrator), and AAC bitrate. Author/narrator/bitrate are remembered per project in `localStorage` (per-viewer convenience; wrapped in try/catch).

### Chapters
- **Does**: Previews `getEpisodeChapters` — one per scene, titled from the storyboard, at the crossfade-adjusted positions `render_episode` recorded. Re-reads when the parent bumps `renderVersion`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `FinalAssemblyView.tsx` | Props `projectId`, `projectTitle`, `finalReady`, `renderVersion` | Prop changes |
| `commands/audiobook.rs` | `export_episode_m4b` returns `M4bExport` with `chapters`, `bytes`, `cover_path` | Result shape |
