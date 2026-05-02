import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ServerStatus = "unknown" | "online" | "offline" | "loading";

export interface ServerHealth {
  status: string;
  model_loaded: boolean;
  model_variant: string;
  vram_mb: number;
  stub: boolean;
}

interface ModelState {
  tts: ServerStatus;
  sfx: ServerStatus;
  music: ServerStatus;
  health: { tts: ServerHealth | null; sfx: ServerHealth | null; music: ServerHealth | null };
  loadProgress: { tts: number; sfx: number; music: number };
  initListeners: () => Promise<() => void>;
  pollHealth: () => Promise<void>;
  updateServerConfig: (cfg: { tts_url?: string; sfx_url?: string; music_url?: string }) => Promise<void>;
  loadModel: (kind: "tts" | "sfx" | "music", variant?: string) => Promise<void>;
  unloadModel: (kind: "tts" | "sfx" | "music") => Promise<void>;
}

async function fetchHealth(model: string): Promise<ServerHealth | null> {
  try {
    return await invoke<ServerHealth>("check_server_health", { model });
  } catch {
    return null;
  }
}

export const useModelStore = create<ModelState>((set) => ({
  tts: "unknown",
  sfx: "unknown",
  music: "unknown",
  health: { tts: null, sfx: null, music: null },
  loadProgress: { tts: 0, sfx: 0, music: 0 },

  initListeners: async () => {
    const unlisten = await listen<{ model: string; progress: number }>(
      "model-load-progress",
      ({ payload }) => {
        const kind = payload.model as "tts" | "sfx" | "music";
        set((s) => ({ loadProgress: { ...s.loadProgress, [kind]: payload.progress } }));
      }
    );
    return unlisten;
  },

  pollHealth: async () => {
    const [tts, sfx, music] = await Promise.all([
      fetchHealth("tts"),
      fetchHealth("sfx"),
      fetchHealth("music"),
    ]);
    set({
      tts: tts ? "online" : "offline",
      sfx: sfx ? "online" : "offline",
      music: music ? "online" : "offline",
      health: { tts, sfx, music },
    });
  },

  updateServerConfig: async (cfg) => {
    await invoke("update_server_config", cfg);
  },

  loadModel: async (kind, variant) => {
    set((s) => ({ ...s, [kind]: "loading" as ServerStatus, loadProgress: { ...s.loadProgress, [kind]: 0.02 } }));
    try {
      await invoke("load_model", { model: kind, variant: variant ?? null });
    } finally {
      const h = await fetchHealth(kind);
      set((s) => ({
        ...s,
        [kind]: h ? "online" : "offline",
        health: { ...s.health, [kind]: h },
        loadProgress: { ...s.loadProgress, [kind]: 0 },
      }));
    }
  },

  unloadModel: async (kind) => {
    await invoke("unload_model", { model: kind });
    const h = await fetchHealth(kind);
    set((s) => ({
      ...s,
      [kind]: h ? "online" : "offline",
      health: { ...s.health, [kind]: h },
    }));
  },
}));
