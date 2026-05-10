import { create } from "zustand";
import type { SidecarMeta } from "../lib/tauriCommands";

// Cross-component "regenerate this asset" hand-off.
//
// When the user right-clicks an asset in the AssetBrowser (or anywhere else),
// we read its `.wav.meta.json` sidecar, stash the params here, and route the
// user to the matching generator panel. Each panel watches this store on
// mount + when the request changes, hydrates its inputs from the params,
// and clears the request so it doesn't fire twice.

export type RegenerateModel = "tts" | "sfx" | "music";

export interface RegenerateRequest {
  model: RegenerateModel;
  // The sidecar meta verbatim — caller picks out what it needs (prompt,
  // instruct, speaker, seed, temp, top_p, …) instead of us trying to
  // pre-shape into model-specific params.
  meta: SidecarMeta;
  // The audio path of the source asset, used as a back-reference (e.g. to
  // chain the new take as a sibling in the take family).
  source_path: string;
}

interface RegenerateState {
  pending: RegenerateRequest | null;
  setPending: (req: RegenerateRequest) => void;
  clearPending: () => void;
}

export const useRegenerateStore = create<RegenerateState>((set) => ({
  pending: null,
  setPending: (req) => set({ pending: req }),
  clearPending: () => set({ pending: null }),
}));
