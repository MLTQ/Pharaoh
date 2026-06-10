# LibraryDetailHeader.tsx

## Purpose
Detail-panel header for the open library character: color dot, inline name editor, Library badge, the Save button (the "dirty" affordance — it lights up to the TTS accent color when there are unsaved edits), and — for persisted entries (`library_id` set) — the `+corpus` export toggle, `Export…`, and `Delete` actions. Purely presentational; save/export/delete logic lives in [LibraryView](./LibraryView.md).

## Components

### `LibraryDetailHeader`
- **Props**: `character`, `dirty`, `saving`, `exporting`, `includeCorpusInExport` + setter, `patch` (name edits), `onSave()`, `onExport()`, `onDelete()`.
- **Interacts with**: `CHAR_HUE` from [libraryShared](./libraryShared.md).
- **Rationale (`+corpus` toggle)**: Export includes the trained RVC model + index always; the raw `rvc_corpus/` (~hundreds of MB) is opt-in — only useful for retraining (Pharaoh-tlt4).

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView` | Export/Delete only rendered when `character.library_id` is set | Showing them for unsaved drafts would hit the backend with a null id |
