import { create } from "zustand";
import type { MockProject, MockScene, MockCastMember, MockAssets, Project } from "../lib/types";
import { MOCK_PROJECT, MOCK_SCENES, MOCK_CAST, MOCK_ASSETS } from "../lib/mockData";

interface ProjectState {
  // UI / mock data (always present, used for rendering)
  project: MockProject;
  scenes: MockScene[];
  cast: MockCastMember[];
  assets: MockAssets;
  activeSceneNo: string;

  // Real Tauri-backed project data (null = demo/browser mode)
  realProjectId: string | null;
  projectsDir: string | null;
  activeSceneSlug: string | null;

  setActiveScene: (no: string) => void;
  updateScene: (no: string, patch: Partial<MockScene>) => void;
  loadRealProject: (project: Project, projectsDir: string) => void;
  setActiveSceneSlug: (slug: string | null) => void;
}

/** Derive a slug from a mock scene (e.g. "S04" + "The Vault Beneath" → "04_the_vault_beneath") */
export function deriveSlug(no: string, title: string): string {
  const index = no.replace(/\D/g, "").padStart(2, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${index}_${slug}`;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: MOCK_PROJECT,
  scenes: MOCK_SCENES,
  cast: MOCK_CAST,
  assets: MOCK_ASSETS,
  activeSceneNo: "S04",

  realProjectId: null,
  projectsDir: null,
  activeSceneSlug: null,

  setActiveScene: (no) => {
    const scene = get().scenes.find((s) => s.no === no);
    const slug = scene ? deriveSlug(scene.no, scene.title) : null;
    set({ activeSceneNo: no, activeSceneSlug: slug });
  },

  updateScene: (no, patch) =>
    set((state) => ({
      scenes: state.scenes.map((s) => (s.no === no ? { ...s, ...patch } : s)),
    })),

  loadRealProject: (project, projectsDir) => {
    set({
      realProjectId: project.id,
      projectsDir,
      project: {
        ...MOCK_PROJECT,
        title: project.title,
        logline: project.logline,
        genre: project.tone,
        lastSync: new Date().toISOString().replace("T", " ").slice(0, 16),
      },
    });
  },

  setActiveSceneSlug: (slug) => set({ activeSceneSlug: slug }),
}));
