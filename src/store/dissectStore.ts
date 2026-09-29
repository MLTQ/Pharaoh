/**
 * dissectStore.ts
 *
 * Background tracker for running dissect imports. Each tracked import gets a
 * row in the job queue (model "dissect") that follows the server's stage
 * message and progress, independent of whether the import modal is open —
 * closing the modal no longer freezes the job. Running imports are resumed on
 * app start (`resumeRunning`), so the queue survives a restart.
 *
 * On completion a toast offers "Review →", which switches to the Library and
 * asks it (via `openRequest`) to open the modal straight at that import.
 * `cancel` / `retry` back the queue row's buttons.
 */

import { create } from "zustand";
import type { DissectStatus, Job } from "../lib/types";
import { dissectCancel, dissectRetry, dissectStatus, listDissectImports } from "../lib/tauriCommands";
import { useJobStore } from "./jobStore";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";

const POLL_MS = 1500;

/** Queue row id for an import. */
export const dissectJobId = (importId: string) => `dissect-${importId}`;

// Imports with a live poll loop, so track() is idempotent.
const polling = new Set<string>();
// Source names by import, so retry can re-label and re-track.
const names = new Map<string, string>();

/** Import id behind a queue row, or null for non-dissect rows. */
export const importIdOfJob = (jobId: string): string | null =>
  jobId.startsWith("dissect-") ? jobId.slice("dissect-".length) : null;

interface DissectState {
  /** Latest status per tracked import. */
  statuses: Record<string, DissectStatus>;
  /** An import the Library should open for review, set by the completion toast. */
  openRequest: string | null;
  track: (importId: string, sourceName: string) => void;
  resumeRunning: () => Promise<void>;
  cancel: (importId: string) => Promise<void>;
  /** Resolves false (with the queue row failed and a toast) if the re-run couldn't start. */
  retry: (importId: string, sourceName?: string) => Promise<boolean>;
  requestOpen: (importId: string | null) => void;
}

export const useDissectStore = create<DissectState>((set, get) => ({
  statuses: {},
  openRequest: null,

  requestOpen: (importId) => set({ openRequest: importId }),

  track: (importId, sourceName) => {
    if (polling.has(importId)) return;
    polling.add(importId);
    names.set(importId, sourceName);

    const jobs = useJobStore.getState();
    const id = dissectJobId(importId);
    if (jobs.jobs.some((j) => j.id === id)) {
      // Retrying: reuse the row rather than stacking a second one.
      jobs.updateJob(id, { status: "running", progress: 0, eta: "starting", error: null });
    } else {
      const job: Job = {
        id,
        model: "dissect",
        description: `Dissect · ${sourceName}`,
        status: "running",
        progress: 0,
        eta: "starting",
        started_at: new Date().toISOString(),
        scene_id: null,
        scene_slug: null,
        row_index: null,
        output_path: null,
        peaks: null,
        qa_status: "unreviewed",
        error: null,
      };
      jobs.addJob(job);
    }

    const tick = async () => {
      let s: DissectStatus;
      try {
        s = await dissectStatus(importId);
      } catch (e) {
        // The import itself is gone or unreadable — stop, don't spin.
        polling.delete(importId);
        useJobStore.getState().updateJob(id, { status: "failed", eta: "failed", error: String(e) });
        return;
      }
      set((st) => ({ statuses: { ...st.statuses, [importId]: s } }));
      const update = useJobStore.getState().updateJob;

      if (s.status === "complete") {
        polling.delete(importId);
        const m = s.manifest;
        const speakers = m?.speakers.length ?? 0;
        const chapters = m?.chapters?.length ?? 0;
        update(id, {
          status: "complete",
          progress: 100,
          eta: `${speakers} speaker${speakers === 1 ? "" : "s"}`,
          output_path: `${s.import_dir}/manifest.json`,
        });
        useToastStore.getState().push({
          kind: "info",
          title: `Dissect finished · ${sourceName}`,
          body: `${speakers} speaker${speakers === 1 ? "" : "s"}${chapters ? ` · ${chapters} chapters` : ""}`,
          actionLabel: "Review →",
          onAction: () => {
            useUiStore.getState().setView("library");
            get().requestOpen(importId);
          },
        });
        return;
      }
      if (s.status === "cancelled") {
        polling.delete(importId);
        update(id, { status: "cancelled", eta: "cancelled", error: null });
        return;
      }
      if (s.status === "failed") {
        polling.delete(importId);
        update(id, { status: "failed", eta: "failed", error: s.error ?? "dissect failed" });
        useToastStore.getState().push({
          kind: "error", title: `Dissect failed · ${sourceName}`, body: s.error ?? undefined,
        });
        return;
      }
      update(id, {
        status: "running",
        progress: Math.round(s.progress * 100),
        eta: s.message ?? "",
      });
      window.setTimeout(tick, POLL_MS);
    };
    void tick();
  },

  cancel: async (importId) => {
    const id = dissectJobId(importId);
    useJobStore.getState().updateJob(id, { eta: "cancelling…" });
    try {
      await dissectCancel(importId);
      // The poll loop sees "cancelled" on its next tick and finalises the row.
    } catch (e) {
      useToastStore.getState().push({ kind: "error", title: "Cancel failed", body: String(e) });
    }
  },

  retry: async (importId, sourceName) => {
    const id = dissectJobId(importId);
    const name = sourceName ?? names.get(importId)
      ?? useJobStore.getState().jobs.find((j) => j.id === id)?.description.replace(/^Dissect · /, "")
      ?? "recording";
    useJobStore.getState().updateJob(id, { status: "running", progress: 0, eta: "resubmitting", error: null });
    try {
      await dissectRetry(importId);
      get().track(importId, name);
      return true;
    } catch (e) {
      useJobStore.getState().updateJob(id, { status: "failed", eta: "failed", error: String(e) });
      useToastStore.getState().push({ kind: "error", title: "Retry failed", body: String(e) });
      return false;
    }
  },

  resumeRunning: async () => {
    try {
      const imports = await listDissectImports();
      for (const imp of imports) {
        if (imp.status === "running") get().track(imp.import_id, imp.source_name);
      }
    } catch {
      // Mesh/browser viewers have no dissect commands — nothing to resume.
    }
  },
}));
