import { create } from "zustand";
import type { Job } from "../lib/types";
import { MOCK_JOBS } from "../lib/mockData";

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
}

interface JobFailedEvent {
  job_id: string;
  model: string;
  error: string;
}

interface JobState {
  jobs: Job[];
  addJob: (job: Job) => void;
  updateJob: (id: string, update: Partial<Job>) => void;
  removeJob: (id: string) => void;
  // Returns an unlisten function; call on unmount
  initListeners: () => Promise<() => void>;
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: MOCK_JOBS,

  addJob: (job) =>
    set((state) => ({ jobs: [job, ...state.jobs] })),

  updateJob: (id, update) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...update } : j)),
    })),

  removeJob: (id) =>
    set((state) => ({ jobs: state.jobs.filter((j) => j.id !== id) })),

  initListeners: async () => {
    // Dynamically import to avoid crashing in browser/Vite without Tauri
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
        // Fetch waveform peaks for the completed audio file
        try {
          const { getWaveformPeaks } = await import("../lib/tauriCommands");
          const peaks = await getWaveformPeaks(payload.output_path, 120);
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
      });

      unlisten = [u1, u2, u3];
    } catch {
      // Running in browser without Tauri — no-op
    }

    return () => unlisten.forEach((fn) => fn());
  },
}));
