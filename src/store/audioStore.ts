import { create } from "zustand";
import { fileSrc } from "../lib/transport";
import { reportError } from "../lib/errors";

// ── Module-level streaming audio singleton ──────────────────────────────────

let _audio: HTMLAudioElement | null = null;
let _rafId: number | null = null;
let _stopAt: number | null = null;
let _objectUrl: string | null = null;
let _loadController: AbortController | null = null;

async function withPlaybackTimeout<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Audio ${phase} timed out. Check that the file is readable and media playback plugins are available.`,
        )), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function playableSrc(path: string): string {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return fileSrc(path);
}

function stopCurrent(): void {
  _loadController?.abort();
  _loadController = null;
  if (_audio) {
    _audio.pause();
    _audio.removeAttribute("src");
    _audio.load();
    _audio = null;
  }
  if (_objectUrl) {
    URL.revokeObjectURL(_objectUrl);
    _objectUrl = null;
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
    let currentAudio: HTMLAudioElement | null = null;
    try {
      const source = playableSrc(path);
      const audio = new Audio(source);
      currentAudio = audio;
      audio.preload = "metadata";
      _audio = audio;

      let attemptedBlob = false;
      await withPlaybackTimeout(new Promise<void>((resolve, reject) => {
        audio.onloadedmetadata = () => resolve();
        audio.onerror = async () => {
          if (_audio !== audio) return;
          const code = audio.error?.code;
          // WebKitGTK can fetch custom-scheme files but its media pipeline
          // rejects asset:// URLs. Retry through a scoped fetch and Blob URL.
          if (code === 4 && source.startsWith("asset:") && !attemptedBlob) {
            attemptedBlob = true;
            const controller = new AbortController();
            _loadController = controller;
            try {
              const response = await fetch(source, { signal: controller.signal });
              if (!response.ok) throw new Error(`Audio file request failed (HTTP ${response.status}) — path=${path}`);
              const blob = await response.blob();
              if (_audio !== audio) return;
              _loadController = null;
              _objectUrl = URL.createObjectURL(blob);
              audio.src = _objectUrl;
              audio.load();
            } catch (error) {
              reject(error);
            }
            return;
          }
          const detail = code === 4
            ? `unsupported audio or inaccessible file (check media plugins and asset protocol scope)`
            : audio.error?.message || `MediaError code ${code ?? "?"}`;
          reject(new Error(`audio preview failed to load: ${detail} — path=${path}`));
        };
      }), "loading");
      if (_audio !== audio) return;

      // Errors can also arrive after metadata, when the decoder/output starts.
      audio.onerror = () => {
        if (_audio !== audio) return;
        reportError("Playback failed", new Error(audio.error?.message || "Audio decoding or output failed"), { id: "audio-play-failed" });
        stopCurrent();
        set({ playing: null, position: 0 });
      };

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

      await withPlaybackTimeout(audio.play(), "startup");
      if (_audio !== audio) return;
      _rafId = requestAnimationFrame(tick);
    } catch (e) {
      // An older load/start timeout must not stop a newer preview.
      if (currentAudio && _audio !== currentAudio) return;
      // Stable id: scrubbing can retry play rapidly — refresh one toast
      // instead of stacking.
      reportError("Playback failed", e, { id: "audio-play-failed" });
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
