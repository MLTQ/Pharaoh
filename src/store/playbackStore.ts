import { create } from "zustand";

type PlaybackContext = "clip" | "scene" | "final";

interface PlaybackState {
  isPlaying: boolean;
  context: PlaybackContext;
  contextId: string | null;
  positionMs: number;

  play: (context?: PlaybackContext, contextId?: string) => void;
  pause: () => void;
  seek: (ms: number) => void;
  setContext: (context: PlaybackContext, contextId: string | null) => void;
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  isPlaying: false,
  context: "scene",
  contextId: "S04",
  positionMs: 72000,

  play: (context, contextId) =>
    set((state) => ({
      isPlaying: true,
      context: context ?? state.context,
      contextId: contextId ?? state.contextId,
    })),

  pause: () => set({ isPlaying: false }),

  seek: (ms) => set({ positionMs: ms }),

  setContext: (context, contextId) => set({ context, contextId }),
}));
