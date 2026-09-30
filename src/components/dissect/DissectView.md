# DissectView.tsx

## Purpose
The **Dissect** tab (Story workspace → Source): take an existing audio drama or audiobook apart and pull out what's useful — voices into Library characters, sound effects / ambience / music into scene assets.

## Components

### Imports list (left)
- **Does**: Every import with live status from `dissectStore` (progress % while running), duration and voice count; "Import a recording…" with the separate-stems toggle. Refreshes every 4 s while anything runs.

### Detail (right)
- **Does**: Running → stage message, progress bar, Cancel. Failed / cancelled → the error (e.g. lost contact with the server) with Retry and Delete. Complete → [DissectReview](./DissectReview.md).
- **Interacts with**: `dissectStatus` (initial load), `dissectStore.track` (hands running imports to the tracker), `openRequest` (the completion toast's "Review →").

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `App.tsx` | Renders for `view === "dissect"` | — |
| `LibraryView` / `CharacterDesignerView` | `setView("dissect")` opens this tab | Moving the view |
| `dissectStore.ts` | Consumes and clears `openRequest` | Changing the handshake |
