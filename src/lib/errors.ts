import { useToastStore } from "../store/toastStore";

/**
 * Extract a human-readable message from an unknown thrown value.
 * Tauri invoke() rejections are usually plain strings; JS errors are Error
 * instances; some libraries throw objects with a `message` field.
 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Report a failure the user should know about: logs the full value to the
 * console (for debugging) and raises an error toast with a readable message.
 *
 * Use for user-initiated actions (save, generate, import, render…).
 * For background noise nobody can act on, plain console.error is still fine.
 *
 * Pass a stable `id` for failures that can repeat rapidly (debounced saves,
 * scrubbing): toastStore.push appends duplicates, so reportError dismisses
 * any existing toast with that id first — the toast refreshes in place
 * instead of stacking.
 */
export function reportError(
  title: string,
  e: unknown,
  opts?: { actionLabel?: string; onAction?: () => void; id?: string },
): void {
  console.error(`[${title}]`, e);
  const store = useToastStore.getState();
  if (opts?.id) store.dismiss(opts.id);
  store.push({
    kind: "error",
    title,
    body: errorMessage(e),
    actionLabel: opts?.actionLabel,
    onAction: opts?.onAction,
    id: opts?.id,
  });
}
