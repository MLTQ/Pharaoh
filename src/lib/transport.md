# transport.ts

## Purpose
Single seam between the UI and its backend transport: Tauri IPC in the desktop
app, the Gruve share server's HTTP mirror in browser/mesh viewers. Exists so
the ~80 wrappers in tauriCommands.ts (and audio src resolution) work unchanged
for remote friends, per the Gruve contract ("invoke() does not exist for
remote viewers").

## Components

### `isTauri` / `isMeshViewer`
- **Does**: Runtime detection via `__TAURI_INTERNALS__`.
- **Interacts with**: gruveCollab.ts (session flavor), App.tsx (viewer badge).

### `invoke`
- **Does**: Tauri `invoke` or `POST {API}/invoke/{cmd}` with identical
  camelCase args; non-OK responses throw with the server's message.
- **Interacts with**: every wrapper in `tauriCommands.ts`; server side is
  `dispatch` in `src-tauri/src/share.rs`.

### `fileSrc`
- **Does**: Host file path → playable URL (`convertFileSrc` vs `/file?path=`).
- **Interacts with**: `audioStore.playableSrc`, `SpatializeModal`.

### `API`
- **Does**: `apiBase("api", { fallback: "http://127.0.0.1:18010" })` from
  gruve-sdk — mesh path when served through an agent, localhost fallback for
  standalone browser dev. The localhost literal is the SDK-sanctioned fallback
  exemption (DESIGN-FOR-GRUVE.md §1); port must match `share_port` default in
  `src-tauri/src/models.rs`.

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `tauriCommands.ts` | `invoke<T>(cmd, args?)` drop-in for Tauri's | signature |
| `audioStore.ts`, `SpatializeModal.tsx` | `fileSrc(path)` returns loadable URL | removing Range support server-side breaks WebKit seek |
| `gruveCollab.ts` | `isTauri` correct before first render | — |
| `share.rs` | args serialized camelCase, response is plain JSON of the command result | arg casing |
