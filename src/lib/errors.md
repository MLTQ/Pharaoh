# errors.ts

## Purpose

Single place to turn a thrown value into something the user can read, and to
surface user-facing failures as error toasts instead of silent `console.error`.

## Contracts

- `errorMessage(e: unknown): string` — best-effort readable message. Handles
  Tauri invoke rejections (plain strings), `Error` instances, and
  `{ message }` objects; falls back to JSON/String coercion. Never throws.
- `reportError(title, e, opts?)` — logs the raw value with a `[title]` prefix
  for debugging, then pushes an `error` toast via `toastStore` with
  `errorMessage(e)` as the body. Optional `actionLabel`/`onAction` route the
  user somewhere useful (mirrors the jobStore OOM-toast pattern).
- `opts.id` — stable toast id for failures that can repeat rapidly (debounced
  saves, scrubbing). `toastStore.push` appends duplicates, so `reportError`
  dismisses any existing toast with that id before pushing: the toast
  refreshes in place (and its TTL resets) instead of stacking. Callers that
  retry-and-succeed can `toastStore.dismiss(id)` on success — projectStore
  does this for `project-save-failed` / `scene-save-failed`.

## When to use

- **Use `reportError`** for failures of user-initiated actions: project/scene
  saves, generation submission, import/export, render, library operations.
- **Keep `console.error`** for background noise the user cannot act on
  (e.g. an optional cache refresh).

## Dependencies

- `store/toastStore` — toast queue. This module must stay dependency-light so
  any store or component can import it without cycles (toastStore imports
  nothing from lib/).
