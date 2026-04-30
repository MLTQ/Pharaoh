import { create } from "zustand";

// ── Module-level Web Audio singletons ────────────────────────────────────────

let _ctx: AudioContext | null = null;
let _source: AudioBufferSourceNode | null = null;
let _startTime = 0;
let _rafId: number | null = null;

function getCtx(): AudioContext {
  if (!_ctx) _ctx = new AudioContext();
  return _ctx;
}

function stopCurrent(): void {
  if (_source) {
    try { _source.stop(); } catch { /* already stopped */ }
    _source.disconnect();
    _source = null;
  }
  if (_rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AudioState {
  playing: string | null;  // path of active file
  duration: number;        // seconds
  position: number;        // seconds, raf-updated
  play: (path: string) => Promise<void>;
  stop: () => void;
  toggle: (path: string) => Promise<void>;
}

async function loadArrayBuffer(path: string): Promise<ArrayBuffer> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const u8 = await readFile(path);
    // Slice to own the exact bytes (Uint8Array may be a view into a larger buffer)
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  } catch {
    // Browser fallback — works only if path is a valid URL
    const resp = await fetch(path);
    return resp.arrayBuffer();
  }
}

export const useAudioStore = create<AudioState>((set, get) => ({
  playing: null,
  duration: 0,
  position: 0,

  stop: () => {
    stopCurrent();
    set({ playing: null, position: 0 });
  },

  play: async (path: string) => {
    stopCurrent();
    set({ playing: path, position: 0, duration: 0 });
    try {
      const ctx = getCtx();
      if (ctx.state === "suspended") await ctx.resume();

      const arrayBuffer = await loadArrayBuffer(path);
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      _source = source;
      _startTime = ctx.currentTime;

      set({ duration: audioBuffer.duration });

      source.onended = () => {
        if (_source === source) {
          stopCurrent();
          set({ playing: null, position: 0 });
        }
      };
      source.start(0);

      // Update position via requestAnimationFrame
      const tick = () => {
        if (_source !== source) return;
        set({ position: Math.min(ctx.currentTime - _startTime, audioBuffer.duration) });
        _rafId = requestAnimationFrame(tick);
      };
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
