import { create } from "zustand";
import type { ViewId, RightTab, ColorTemp, Density } from "../lib/types";

interface UiState {
  view: ViewId;
  rightTab: RightTab;
  colorTemp: ColorTemp;
  density: Density;

  setView: (view: ViewId) => void;
  setRightTab: (tab: RightTab) => void;
  setColorTemp: (temp: ColorTemp) => void;
  setDensity: (density: Density) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "pyramid",
  rightTab: "agent",
  colorTemp: "forest",
  density: "comfortable",

  setView: (view) => set({ view }),
  setRightTab: (rightTab) => set({ rightTab }),
  setColorTemp: (colorTemp) => set({ colorTemp }),
  setDensity: (density) => set({ density }),
}));
