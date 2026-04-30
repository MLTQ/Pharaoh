import { create } from "zustand";
import type { Job } from "../lib/types";
import { MOCK_JOBS } from "../lib/mockData";

interface JobState {
  jobs: Job[];
  addJob: (job: Job) => void;
  updateJob: (id: string, update: Partial<Job>) => void;
  removeJob: (id: string) => void;
}

export const useJobStore = create<JobState>((set) => ({
  jobs: MOCK_JOBS,

  addJob: (job) =>
    set((state) => ({ jobs: [job, ...state.jobs] })),

  updateJob: (id, update) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...update } : j)),
    })),

  removeJob: (id) =>
    set((state) => ({ jobs: state.jobs.filter((j) => j.id !== id) })),
}));
