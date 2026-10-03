/**
 * libraryShared.ts
 *
 * Shared constants, types, and pure helpers for the Character Library
 * components (LibraryView + its extracted tabs/widgets). No React state —
 * everything here is either a constant, a pure function, or a type alias.
 */

import type React from "react";
import type { TakeRow } from "../shared/TakeList";
import type { Character, VoicePipelineStage } from "../../lib/types";
import { reportError } from "../../lib/errors";

// Synthetic "project id" used at every backend path-resolution site so the
// existing tts/sidecar/corpus commands route to <projects_dir>/_library/
// instead of an actual project dir. Matches the library bundle layout.
export const LIBRARY_PROJECT_ID = "_library";
export const LIBRARY_PALETTE_ROW = 0;
export const LIBRARY_DESIGN_ROW = 0;
/** Clone test takes share the design slug on their own row, so they list apart. */
export const LIBRARY_CLONE_ROW = 1;
export const DEFAULT_TEST_LINE = "And then she said — nothing at all.";

export function libraryPaletteSlug(libraryId: string, emotion: string): string {
  return `__library_palette__${libraryId}__${emotion}`;
}

/**
 * Baseline emotional palette. `direction` drives Voice Design (text-described
 * voices); `line` and `exaggeration` drive Chatterbox clones, which take no
 * written direction — the emotion has to be in the words and the
 * expressiveness setting.
 */
export const BASELINE_EMOTIONS: { emotion: string; label: string; direction: string; line: string; exaggeration: number }[] = [
  { emotion: "neutral", label: "Neutral", exaggeration: 0.5,
    direction: "Even and conversational, natural pace.",
    line: "The train leaves at eleven, so we really ought to get going." },
  { emotion: "happy", label: "Happy", exaggeration: 0.6,
    direction: "Bright and warm, smiling through the words.",
    line: "Oh, that's wonderful! I knew you could do it!" },
  { emotion: "excited", label: "Excited", exaggeration: 0.75,
    direction: "Fast and high-energy, words tumbling out.",
    line: "You'll never guess what just happened — come on, quickly!" },
  { emotion: "tender", label: "Tender", exaggeration: 0.4,
    direction: "Soft, warm and close; gentle reassurance.",
    line: "It's all right. I'm here, and I'm not going anywhere." },
  { emotion: "sad", label: "Sad", exaggeration: 0.55,
    direction: "Quiet and heavy, slower, falling at the ends of phrases.",
    line: "I just thought... it would all turn out differently." },
  { emotion: "angry", label: "Angry", exaggeration: 0.8,
    direction: "Hard, clipped consonants; rising force, barely held back.",
    line: "Don't you dare walk away while I'm talking to you!" },
  { emotion: "afraid", label: "Afraid", exaggeration: 0.7,
    direction: "Breathy and quick, voice tight with fear.",
    line: "Did you hear that? There's something out there." },
  { emotion: "sardonic", label: "Sardonic", exaggeration: 0.5,
    direction: "Dry and unimpressed; flat delivery with a slight sneer.",
    line: "Oh, brilliant. Another plan that can't possibly go wrong." },
  { emotion: "whisper", label: "Whisper", exaggeration: 0.35,
    direction: "Hushed and close, conspiratorial.",
    line: "Keep your voice down — they'll hear us." },
];

/** Absolute path of a bundle file; library voice paths are stored relative. */
export function libraryBundlePath(projectsDir: string, libraryId: string, path: string): string {
  return path.startsWith("/") ? path : `${projectsDir}/_library/characters/${libraryId}/${path}`;
}

export function libraryDesignSlug(libraryId: string): string {
  return `__library_design__${libraryId}`;
}

export type LibraryTab = "voice" | "palette" | "corpus" | "model";

export function tabToStage(t: LibraryTab): VoicePipelineStage {
  if (t === "palette") return 2;
  if (t === "corpus") return 3;
  if (t === "model") return 4;
  return 1;
}

export function stageToTab(s: VoicePipelineStage): LibraryTab {
  if (s === 2) return "palette";
  if (s === 3) return "corpus";
  if (s === 4) return "model";
  return "voice";
}

// ── Helpers ────────────────────────────────────────────────────────────────

export const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

export function emptyCharacter(): Character {
  return {
    id: "LIB_NEW",
    name: "New character",
    description: "",
    voice_assignment: {
      model: "VoiceDesign",
      speaker: null,
      instruct_default: "",
      ref_audio_path: null,
      ref_transcript: null,
      base_voice_description: "",
      emotional_palette: [],
      production_pipeline: "chatterbox",
    },
    schema_version: 2,
    library_id: null,
    library_version: null,
  };
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const m = 60_000, h = 60 * m, d = 24 * h;
  if (diff < m) return "just now";
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 30 * d) return `${Math.floor(diff / d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Job-shaped object accepted by TakeList — includes job-store jobs and synthesized
// "disk job" rows for MCP-generated takes that bypass the in-memory queue.
export type TakeJob = Parameters<typeof TakeRow>[0]["job"];

// Native open dialog → returns picked source paths (multi-select) or [].
// Multi-file upload is preferred for voice cloning: concatenating several
// takes of the same actor into one ref gives Chatterbox a much more stable
// speaker embedding than a single short clip (Pharaoh-aonr).
export async function pickAudioFiles(multi: boolean): Promise<string[]> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      multiple: multi,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "aac", "ogg", "flac", "m4a"] }],
    });
    if (!result) return [];
    if (Array.isArray(result)) {
      return result.map((r) => typeof r === "string" ? r : (r as { path: string }).path);
    }
    return [typeof result === "string" ? result : (result as { path: string }).path];
  } catch (e) {
    reportError("Pick audio files", e);
    return [];
  }
}

export const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
