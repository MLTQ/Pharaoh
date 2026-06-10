// Runtime-adaptive command transport.
//
// Pharaoh's UI runs in two homes: the Tauri webview (the host's desktop app,
// commands via IPC) and a plain browser (mesh friends opening the app through
// a Gruve agent — no Tauri, commands via the share server's HTTP mirror).
// Everything in tauriCommands.ts routes through `invoke` here, so the rest of
// the app never knows which transport it's on.

import { invoke as tauriInvoke, convertFileSrc } from "@tauri-apps/api/core";
import { apiBase } from "gruve-sdk";

/** True when running inside the Tauri webview (the host's desktop app). */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True when this page is a mesh/browser viewer rather than the desktop app. */
export const isMeshViewer = !isTauri;

// Served through a Gruve agent this resolves to the mesh path that reaches the
// share server (declared as upstream "api" in the Rust announce). The fallback
// is for standalone browser dev only — in the Tauri webview invoke() is used
// and this URL never fires.
const API = apiBase("api", { fallback: "http://127.0.0.1:18010" });

/**
 * Drop-in replacement for @tauri-apps/api `invoke`. In the browser it POSTs
 * the same camelCase args to the share server, which dispatches into the same
 * Rust command functions. Host-only commands reject with the server's 403
 * message ("…is host-only…"), which surfaces through the normal error toasts.
 */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  const res = await fetch(`${API}/invoke/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `${cmd} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * URL an <audio>/<video> element can actually load for a host-side file path.
 * Tauri: the asset protocol. Browser viewers: the share server's /file route
 * (Range-aware, restricted to the projects dir).
 */
export function fileSrc(path: string): string {
  if (isTauri) return convertFileSrc(path);
  return `${API}/file?path=${encodeURIComponent(path)}`;
}
