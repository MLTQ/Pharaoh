import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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
  pollHealth: () => Promise<void>;
  updateServerConfig: (cfg: { tts_url?: string; sfx_url?: string; music_url?: string }) => Promise<void>;
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
}));
