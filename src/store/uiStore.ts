import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ViewId, WorkspaceId, RightTab, ColorTemp, Density } from "../lib/types";
import { WORKSPACE_OF, WORKSPACE_DEFAULT_VIEW } from "../lib/types";

interface UiState {
  view: ViewId;
  // Per-workspace memory of the last sub-view the user was on. Switching
  // back to a workspace via the rail returns you to where you were.
  lastViewByWorkspace: Partial<Record<WorkspaceId, ViewId>>;
  rightTab: RightTab;
  colorTemp: ColorTemp;
  density: Density;
  agentActiveUntil: number | null;

  setView: (view: ViewId) => void;
  /** Rail click: switch to a workspace's last-used view (or its default). */
  setWorkspace: (workspace: WorkspaceId) => void;
  setRightTab: (tab: RightTab) => void;
  setColorTemp: (temp: ColorTemp) => void;
  setDensity: (density: Density) => void;
  triggerAgentActive: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      view: "pyramid",
      lastViewByWorkspace: {},
      rightTab: "agent",
      colorTemp: "forest",
      density: "comfortable",
      agentActiveUntil: null,

      setView: (view) => {
        const ws = WORKSPACE_OF[view];
        set((s) => ({
          view,
          lastViewByWorkspace: { ...s.lastViewByWorkspace, [ws]: view },
        }));
      },
      setWorkspace: (workspace) => {
        const remembered = get().lastViewByWorkspace[workspace];
        const target = remembered ?? WORKSPACE_DEFAULT_VIEW[workspace];
        set((s) => ({
          view: target,
          lastViewByWorkspace: { ...s.lastViewByWorkspace, [workspace]: target },
        }));
      },
      setRightTab: (rightTab) => set({ rightTab }),
      setColorTemp: (colorTemp) => set({ colorTemp }),
      setDensity: (density) => set({ density }),
      triggerAgentActive: () => set({ agentActiveUntil: Date.now() + 10_000 }),
    }),
    {
      name: "pharaoh-ui",
      partialize: (s) => ({
        view: s.view,
        lastViewByWorkspace: s.lastViewByWorkspace,
        rightTab: s.rightTab,
        colorTemp: s.colorTemp,
        density: s.density,
      }),
    }
  )
);
