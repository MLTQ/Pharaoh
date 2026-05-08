import { create } from "zustand";
import type { RenderMeta } from "../lib/tauriCommands";

// Last-rendered scene's measured loudness — surfaces real LUFS / true-peak / LRA
// in the transport bar instead of the placeholder values that used to live in
// App.tsx. Keyed by scene slug so switching scenes updates the readout.

interface RenderMetaState {
  metaBySlug: Record<string, RenderMeta>;
  setMeta: (slug: string, meta: RenderMeta) => void;
  getMeta: (slug: string) => RenderMeta | null;
  clearMeta: (slug: string) => void;
}

export const useRenderMetaStore = create<RenderMetaState>((set, get) => ({
  metaBySlug: {},
  setMeta: (slug, meta) => set((s) => ({ metaBySlug: { ...s.metaBySlug, [slug]: meta } })),
  getMeta: (slug) => get().metaBySlug[slug] ?? null,
  clearMeta: (slug) =>
    set((s) => {
      const next = { ...s.metaBySlug };
      delete next[slug];
      return { metaBySlug: next };
    }),
}));
