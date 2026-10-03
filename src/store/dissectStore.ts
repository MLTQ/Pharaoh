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
import { dissectCancel, dissectEmotionStatus, dissectRebuildStatus, dissectRetry, dissectStatus, dissectTagEmotions, listDissectImports } from "../lib/tauriCommands";
import type { RebuildStatus } from "../lib/types";
import { openProjectById } from "../lib/openProject";
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
  /** Re-read an import and put its queue row in its real (terminal) state. */
  settle: (importId: string) => Promise<void>;
  /** Drop an import's queue row and tracking (after it's deleted). */
  forget: (importId: string) => void;
  /** Latest status per rebuild job (recording → project). */
  rebuilds: Record<string, RebuildStatus>;
  /** Follow a rebuild: queue row, progress, and an "Open project" toast when done. */
  trackRebuild: (jobId: string, title: string) => void;
  /** Resolves false (with the queue row failed and a toast) if the re-run couldn't start. */
  retry: (importId: string, sourceName?: string) => Promise<boolean>;
  requestOpen: (importId: string | null) => void;
  /** Emotion tagging in flight, by import id → status line. */
  tagging: Record<string, string>;
  /** Bumped per import when its emotions.json is written, so views re-query. */
  emotionsReady: Record<string, number>;
  /** Tag an import's dialogue with emotions; a queue row follows it. */
  tagEmotions: (importId: string, sourceName: string) => Promise<void>;
}

export const useDissectStore = create<DissectState>((set, get) => ({
  statuses: {},
  openRequest: null,
  rebuilds: {},
  tagging: {},
  emotionsReady: {},

  tagEmotions: async (importId, sourceName) => {
    if (get().tagging[importId]) return;
    const rowId = `emotions-${importId}`;
    const jobs = useJobStore.getState();
    const row = {
      id: rowId, model: "dissect" as const, description: `Read emotions · ${sourceName}`, status: "running" as const,
      progress: 0, eta: "starting", started_at: new Date().toISOString(), scene_id: null, scene_slug: null,
      row_index: null, output_path: null, peaks: null, qa_status: "unreviewed" as const, error: null,
    };
    if (jobs.jobs.some((j) => j.id === rowId)) jobs.updateJob(rowId, row); else jobs.addJob(row);
    set((st) => ({ tagging: { ...st.tagging, [importId]: "Starting" } }));
    const finish = (error: string | null) => {
      set((st) => {
        const { [importId]: _done, ...rest } = st.tagging;
        return { tagging: rest, emotionsReady: error ? st.emotionsReady : { ...st.emotionsReady, [importId]: Date.now() } };
      });
      useJobStore.getState().updateJob(rowId, error
        ? { status: "failed", eta: "failed", error }
        : { status: "complete", progress: 100, eta: "emotions ready" });
      if (error) useToastStore.getState().push({ kind: "error", title: `Reading emotions failed · ${sourceName}`, body: error });
    };
    let jobId: string;
    try {
      jobId = await dissectTagEmotions(importId);
    } catch (e) {
      finish(String(e));
      return;
    }
    const tick = async () => {
      try {
        const s = await dissectEmotionStatus(jobId);
        if (s.done) { finish(s.error); return; }
        set((st) => ({ tagging: { ...st.tagging, [importId]: s.message } }));
        useJobStore.getState().updateJob(rowId, { progress: Math.round(s.progress * 100), eta: s.message });
        window.setTimeout(tick, 1500);
      } catch (e) {
        finish(String(e));
      }
    };
    void tick();
  },

  trackRebuild: (jobId, title) => {
    const id = `rebuild-${jobId}`;
    const jobs = useJobStore.getState();
    if (!jobs.jobs.some((j) => j.id === id)) {
      jobs.addJob({
        id, model: "dissect", description: `Rebuild project · ${title}`, status: "running", progress: 0,
        eta: "starting", started_at: new Date().toISOString(), scene_id: null, scene_slug: null, row_index: null,
        output_path: null, peaks: null, qa_status: "unreviewed", error: null,
      });
    }
    const tick = async () => {
      let s: RebuildStatus;
      try {
        s = await dissectRebuildStatus(jobId);
      } catch (e) {
        useJobStore.getState().updateJob(id, { status: "failed", eta: "failed", error: String(e) });
        return;
      }
      set((st) => ({ rebuilds: { ...st.rebuilds, [jobId]: s } }));
      const update = useJobStore.getState().updateJob;
      if (!s.done) {
        update(id, { progress: Math.round(s.progress * 100), eta: s.message });
        window.setTimeout(tick, 1000);
        return;
      }
      if (s.error || !s.project_id) {
        update(id, { status: "failed", eta: "failed", error: s.error ?? "rebuild failed" });
        useToastStore.getState().push({ kind: "error", title: `Rebuild failed · ${title}`, body: s.error ?? undefined });
        return;
      }
      const pid = s.project_id;
      update(id, { status: "complete", progress: 100, eta: "project ready" });
      useToastStore.getState().push({
        kind: "info", title: `Project rebuilt · ${title}`, body: "Scenes, script, characters and sounds are in place.",
        actionLabel: "Open →", onAction: () => { void openProjectById(pid); },
      });
    };
    void tick();
  },

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
      // Cancelled, settled or forgotten since this loop started: stop, and
      // don't let a poll that was in flight overwrite the row's final state.
      if (!polling.has(importId)) return;
      let s: DissectStatus;
      try {
        s = await dissectStatus(importId);
        if (!polling.has(importId)) return;
      } catch (e) {
        if (!polling.has(importId)) return;
        // The import itself is gone or unreadable — stop, don't spin.
        polling.delete(importId);
        useJobStore.getState().updateJob(id, {
          status: "failed", eta: "failed",
          error: /not found|No such file|os error 2/i.test(String(e)) ? "This import no longer exists (it was deleted)." : String(e),
        });
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
            useUiStore.getState().setView("dissect");
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
    const update = useJobStore.getState().updateJob;
    update(id, { eta: "cancelling…" });
    try {
      // Rust marks the import cancelled locally even if the server is gone,
      // so the row can be finalised now — never left waiting on a poll loop
      // that may not be running (that left rows stuck on "cancelling…").
      await dissectCancel(importId);
      polling.delete(importId);
      update(id, { status: "cancelled", eta: "cancelled", error: null });
      set((st) => {
        const prev = st.statuses[importId];
        return prev ? { statuses: { ...st.statuses, [importId]: { ...prev, status: "cancelled", message: null } } } : {};
      });
    } catch {
      // Already ended (or gone): show what it actually is instead of hanging.
      await get().settle(importId);
    }
  },

  settle: async (importId) => {
    const id = dissectJobId(importId);
    const update = useJobStore.getState().updateJob;
    polling.delete(importId);
    try {
      const s = await dissectStatus(importId);
      set((st) => ({ statuses: { ...st.statuses, [importId]: s } }));
      if (s.status === "running") {
        // Genuinely still running — resume following it.
        update(id, { eta: s.message ?? "running" });
        get().track(importId, names.get(importId) ?? "recording");
      } else if (s.status === "complete") {
        update(id, { status: "complete", progress: 100, eta: "done" });
      } else {
        update(id, { status: s.status, eta: s.status, error: s.status === "failed" ? s.error ?? "failed" : null });
      }
    } catch {
      update(id, { status: "failed", eta: "failed", error: "This import no longer exists (it was deleted)." });
    }
  },

  forget: (importId) => {
    polling.delete(importId);
    names.delete(importId);
    useJobStore.getState().removeJob(dissectJobId(importId));
    set((st) => {
      const { [importId]: _gone, ...rest } = st.statuses;
      return { statuses: rest };
    });
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
