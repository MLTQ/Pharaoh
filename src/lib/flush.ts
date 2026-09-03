/**
 * Explicit "flush your debounced writes now" signal.
 *
 * Several editors coalesce disk writes behind a debounce (the Fountain prose
 * file, per-row script.csv patches). They all need a way to be told "commit
 * whatever you are sitting on immediately" when the user hits Cmd-S.
 *
 * This used to be done by dispatching a synthetic `beforeunload`, since the
 * writers already listened for it. That had a nasty side effect: the Gruve
 * collab session also listens on `beforeunload` to leave the mesh, so every
 * Cmd-S silently ended collaboration for the rest of the session. A dedicated
 * event keeps "save now" and "the window is going away" separate.
 */
export const FLUSH_EVENT = "pharaoh:flush";

/** Ask every debounced writer to commit now. */
export function requestFlush(): void {
  window.dispatchEvent(new Event(FLUSH_EVENT));
}
