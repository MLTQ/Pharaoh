# LibrarySidebar.tsx

## Purpose
Left sidebar of the Character Library: header row with `Import…` / `+ New` actions and the scrollable list of library character summaries. Purely presentational — all state and mutations live in [LibraryView](./LibraryView.md).

## Components

### `LibrarySidebar`
- **Does**: Renders the summary list (color dot, name, palette count, rvc badge), loading/empty states, and the Import / New buttons. Clicking a non-active row with unsaved edits (`dirty`) prompts "Discard unsaved changes?" before calling `onSelect`.
- **Props**: `summaries`, `selectedId`, `loading`, `importing`, `saving`, `dirty`, `onSelect(libraryId)`, `onCreate()`, `onImportFile()`.
- **Interacts with**: `CHAR_HUE` from [libraryShared](./libraryShared.md).
- **Rationale**: Extracted from LibraryView in the Pharaoh-7cx8 split; the discard-confirm stays here (not in the parent) so selection semantics travel with the list UI.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `LibraryView` | `onSelect` is only called after the user confirms discarding unsaved edits | Calling `onSelect` unconditionally would lose edits |
