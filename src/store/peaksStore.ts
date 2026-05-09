import { create } from "zustand";
import { getWaveformPeaks } from "../lib/tauriCommands";

// Session-scoped cache of waveform peaks keyed by `<audio_path>:<num_peaks>`.
//
// The Rust side already caches peaks on disk so first-ever computation is paid
// at most once per (file, resolution) pair. This store layers an in-memory
// cache on top so we don't even round-trip Tauri after the first call within
// a session — every subsequent panel mount reads from this map directly.

type Key = string; // `${path}|${numPeaks}`
function keyFor(path: string, numPeaks: number): Key {
  return `${path}|${numPeaks}`;
}

interface PeaksState {
  // Resolved peaks
  cache: Record<Key, number[]>;
  // In-flight requests, deduped — multiple components asking for the same file
  // share one Tauri call.
  inflight: Record<Key, Promise<number[]>>;

  /** Get peaks, hitting cache → inflight → Tauri in that order. */
  fetchPeaks: (path: string, numPeaks: number) => Promise<number[]>;
  /** Synchronous read; returns null if not cached. Useful in render paths. */
  peek: (path: string, numPeaks: number) => number[] | null;
  /** Drop a cached entry — call when an asset is regenerated/overwritten. */
  invalidate: (path: string) => void;
}

export const usePeaksStore = create<PeaksState>((set, get) => ({
  cache: {},
  inflight: {},

  fetchPeaks: async (path, numPeaks) => {
    const key = keyFor(path, numPeaks);
    const cached = get().cache[key];
    if (cached) return cached;
    const inflight = get().inflight[key];
    if (inflight) return inflight;
    const promise = getWaveformPeaks(path, numPeaks)
      .then((peaks) => {
        set((s) => {
          const nextInflight = { ...s.inflight };
          delete nextInflight[key];
          return { cache: { ...s.cache, [key]: peaks }, inflight: nextInflight };
        });
        return peaks;
      })
      .catch((err) => {
        set((s) => {
          const nextInflight = { ...s.inflight };
          delete nextInflight[key];
          return { inflight: nextInflight };
        });
        throw err;
      });
    set((s) => ({ inflight: { ...s.inflight, [key]: promise } }));
    return promise;
  },

  peek: (path, numPeaks) => get().cache[keyFor(path, numPeaks)] ?? null,

  invalidate: (path) => {
    set((s) => {
      const nextCache: Record<Key, number[]> = {};
      for (const [k, v] of Object.entries(s.cache)) {
        if (!k.startsWith(`${path}|`)) nextCache[k] = v;
      }
      return { cache: nextCache };
    });
  },
}));
