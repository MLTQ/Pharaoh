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
export const DEFAULT_TEST_LINE = "And then she said — nothing at all.";

export function libraryPaletteSlug(libraryId: string, emotion: string): string {
  return `__library_palette__${libraryId}__${emotion}`;
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
