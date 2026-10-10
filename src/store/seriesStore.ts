import { create } from "zustand";

// Which series the launcher shell is showing. Kept apart from projectStore so
// the one-shot workspace never sees series state. Opening an episode leaves
// this set, so leaving the episode returns to its series home.
interface SeriesState {
  openSeriesId: string | null;
  openSeries: (id: string) => void;
  closeSeries: () => void;
}

export const useSeriesStore = create<SeriesState>((set) => ({
  openSeriesId: null,
  openSeries: (id) => set({ openSeriesId: id }),
  closeSeries: () => set({ openSeriesId: null }),
}));
