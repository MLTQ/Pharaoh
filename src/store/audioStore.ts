import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

// ── Module-level streaming audio singleton ──────────────────────────────────

let _audio: HTMLAudioElement | null = null;
let _rafId: number | null = null;
let _stopAt: number | null = null;

function playableSrc(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return convertFileSrc(path);
}

function stopCurrent(): void {
  if (_audio) {
    _audio.pause();
    _audio.removeAttribute("src");
    _audio.load();
    _audio = null;
  }
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  _stopAt = null;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface AudioState {
  playing: string | null;  // path of active file
  duration: number;        // seconds
  position: number;        // seconds, raf-updated
  play: (path: string, offsetSeconds?: number, stopAtSeconds?: number | null) => Promise<void>;
  stop: () => void;
  toggle: (path: string) => Promise<void>;
}

export const useAudioStore = create<AudioState>((set, get) => ({
  playing: null,
  duration: 0,
  position: 0,

  stop: () => {
    stopCurrent();
    set({ playing: null, position: 0 });
  },

  play: async (path: string, offsetSeconds = 0, stopAtSeconds: number | null = null) => {
    stopCurrent();
    set({ playing: path, position: offsetSeconds, duration: 0 });
    try {
      const audio = new Audio(playableSrc(path));
      audio.preload = "metadata";
      _audio = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onloadedmetadata = () => resolve();
        audio.onerror = () => reject(new Error("audio preview failed to load"));
      });

      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      const offset = Math.max(0, Math.min(offsetSeconds, duration || offsetSeconds));
      _stopAt = stopAtSeconds == null
        ? null
        : Math.max(offset, duration ? Math.min(stopAtSeconds, duration) : stopAtSeconds);

      audio.currentTime = offset;
      set({ duration, position: offset });

      audio.onended = () => {
        if (_audio === audio) {
          stopCurrent();
          set({ playing: null, position: 0 });
        }
      };

      const tick = () => {
        if (_audio !== audio) return;
        const position = audio.currentTime;
        if (_stopAt !== null && position >= _stopAt) {
          stopCurrent();
          set({ playing: null, position: _stopAt });
          return;
        }
        set({ position });
        _rafId = requestAnimationFrame(tick);
      };

      await audio.play();
      _rafId = requestAnimationFrame(tick);
    } catch (e) {
      console.error("[audioStore] play failed:", e);
      stopCurrent();
      set({ playing: null, position: 0 });
    }
  },

  toggle: async (path: string) => {
    if (get().playing === path) {
      get().stop();
    } else {
      await get().play(path);
    }
  },
}));
