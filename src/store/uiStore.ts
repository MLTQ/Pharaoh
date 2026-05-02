import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ViewId, RightTab, ColorTemp, Density } from "../lib/types";

interface UiState {
  view: ViewId;
  rightTab: RightTab;
  colorTemp: ColorTemp;
  density: Density;
  agentActiveUntil: number | null;

  setView: (view: ViewId) => void;
  setRightTab: (tab: RightTab) => void;
  setColorTemp: (temp: ColorTemp) => void;
  setDensity: (density: Density) => void;
  triggerAgentActive: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: "pyramid",
      rightTab: "agent",
      colorTemp: "forest",
      density: "comfortable",
      agentActiveUntil: null,

      setView: (view) => set({ view }),
      setRightTab: (rightTab) => set({ rightTab }),
      setColorTemp: (colorTemp) => set({ colorTemp }),
      setDensity: (density) => set({ density }),
      triggerAgentActive: () => set({ agentActiveUntil: Date.now() + 10_000 }),
    }),
    {
      name: "pharaoh-ui",
      partialize: (s) => ({
        view: s.view,
        rightTab: s.rightTab,
        colorTemp: s.colorTemp,
        density: s.density,
      }),
    }
  )
);
