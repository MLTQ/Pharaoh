import { create } from "zustand";
import { invoke, isTauri } from "../lib/transport";
import { listen } from "@tauri-apps/api/event";

export type ServerStatus = "unknown" | "online" | "offline" | "loading";

export interface ServerHealth {
  status: string;
  model_loaded: boolean;
  model_variant: string;
  vram_mb: number;
  stub: boolean;
  /** TTS server engine: "breeze" (Breeze TTS 2) when it serves port 18001; absent for Qwen. */
  engine?: string;
  audioldm_ready?: boolean;
  audioldm_error?: string;
  audioldm_model?: string;
  audioldm_local_dir?: string;
  audioldm_engine?: string;
  audioldm_cuda?: boolean | null;
  audioldm_loaded?: boolean;
  audiosr_ready?: boolean;
  audiosr_error?: string;
  audiosr_cli?: string;
  // dissect server
  stub_reason?: string;
  separator_ready?: boolean;
  separator_error?: string;
  loaded?: string[];
}

export type ManagedServer = "tts" | "sfx" | "music" | "post" | "dissect";

interface ModelState {
  tts: ServerStatus;
  sfx: ServerStatus;
  music: ServerStatus;
  post: ServerStatus;
  dissect: ServerStatus;
  health: Record<ManagedServer, ServerHealth | null>;
  loadProgress: Record<ManagedServer, number>;
  initListeners: () => Promise<() => void>;
  pollHealth: () => Promise<void>;
  updateServerConfig: (cfg: { tts_url?: string; sfx_url?: string; music_url?: string; post_url?: string }) => Promise<void>;
  loadModel: (kind: ManagedServer, variant?: string) => Promise<void>;
  unloadModel: (kind: ManagedServer) => Promise<void>;
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
  post: "unknown",
  dissect: "unknown",
  health: { tts: null, sfx: null, music: null, post: null, dissect: null },
  loadProgress: { tts: 0, sfx: 0, music: 0, post: 0, dissect: 0 },

  initListeners: async () => {
    // Tauri events don't exist for mesh/browser viewers — progress bars are
    // host-only; health still arrives via pollHealth over HTTP.
    if (!isTauri) return () => {};
    const unlisten = await listen<{ model: string; progress: number }>(
      "model-load-progress",
      ({ payload }) => {
        const kind = payload.model as ManagedServer;
        set((s) => ({ loadProgress: { ...s.loadProgress, [kind]: payload.progress } }));
      }
    );
    return unlisten;
  },

  pollHealth: async () => {
    const [tts, sfx, music, post, dissect] = await Promise.all([
      fetchHealth("tts"),
      fetchHealth("sfx"),
      fetchHealth("music"),
      fetchHealth("post"),
      fetchHealth("dissect"),
    ]);
    set({
      tts: tts ? "online" : "offline",
      sfx: sfx ? "online" : "offline",
      music: music ? "online" : "offline",
      post: post ? "online" : "offline",
      dissect: dissect ? "online" : "offline",
      health: { tts, sfx, music, post, dissect },
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
