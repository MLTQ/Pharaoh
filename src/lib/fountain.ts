// Fountain parser + Fountain ↔ ScriptRow round-trip.
//
// Supported syntax (a pragmatic subset, extended for audio drama):
//   INT./EXT./EST. line                  → scene heading (metadata, not a row)
//   . prefixed line                       → forced scene heading
//   ALL CAPS line followed by text lines  → CHARACTER + dialogue block
//   (text)                                → parenthetical (appended to instruct)
//   SFX: ...                              → SFX row
//   BED: ...                              → BED row (loop=true)
//   MUSIC: ...                            → MUSIC row
//   any other text                        → action / DIRECTION row
//   [[id:r-abc123]] inline note           → stable block ID; auto-generated when absent
//
// Stable IDs are how we round-trip: when re-parsing edited Fountain we keep audio
// metadata (file, start_ms, duration_ms…) on rows whose block IDs still match, and
// only update text/character/type from the prose.

import type { ScriptRow, TrackType, Character } from "./types";

export interface FountainBlock {
  id: string;                  // stable id (auto-injected on first parse)
  type: TrackType;
  character: string;           // empty for non-DIALOGUE
  text: string;                // dialogue / direction / cue prompt
  parenthetical: string;       // delivery note for DIALOGUE
}

// ── ID generation ──────────────────────────────────────────────────────────

const idChars = "abcdefghijklmnopqrstuvwxyz0123456789";
function makeId(): string {
  let s = "r-";
  for (let i = 0; i < 6; i++) s += idChars[Math.floor(Math.random() * idChars.length)];
  return s;
}

const ID_NOTE_RE = /\[\[id:([a-z0-9-]+)\]\]/i;

function extractId(line: string): { line: string; id: string | null } {
  const m = line.match(ID_NOTE_RE);
  if (!m) return { line, id: null };
  return { line: line.replace(ID_NOTE_RE, "").trim(), id: m[1] };
}

// ── Cue prefix detection ───────────────────────────────────────────────────

const CUE_PREFIXES: Array<{ re: RegExp; type: TrackType }> = [
  { re: /^SFX\s*:\s*/i,   type: "SFX" },
  { re: /^BED\s*:\s*/i,   type: "BED" },
  { re: /^MUSIC\s*:\s*/i, type: "MUSIC" },
  { re: /^FX\s*:\s*/i,    type: "SFX" },
];

function matchCue(line: string): { type: TrackType; text: string } | null {
  for (const { re, type } of CUE_PREFIXES) {
    if (re.test(line)) return { type, text: line.replace(re, "").trim() };
  }
  return null;
}

const SCENE_HEADING_RE = /^(INT\.|EXT\.|EST\.|INT\/EXT\.|I\/E\.|\.[A-Z])/;

function isSceneHeading(line: string): boolean {
  return SCENE_HEADING_RE.test(line.trim());
}

// All-caps-ish character cue. We accept names with letters, spaces, dots, apostrophes,
// optional (V.O.) / (CONT'D) suffix. The line cannot contain lowercase letters in the
// name portion.
const CHARACTER_RE = /^([A-Z][A-Z0-9 .'\-]{0,60}?)(\s*\([^)]*\))?\s*$/;

function isCharacterCue(line: string): boolean {
  if (!line.trim()) return false;
  if (isSceneHeading(line)) return false;
  if (matchCue(line)) return false;
  // require at least one alpha char and no lowercase before any paren
  const beforeParen = line.split("(")[0].trim();
  if (!/[A-Z]/.test(beforeParen)) return false;
  if (/[a-z]/.test(beforeParen)) return false;
  return CHARACTER_RE.test(line);
}

const PARENTHETICAL_RE = /^\(([^)]*)\)\s*$/;

// ── Parse ──────────────────────────────────────────────────────────────────

export function parseFountain(text: string): FountainBlock[] {
  const rawLines = text.split(/\r?\n/);
  const blocks: FountainBlock[] = [];

  // Mutable cursor walking the lines
  let i = 0;
  while (i < rawLines.length) {
    const raw = rawLines[i];
    const { line, id } = extractId(raw);
    const trimmed = line.trim();

    // Skip blank lines and scene headings (metadata, not rows)
    if (!trimmed || isSceneHeading(trimmed)) { i++; continue; }

    // SFX/BED/MUSIC cue
    const cue = matchCue(trimmed);
    if (cue) {
      blocks.push({
        id: id ?? makeId(),
        type: cue.type,
        character: "",
        text: cue.text,
        parenthetical: "",
      });
      i++;
      continue;
    }

    // Character + dialogue block
    if (isCharacterCue(trimmed)) {
      const charMatch = trimmed.match(CHARACTER_RE);
      const character = (charMatch?.[1] ?? trimmed).trim();
      i++;
      // Collect contiguous dialogue + parenthetical lines until blank or non-dialogue
      let dialogueText = "";
      let parenthetical = "";
      while (i < rawLines.length) {
        const { line: nextLine } = extractId(rawLines[i]);
        const nextTrim = nextLine.trim();
        if (!nextTrim) break;
        // A new character cue or cue prefix or scene heading ends the block
        if (isCharacterCue(nextTrim) || matchCue(nextTrim) || isSceneHeading(nextTrim)) break;
        const parenMatch = nextTrim.match(PARENTHETICAL_RE);
        if (parenMatch) {
          parenthetical = parenthetical ? `${parenthetical}; ${parenMatch[1]}` : parenMatch[1];
        } else {
          dialogueText = dialogueText ? `${dialogueText} ${nextTrim}` : nextTrim;
        }
        i++;
      }
      blocks.push({
        id: id ?? makeId(),
        type: "DIALOGUE",
        character,
        text: dialogueText,
        parenthetical,
      });
      continue;
    }

    // Fall-through: action / direction
    blocks.push({
      id: id ?? makeId(),
      type: "DIRECTION",
      character: "",
      text: trimmed,
      parenthetical: "",
    });
    i++;
  }

  return blocks;
}

// ── Serialize ──────────────────────────────────────────────────────────────

export function serializeFountain(blocks: FountainBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const idTag = `[[id:${b.id}]]`;
    if (b.type === "DIALOGUE") {
      out.push(`${b.character.toUpperCase()} ${idTag}`);
      if (b.parenthetical) out.push(`(${b.parenthetical})`);
      out.push(b.text);
      out.push("");
    } else if (b.type === "SFX" || b.type === "BED" || b.type === "MUSIC") {
      out.push(`${b.type}: ${b.text} ${idTag}`);
      out.push("");
    } else {
      // DIRECTION
      out.push(`${b.text} ${idTag}`);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ── Block ↔ ScriptRow round-trip ───────────────────────────────────────────

export function blockToRow(
  block: FountainBlock,
  sceneNo: string,
  characters: Character[],
  existing?: ScriptRow,
): ScriptRow {
  const trackForBlock = (() => {
    if (block.type === "DIALOGUE") {
      const c = characters.find((c) => c.name.toUpperCase() === block.character.toUpperCase());
      return (c?.id ?? block.character).toLowerCase().replace(/\s+/g, "_");
    }
    if (block.type === "SFX" || block.type === "BED") return "FOLEY";
    if (block.type === "MUSIC") return "MUSIC";
    return "NARR";
  })();

  const characterId = block.type === "DIALOGUE"
    ? characters.find((c) => c.name.toUpperCase() === block.character.toUpperCase())?.id ?? block.character
    : "";

  const instructFromParen = block.parenthetical || (existing?.instruct ?? "");

  return {
    scene:       sceneNo,
    track:       existing?.track && block.type === existing?.type ? existing.track : trackForBlock,
    type:        block.type,
    character:   characterId,
    prompt:      block.text,
    file:        existing?.file ?? "",
    start_ms:    existing?.start_ms ?? "",
    duration_ms: existing?.duration_ms ?? "",
    loop:        block.type === "BED" ? "true" : (existing?.loop ?? "false"),
    pan:         existing?.pan ?? "0",
    gain_db:     existing?.gain_db ?? "0",
    instruct:    instructFromParen,
    fade_in_ms:  existing?.fade_in_ms ?? "50",
    fade_out_ms: existing?.fade_out_ms ?? "50",
    reverb_send: existing?.reverb_send ?? "0",
    notes:       existing?.notes ?? "",
  };
}

// Compile parsed blocks against existing rows. Rows are matched by ID stored in
// the `notes` field (we tuck `id:r-xxx` there so it survives CSV round-trips).
const NOTES_ID_RE = /(?:^|;)\s*id:([a-z0-9-]+)/i;

function rowId(row: ScriptRow): string | null {
  const m = row.notes.match(NOTES_ID_RE);
  return m ? m[1] : null;
}

function setRowId(row: ScriptRow, id: string): ScriptRow {
  if (rowId(row) === id) return row;
  const cleaned = row.notes.replace(/(?:^|;)\s*id:[a-z0-9-]+/i, "").replace(/^;\s*/, "").trim();
  const notes = cleaned ? `id:${id}; ${cleaned}` : `id:${id}`;
  return { ...row, notes };
}

export function compileBlocksToRows(
  blocks: FountainBlock[],
  sceneNo: string,
  characters: Character[],
  existing: ScriptRow[],
): ScriptRow[] {
  const byId = new Map<string, ScriptRow>();
  for (const r of existing) {
    const id = rowId(r);
    if (id) byId.set(id, r);
  }
  return blocks.map((block) => {
    const prior = byId.get(block.id);
    const next = blockToRow(block, sceneNo, characters, prior);
    return setRowId(next, block.id);
  });
}

// Convert existing rows into blocks (used when there's no .fountain file yet —
// we synthesize it from the CSV so the user can switch into Write mode).
export function rowsToBlocks(rows: ScriptRow[], characters: Character[]): FountainBlock[] {
  return rows.map((r) => {
    const existingId = rowId(r);
    if (r.type === "DIALOGUE") {
      const charName = characters.find((c) => c.id === r.character)?.name ?? r.character;
      return {
        id: existingId ?? makeId(),
        type: "DIALOGUE",
        character: charName,
        text: r.prompt,
        parenthetical: r.instruct,
      };
    }
    return {
      id: existingId ?? makeId(),
      type: r.type,
      character: "",
      text: r.prompt,
      parenthetical: "",
    };
  });
}
