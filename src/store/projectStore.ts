import { create } from "zustand";
import type {
  MockProject, MockScene, MockCastMember, MockAssets,
  Project, Scene, Character,
} from "../lib/types";

// ── Scene conversion ─────────────────────────────────────────────────────────

function sceneStatusToMock(status: string): MockScene["status"] {
  switch (status) {
    case "rendered":    return "rendered";
    case "assets_ready":return "ready";
    case "generating":  return "gen";
    default:            return "draft";
  }
}

export function realSceneToMock(scene: Scene): MockScene {
  return {
    no: `S${String(scene.index + 1).padStart(2, "0")}`,
    rev: "01",
    title: scene.title,
    desc: scene.description,
    script: scene.notes,
    status: sceneStatusToMock(scene.status),
    duration: "—",
    nodes: [],
    slug: scene.slug,
  };
}

// ── Slug derivation ──────────────────────────────────────────────────────────

/** Derive a slug from a mock scene — used in demo mode when no real slug exists. */
export function deriveSlug(no: string, title: string): string {
  const index = no.replace(/\D/g, "").padStart(2, "0");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${index}_${slug}`;
}

// ── Empty project defaults ────────────────────────────────────────────────────

const EMPTY_PROJECT: MockProject = {
  title: "",
  subtitle: "",
  logline: "",
  synopsis: "",
  season: "",
  episode: "",
  runtime: "",
  genre: "",
  creator: "",
  revision: "",
  lastSync: "",
};

// ── Store interface ──────────────────────────────────────────────────────────

interface ProjectState {
  project: MockProject;
  scenes: MockScene[];
  cast: MockCastMember[];
  assets: MockAssets;
  activeSceneNo: string;

  characters: Character[];
  selectedCharId: string | null;
  setSelectedChar: (id: string) => void;
  addCharacter: (c: Character) => void;
  removeCharacter: (id: string) => void;
  updateCharacter: (id: string, patch: Partial<Character>) => void;
  updateVoiceAssignment: (id: string, patch: Partial<Character["voice_assignment"]>) => void;

  realProjectId: string | null;
  projectsDir: string | null;
  activeSceneSlug: string | null;

  updateProjectMeta: (patch: Partial<MockProject>) => void;
  setActiveScene: (no: string) => void;
  updateScene: (no: string, patch: Partial<MockScene>) => void;
  loadRealProject: (project: Project, projectsDir: string, scenes: Scene[]) => void;
  setActiveSceneSlug: (slug: string | null) => void;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: EMPTY_PROJECT,
  scenes: [],
  cast: [],
  assets: { dialogue: [], sfx: [], music: [] },
  activeSceneNo: "",

  characters: [],
  selectedCharId: null,

  updateProjectMeta: (patch) =>
    set((state) => ({ project: { ...state.project, ...patch } })),

  setSelectedChar: (id) => set({ selectedCharId: id }),

  addCharacter: (c) =>
    set((state) => ({ characters: [...state.characters, c], selectedCharId: c.id })),

  removeCharacter: (id) =>
    set((state) => {
      const remaining = state.characters.filter((c) => c.id !== id);
      const selectedCharId =
        state.selectedCharId === id ? (remaining[0]?.id ?? null) : state.selectedCharId;
      return { characters: remaining, selectedCharId };
    }),

  updateCharacter: (id, patch) =>
    set((state) => ({
      characters: state.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),

  updateVoiceAssignment: (id, patch) =>
    set((state) => ({
      characters: state.characters.map((c) =>
        c.id === id ? { ...c, voice_assignment: { ...c.voice_assignment, ...patch } } : c
      ),
    })),

  realProjectId: null,
  projectsDir: null,
  activeSceneSlug: null,

  setActiveScene: (no) => {
    const scene = get().scenes.find((s) => s.no === no);
    // Prefer the real slug embedded in the scene, fall back to derivation
    const slug = scene?.slug ?? (scene ? deriveSlug(scene.no, scene.title) : null);
    set({ activeSceneNo: no, activeSceneSlug: slug });
  },

  updateScene: (no, patch) =>
    set((state) => ({
      scenes: state.scenes.map((s) => (s.no === no ? { ...s, ...patch } : s)),
    })),

  loadRealProject: (project, projectsDir, scenes) => {
    const mockScenes = scenes.map(realSceneToMock);
    const firstScene = mockScenes[0];
    const activeSceneNo = firstScene?.no ?? "";
    const activeSceneSlug = firstScene?.slug ?? null;

    set({
      realProjectId: project.id,
      projectsDir,
      activeSceneNo,
      activeSceneSlug,
      scenes: mockScenes,
      characters: project.characters,
      selectedCharId: project.characters[0]?.id ?? null,
      project: {
        title: project.title,
        subtitle: "",
        logline: project.logline,
        synopsis: project.synopsis,
        season: "",
        episode: "",
        runtime: "—",
        genre: project.tone,
        creator: "",
        revision: `v${project.updated_at.slice(0, 10)}`,
        lastSync: new Date().toISOString().replace("T", " ").slice(0, 16),
      },
    });
  },

  setActiveSceneSlug: (slug) => set({ activeSceneSlug: slug }),
}));
