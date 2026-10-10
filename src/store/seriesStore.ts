import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { writeEpisode } from "../lib/tauriCommands";
import { openProjectById } from "../lib/openProject";
import { errorMessage } from "../lib/errors";
import { useToastStore } from "./toastStore";
import type { EpisodePlan, WriteEpisodeResult } from "../lib/types";

// Which series the launcher shell is showing, and the episode writer's
// progress. Kept apart from projectStore so the one-shot workspace never sees
// series state. Opening an episode leaves openSeriesId set, so leaving the
// episode returns to its series home.

export interface WriterState {
  stage: string;
  message: string;
  startedAt: number;
}

interface SeriesState {
  openSeriesId: string | null;
  openSeries: (id: string) => void;
  closeSeries: () => void;
  /** Running writes, by series id. */
  writing: Record<string, WriterState>;
  /** Bumped when a write lands, so the episode list refreshes. */
  episodesVersion: number;
  startWrite: (args: {
    series_id: string;
    premise: string;
    plan?: EpisodePlan | null;
    punch_up?: boolean;
  }) => Promise<WriteEpisodeResult | null>;
}

let listening = false;

async function listenOnce() {
  if (listening) return;
  listening = true;
  try {
    await listen<{ series_id: string; stage: string; message: string }>("episode-writer", (e) => {
      const { series_id, stage, message } = e.payload;
      useSeriesStore.setState((s) => {
        const cur = s.writing[series_id];
        if (!cur) return s;
        return { writing: { ...s.writing, [series_id]: { ...cur, stage, message } } };
      });
    });
  } catch {
    // Mesh viewers have no Tauri events; the write itself is host-only.
    listening = false;
  }
}

export const useSeriesStore = create<SeriesState>((set, get) => ({
  openSeriesId: null,
  openSeries: (id) => set({ openSeriesId: id }),
  closeSeries: () => set({ openSeriesId: null }),
  writing: {},
  episodesVersion: 0,

  startWrite: async (args) => {
    if (get().writing[args.series_id]) return null;
    await listenOnce();
    set((s) => ({
      writing: {
        ...s.writing,
        [args.series_id]: { stage: "start", message: args.plan ? "Writing the script" : "Breaking the story", startedAt: Date.now() },
      },
    }));
    const done = () =>
      set((s) => {
        const writing = { ...s.writing };
        delete writing[args.series_id];
        return { writing, episodesVersion: s.episodesVersion + 1 };
      });
    try {
      const r = await writeEpisode(args);
      done();
      useToastStore.getState().push({
        kind: "info",
        title: `“${r.project.title}” is written`,
        body: `${r.scenes} scenes${r.new_characters.length ? ` · new: ${r.new_characters.join(", ")}` : ""}`,
        actionLabel: "Open →",
        onAction: () => { openProjectById(r.project.id).catch(() => {}); },
        ttlMs: 30000,
      });
      return r;
    } catch (e) {
      done();
      useToastStore.getState().push({ kind: "error", title: "Episode writer failed", body: errorMessage(e), ttlMs: 20000 });
      return null;
    }
  },
}));
