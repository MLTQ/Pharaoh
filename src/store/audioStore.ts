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
  playSequence: (paths: string[]) => Promise<void>;
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
        audio.onerror = () => {
          // MediaError code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) usually means the
          // asset protocol isn't reaching the file — most often because
          // app.security.assetProtocol.scope in tauri.conf.json doesn't cover
          // this path. Surface that explicitly instead of a vague "failed".
          const code = audio.error?.code;
          const detail = code === 4
            ? `src not reachable (asset protocol scope may not cover this path)`
            : audio.error?.message || `MediaError code ${code ?? "?"}`;
          reject(new Error(`audio preview failed to load: ${detail} — path=${path}`));
        };
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

  // Audio-drama "table read" support. Plays a series of paths back-to-back
  // (typically the placed DIALOGUE clips of a scene). Returns when the
  // sequence completes naturally; if the user invokes stop() or starts a
  // different playback mid-sequence, this aborts gracefully.
  playSequence: async (paths: string[]) => {
    for (const path of paths) {
      // If the sequence was interrupted (user stopped or started something
      // else), abort the rest of the queue.
      const prevPlaying = get().playing;
      if (prevPlaying != null && prevPlaying !== path && prevPlaying !== paths[paths.indexOf(path) - 1]) {
        return;
      }
      await get().play(path);
      // Wait until either the clip ends naturally or the user interrupts.
      // Polled because the store's set() doesn't expose a per-key event.
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          const cur = get().playing;
          if (cur !== path) { clearInterval(id); resolve(); }
        }, 50);
      });
      if (get().playing != null && get().playing !== path) {
        // User started another clip — stop the table-read sequence
        return;
      }
    }
  },
}));
