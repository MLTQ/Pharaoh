import Papa from "papaparse";
import type { ScriptRow, TrackType } from "./types";

export const SCRIPT_HEADERS = [
  "scene", "track", "type", "character", "prompt", "file",
  "start_ms", "duration_ms", "loop", "pan", "gain_db", "instruct",
  "fade_in_ms", "fade_out_ms", "reverb_send", "notes",
] as const;

// ── Parse ───────────────────────────────────────────────────────────────────

export function parseScript(csvText: string): ScriptRow[] {
  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  return result.data.map((row) => ({
    scene:       row.scene       ?? "",
    track:       row.track       ?? "",
    type:        (row.type as TrackType) ?? "DIALOGUE",
    character:   row.character   ?? "",
    prompt:      row.prompt      ?? "",
    file:        row.file        ?? "",
    start_ms:    row.start_ms    ?? "",
    duration_ms: row.duration_ms ?? "",
    loop:        row.loop        ?? "false",
    pan:         row.pan         ?? "0",
    gain_db:     row.gain_db     ?? "0",
    instruct:    row.instruct    ?? "",
    fade_in_ms:  row.fade_in_ms  ?? "50",
    fade_out_ms: row.fade_out_ms ?? "50",
    reverb_send: row.reverb_send ?? "0",
    notes:       row.notes       ?? "",
  }));
}

// ── Serialize ───────────────────────────────────────────────────────────────

export function serializeScript(rows: ScriptRow[]): string {
  return Papa.unparse(rows, {
    columns: [...SCRIPT_HEADERS],
    header: true,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isResolved(row: ScriptRow): boolean {
  return row.file !== "" && row.start_ms !== "";
}

export function hasAudio(row: ScriptRow): boolean {
  return row.type !== "DIRECTION";
}

export function resolveRow(
  row: ScriptRow,
  filePath: string,
  durationMs: number,
  startMs?: number,
): ScriptRow {
  return {
    ...row,
    file:        filePath,
    duration_ms: String(durationMs),
    start_ms:    startMs != null ? String(startMs) : row.start_ms,
  };
}

export function updateRow(
  rows: ScriptRow[],
  index: number,
  fields: Partial<ScriptRow>,
): ScriptRow[] {
  return rows.map((r, i) => (i === index ? { ...r, ...fields } : r));
}

export function getUnresolved(rows: ScriptRow[]): { row: ScriptRow; index: number }[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => hasAudio(row) && !isResolved(row));
}

export function backfillTimestamps(rows: ScriptRow[]): ScriptRow[] {
  const result = [...rows];
  let cursor = 0;

  for (let i = 0; i < result.length; i++) {
    const row = result[i];
    if (!hasAudio(row) || row.type === "BED") continue;
    if (row.duration_ms === "") continue;

    if (row.start_ms === "") {
      result[i] = { ...row, start_ms: String(cursor) };
    }

    const dur = parseInt(row.duration_ms, 10);
    const fadeOut = parseInt(row.fade_out_ms || "50", 10);
    if (!isNaN(dur)) {
      cursor = parseInt(result[i].start_ms, 10) + dur - fadeOut;
    }
  }

  return result;
}
