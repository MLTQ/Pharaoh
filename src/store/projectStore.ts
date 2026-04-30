import { create } from "zustand";
import type { MockProject, MockScene, MockCastMember, MockAssets } from "../lib/types";
import { MOCK_PROJECT, MOCK_SCENES, MOCK_CAST, MOCK_ASSETS } from "../lib/mockData";

interface ProjectState {
  project: MockProject;
  scenes: MockScene[];
  cast: MockCastMember[];
  assets: MockAssets;
  activeSceneNo: string;

  setActiveScene: (no: string) => void;
  updateScene: (no: string, patch: Partial<MockScene>) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  project: MOCK_PROJECT,
  scenes: MOCK_SCENES,
  cast: MOCK_CAST,
  assets: MOCK_ASSETS,
  activeSceneNo: "S04",

  setActiveScene: (no) => set({ activeSceneNo: no }),

  updateScene: (no, patch) =>
    set((state) => ({
      scenes: state.scenes.map((s) => (s.no === no ? { ...s, ...patch } : s)),
    })),
}));
