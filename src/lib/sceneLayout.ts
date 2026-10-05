/**
 * Lay out a scene on the timeline from the app: commit pending edits, run
 * `layout_scene_rows`, and tell open views to re-read the script.
 *
 * `layoutWhenSceneIdle` arms the same thing to run once a scene has no
 * generation jobs left (Breeze, voice lock and AudioSR included) — used after
 * "generate all" so the scene is ready to play when the takes land.
 */

import { layoutSceneRows, type LayoutReport } from "./tauriCommands";
import { requestFlush } from "./flush";
import { SCRIPT_ASSETS_CHANGED_EVENT } from "./assetRouting";
import { useToastStore } from "../store/toastStore";

export async function layOutScene(projectId: string, sceneSlug: string, replace = false): Promise<LayoutReport> {
  // Debounced row edits must land first, or they'd overwrite the layout.
  requestFlush();
  await new Promise((r) => setTimeout(r, 400));
  const report = await layoutSceneRows({ projectId, sceneSlug, replace });
  window.dispatchEvent(new Event(SCRIPT_ASSETS_CHANGED_EVENT));
  return report;
}

/** Human summary for a toast. */
export function describeLayout(r: LayoutReport): string {
  const parts = [`${r.placed} placed`];
  if (r.kept) parts.push(`${r.kept} kept where you put them`);
  if (r.missing_audio) parts.push(`${r.missing_audio} still need audio`);
  return `${parts.join(" · ")} — scene runs ${Math.round(r.scene_ms / 1000)} s`;
}

const armed = new Map<string, { projectId: string; sceneSlug: string }>();

/** Lay the scene out once none of its jobs are running. */
export function layoutWhenSceneIdle(projectId: string, sceneSlug: string): void {
  armed.set(`${projectId}|${sceneSlug}`, { projectId, sceneSlug });
}

/** Called by the job store after a job finishes; `busy(slug)` says whether
 *  the scene still has jobs running. */
export function checkArmedLayouts(busy: (sceneSlug: string) => boolean): void {
  for (const [key, { projectId, sceneSlug }] of armed) {
    if (busy(sceneSlug)) continue;
    armed.delete(key);
    layOutScene(projectId, sceneSlug)
      .then((r) => useToastStore.getState().push({ kind: "info", title: "Scene laid out", body: describeLayout(r) }))
      .catch((e) => useToastStore.getState().push({ kind: "warn", title: "Scene layout didn't run", body: String(e) }));
  }
}
