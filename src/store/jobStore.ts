import { create } from "zustand";
import type { Job, QaJobStatus } from "../lib/types";
import { useToastStore } from "./toastStore";
import { useUiStore } from "./uiStore";

const OOM_MARKERS = ["TTS_OOM", "SFX_OOM", "MUSIC_OOM"] as const;

const MODEL_LABEL: Record<string, string> = {
  tts: "TTS",
  sfx: "SFX",
  music: "Music",
  post: "Post",
  dissect: "Dissect",
};

interface JobProgressEvent {
  job_id: string;
  model: string;
  status: string;
  progress: number;
}

interface JobCompleteEvent {
  job_id: string;
  model: string;
  output_path: string;
  project_id: string;
  scene_slug: string;
  row_index: number;
  duration_ms: number | null;
  bound_to_script: boolean;
}

interface JobFailedEvent {
  job_id: string;
  model: string;
  error: string;
}

export function takeKey(sceneSlug: string, rowIndex: number): string {
  return `${sceneSlug}:${rowIndex}`;
}

interface JobState {
  jobs: Job[];
  // Maps "{scene_slug}:{row_index}" → job_id of the active (selected) take
  activeTakes: Record<string, string>;
  addJob: (job: Job) => void;
  updateJob: (id: string, update: Partial<Job>) => void;
  removeJob: (id: string) => void;
  /** Remove every complete / failed / cancelled row. Returns how many went. */
  clearFinished: () => number;
  setActiveTake: (sceneSlug: string, rowIndex: number, jobId: string) => void;
  setQaStatus: (jobId: string, status: QaJobStatus) => void;
  // Returns an unlisten function; call on unmount
  initListeners: () => Promise<() => void>;
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: [],
  activeTakes: {},

  addJob: (job) =>
    set((state) => ({ jobs: [job, ...state.jobs] })),

  updateJob: (id, update) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...update } : j)),
    })),

  clearFinished: () => {
    const before = get().jobs.length;
    set((state) => ({ jobs: state.jobs.filter((j) => j.status === "running" || j.status === "pending") }));
    return before - get().jobs.length;
  },

  removeJob: (id) =>
    set((state) => ({ jobs: state.jobs.filter((j) => j.id !== id) })),

  setActiveTake: (sceneSlug, rowIndex, jobId) =>
    set((state) => ({
      activeTakes: { ...state.activeTakes, [takeKey(sceneSlug, rowIndex)]: jobId },
    })),

  setQaStatus: (jobId, status) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, qa_status: status } : j)),
    })),

  initListeners: async () => {
    let unlisten: Array<() => void> = [];
    try {
      const { listen } = await import("@tauri-apps/api/event");

      const u1 = await listen<JobProgressEvent>("job-progress", ({ payload }) => {
        get().updateJob(payload.job_id, {
          status: payload.status as Job["status"],
          progress: payload.progress * 100,
        });
      });

      const u2 = await listen<JobCompleteEvent>("job-complete", async ({ payload }) => {
        get().updateJob(payload.job_id, {
          status: "complete",
          progress: 100,
          output_path: payload.output_path,
        });

        // Auto-select as active take if this row has no active take yet
        const key = takeKey(payload.scene_slug, payload.row_index);
        if (payload.model !== "post" && !get().activeTakes[key]) {
          get().setActiveTake(payload.scene_slug, payload.row_index, payload.job_id);
        }

        // AudioSR clean-up: the character asked for every take to be cleaned.
        // Run the speech model on it, and when that job completes, bind the
        // cleaned file to the same script row in place of the raw take.
        const done = get().jobs.find((j) => j.id === payload.job_id);
        if (done?.audiosr && payload.model !== "post" && payload.output_path) {
          void (async () => {
            try {
              const { upscaleAudioAsset } = await import("../lib/tauriCommands");
              const srId = `audiosr-${payload.job_id}`;
              get().addJob({
                id: srId, model: "post", description: `AudioSR · ${done.description}`, status: "running",
                progress: 0, eta: "cleaning up", started_at: new Date().toISOString(), scene_id: null,
                scene_slug: done.scene_slug, row_index: done.row_index, output_path: null, peaks: null,
                qa_status: "unreviewed", error: null, project_id: done.project_id, cleans_row: true,
              });
              await upscaleAudioAsset({ inputPath: payload.output_path, jobId: srId, modelName: "speech", ddimSteps: 50, guidanceScale: 3.5, seed: 0 });
            } catch (e) {
              useToastStore.getState().push({ kind: "warn", title: "AudioSR clean-up didn't start", body: String(e) });
            }
          })();
        }
        if (done?.cleans_row && done.project_id && done.scene_slug && done.row_index != null && payload.output_path) {
          try {
            const { updateScriptRow } = await import("../lib/tauriCommands");
            await updateScriptRow({ projectId: done.project_id, sceneSlug: done.scene_slug, rowIndex: done.row_index, fields: { file: payload.output_path } });
          } catch (e) {
            useToastStore.getState().push({ kind: "warn", title: "Cleaned take not placed", body: String(e) });
          }
        }

        // Fetch waveform peaks via the session cache so the panels that later
        // ask for the same file get an instant hit instead of recomputing.
        try {
          const { usePeaksStore } = await import("./peaksStore");
          const peaks = await usePeaksStore.getState().fetchPeaks(payload.output_path, 120);
          get().updateJob(payload.job_id, { peaks });
        } catch {
          // Not fatal — peaks stay null, Wave fallback renders instead
        }
      });

      const u3 = await listen<JobFailedEvent>("job-failed", ({ payload }) => {
        get().updateJob(payload.job_id, {
          status: "failed",
          error: payload.error,
        });

        // Surface memory-related load failures as a toast that routes to the model manager.
        const oomMarker = OOM_MARKERS.find((m) => payload.error.includes(m));
        if (oomMarker) {
          const detail = payload.error.split(`${oomMarker}:`)[1]?.trim() ?? payload.error;
          const label = MODEL_LABEL[payload.model] ?? payload.model;
          useToastStore.getState().push({
            kind: "warn",
            title: `Not enough memory to load ${label} model`,
            body: detail,
            actionLabel: "Open Models →",
            onAction: () => useUiStore.getState().setView("models"),
            ttlMs: 0, // sticky — user must dismiss or click action
          });
        }
      });

      unlisten = [u1, u2, u3];
    } catch {
      // Running in browser without Tauri — no-op
    }

    return () => unlisten.forEach((fn) => fn());
  },
}));
