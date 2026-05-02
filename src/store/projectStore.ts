import { create } from "zustand";
import type {
  MockProject, MockScene, MockCastMember, MockAssets,
  Project, Scene, Character,
} from "../lib/types";
import {
  updateProject as saveProjectToTauri,
  updateScene as saveSceneToTauri,
} from "../lib/tauriCommands";

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
  realProject: Project | null;
  realScenes: Scene[];
  projectsDir: string | null;
  activeSceneSlug: string | null;

  updateProjectMeta: (patch: Partial<MockProject>) => void;
  setActiveScene: (no: string) => void;
  updateScene: (no: string, patch: Partial<MockScene>) => void;
  loadRealProject: (project: Project, projectsDir: string, scenes: Scene[]) => void;
  setActiveSceneSlug: (slug: string | null) => void;
  addScene: (scene: Scene) => void;
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useProjectStore = create<ProjectState>((set, get) => {
  /** Fire-and-forget: persist the cached realProject to disk. */
  const persist = () => {
    const { realProject } = get();
    if (!realProject) return;
    saveProjectToTauri(realProject).catch((e) =>
      console.error("[projectStore] save failed:", e)
    );
  };

  return {
    project: EMPTY_PROJECT,
    scenes: [],
    cast: [],
    assets: { dialogue: [], sfx: [], music: [] },
    activeSceneNo: "",

    characters: [],
    selectedCharId: null,
    realProjectId: null,
    realProject: null,
    realScenes: [],
    projectsDir: null,
    activeSceneSlug: null,

    updateProjectMeta: (patch) => {
      set((state) => {
        const project = { ...state.project, ...patch };
        // Mirror editable fields into the real Project for saving
        const realProject = state.realProject ? {
          ...state.realProject,
          ...(patch.title    !== undefined && { title:    patch.title }),
          ...(patch.logline  !== undefined && { logline:  patch.logline }),
          ...(patch.synopsis !== undefined && { synopsis: patch.synopsis }),
          ...(patch.genre    !== undefined && { tone:     patch.genre }),
        } : null;
        return { project, realProject };
      });
      persist();
    },

    setSelectedChar: (id) => set({ selectedCharId: id }),

    addCharacter: (c) => {
      set((state) => {
        const characters = [...state.characters, c];
        return {
          characters,
          selectedCharId: c.id,
          realProject: state.realProject ? { ...state.realProject, characters } : null,
        };
      });
      persist();
    },

    removeCharacter: (id) => {
      set((state) => {
        const characters = state.characters.filter((c) => c.id !== id);
        const selectedCharId =
          state.selectedCharId === id ? (characters[0]?.id ?? null) : state.selectedCharId;
        return {
          characters,
          selectedCharId,
          realProject: state.realProject ? { ...state.realProject, characters } : null,
        };
      });
      persist();
    },

    updateCharacter: (id, patch) => {
      set((state) => {
        const characters = state.characters.map((c) => (c.id === id ? { ...c, ...patch } : c));
        return {
          characters,
          realProject: state.realProject ? { ...state.realProject, characters } : null,
        };
      });
      persist();
    },

    updateVoiceAssignment: (id, patch) => {
      set((state) => {
        const characters = state.characters.map((c) =>
          c.id === id ? { ...c, voice_assignment: { ...c.voice_assignment, ...patch } } : c
        );
        return {
          characters,
          realProject: state.realProject ? { ...state.realProject, characters } : null,
        };
      });
      persist();
    },

    setActiveScene: (no) => {
      const scene = get().scenes.find((s) => s.no === no);
      const slug = scene?.slug ?? (scene ? deriveSlug(scene.no, scene.title) : null);
      set({ activeSceneNo: no, activeSceneSlug: slug });
    },

    updateScene: (no, patch) => {
      set((state) => {
        const scenes = state.scenes.map((s) => (s.no === no ? { ...s, ...patch } : s));
        const mockScene = state.scenes.find((s) => s.no === no);
        const realScenes = mockScene?.slug
          ? state.realScenes.map((s) => {
              if (s.slug !== mockScene.slug) return s;
              return {
                ...s,
                ...(patch.title  !== undefined && { title:       patch.title }),
                ...(patch.desc   !== undefined && { description: patch.desc }),
                ...(patch.script !== undefined && { notes:       patch.script }),
              };
            })
          : state.realScenes;
        return { scenes, realScenes };
      });
      const { realProjectId, realScenes, scenes } = get();
      if (realProjectId) {
        const slug = scenes.find((s) => s.no === no)?.slug;
        const realScene = slug ? realScenes.find((s) => s.slug === slug) : undefined;
        if (realScene) {
          saveSceneToTauri({ projectId: realProjectId, scene: realScene }).catch((e) =>
            console.error("[projectStore] scene save failed:", e)
          );
        }
      }
    },

    loadRealProject: (project, projectsDir, scenes) => {
      const mockScenes = scenes.map(realSceneToMock);
      const firstScene = mockScenes[0];
      const activeSceneNo = firstScene?.no ?? "";
      const activeSceneSlug = firstScene?.slug ?? null;

      set({
        realProjectId: project.id,
        realProject: project,
        realScenes: scenes,
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

    addScene: (scene) =>
      set((state) => {
        const mockScene = realSceneToMock(scene);
        const newScenes = [...state.scenes, mockScene];
        const isFirst = state.scenes.length === 0;
        const slug = deriveSlug(mockScene.no, mockScene.title);
        return {
          scenes: newScenes,
          realScenes: [...state.realScenes, scene],
          ...(isFirst ? { activeSceneNo: mockScene.no, activeSceneSlug: slug } : {}),
        };
      }),
  };
});
