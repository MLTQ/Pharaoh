import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  parseFountain,
  rowsToBlocks,
  serializeFountain,
  compileBlocksToRows,
  type FountainBlock,
} from "../../lib/fountain";
import { useJobStore } from "../../store/jobStore";
import { useUiStore } from "../../store/uiStore";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import { useToastStore } from "../../store/toastStore";
import { useProjectStore } from "../../store/projectStore";
import { draftScene, readFountain, writeFountain } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import type { ScriptRow, TrackType, Character, ViewId, Scene } from "../../lib/types";

// ── Constants ──────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<TrackType, string> = {
  DIALOGUE: "var(--tts)",
  SFX:      "var(--sfx)",
  BED:      "var(--sfx)",
  MUSIC:    "var(--music)",
  DIRECTION:"var(--fg-3)",
};

const TYPE_VIEW: Partial<Record<TrackType, ViewId>> = {
  DIALOGUE: "tts",
  SFX:      "sfx",
  BED:      "sfx",
  MUSIC:    "music",
};

type CardStatus = "draft" | "generating" | "ready" | "placed";

const STATUS_COLOR: Record<CardStatus, string> = {
  draft:      "var(--fg-4)",
  generating: "var(--tts)",
  ready:      "var(--st-rendered)",
  placed:     "var(--st-rendered)",
};

const STATUS_LABEL: Record<CardStatus, string> = {
  draft:      "draft",
  generating: "gen…",
  ready:      "ready",
  placed:     "placed",
};

// ── Status helper ──────────────────────────────────────────────────────────

function rowStatus(
  row: ScriptRow | null,
  rowIndex: number | null,
  sceneSlug: string | null,
  jobs: ReturnType<typeof useJobStore.getState>["jobs"],
): CardStatus {
  if (sceneSlug && rowIndex != null) {
    const running = jobs.find(
      (j) => j.scene_slug === sceneSlug && j.row_index === rowIndex &&
             (j.status === "running" || j.status === "pending"),
    );
    if (running) return "generating";
  }
  if (!row) return "draft";
  if (row.file && row.start_ms) return "placed";
  if (row.file) return "ready";
  return "draft";
}

// ── Block summary card (right pane) ────────────────────────────────────────

interface BlockCardProps {
  block: FountainBlock;
  row: ScriptRow | null;
  rowIndex: number | null;
  sceneSlug: string | null;
  characters: Character[];
  selected: boolean;
  onSelect: () => void;
  onGenerate: () => void;
  onPlace: () => void;
}

const BlockCard: React.FC<BlockCardProps> = ({
  block, row, rowIndex, sceneSlug, characters, selected, onSelect, onGenerate, onPlace,
}) => {
  const { jobs } = useJobStore();
  const status = rowStatus(row, rowIndex, sceneSlug, jobs);
  const typeColor = TYPE_COLOR[block.type] ?? "var(--fg-3)";
  const isDirection = block.type === "DIRECTION";
  const charDisplay = characters.find((c) => c.name.toUpperCase() === block.character.toUpperCase())?.name
    ?? block.character;

  return (
    <div
      onClick={onSelect}
      style={{
        margin: "0 10px 6px",
        borderRadius: 3,
        border: selected
          ? `1px solid ${typeColor}`
          : isDirection
          ? "1px solid transparent"
          : "1px solid var(--line-1)",
        background: isDirection ? "transparent" : "var(--bg-2)",
        cursor: "pointer",
        transition: "border-color 0.1s",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: isDirection ? "4px 8px" : "6px 8px",
        borderBottom: isDirection ? "none" : "1px solid var(--line-1)",
      }}>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.08em",
          padding: "1px 5px", borderRadius: 2,
          color: typeColor,
          background: `color-mix(in oklch, ${typeColor} 12%, transparent)`,
          flexShrink: 0,
        }}>
          {block.type}
        </span>

        {!isDirection && block.character && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, color: typeColor,
            letterSpacing: "0.04em", flexShrink: 0,
          }}>
            {charDisplay}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {!isDirection && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.05em",
            color: STATUS_COLOR[status],
          }}>
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>

      <div style={{ padding: "6px 8px" }}>
        <div style={{
          fontSize: 11.5,
          color: block.text ? "var(--fg-1)" : "var(--fg-4)",
          lineHeight: 1.5,
          fontStyle: isDirection ? "italic" : "normal",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {block.text || (isDirection ? "—" : "(empty)")}
        </div>
        {!isDirection && block.parenthetical && (
          <div style={{
            fontSize: 10.5, color: "var(--fg-3)", fontStyle: "italic",
            marginTop: 4, paddingLeft: 8, borderLeft: `2px solid ${typeColor}`,
          }}>
            ({block.parenthetical})
          </div>
        )}
      </div>

      {!isDirection && (
        <div style={{
          display: "flex", gap: 6, padding: "6px 8px",
          borderTop: "1px solid var(--line-1)",
        }}>
          {status === "draft" || status === "generating" ? (
            <button
              className="btn btn-sm"
              onClick={(e) => { e.stopPropagation(); onGenerate(); }}
              disabled={status === "generating" || !block.text.trim()}
              style={{
                fontSize: 9.5, padding: "2px 8px",
                background: `color-mix(in oklch, ${typeColor} 10%, transparent)`,
                borderColor: `color-mix(in oklch, ${typeColor} 40%, transparent)`,
                color: typeColor,
              }}
            >
              {status === "generating" ? "generating…" : "Generate →"}
            </button>
          ) : status === "ready" ? (
            <button
              className="btn btn-sm"
              onClick={(e) => { e.stopPropagation(); onPlace(); }}
              style={{
                fontSize: 9.5, padding: "2px 8px",
                background: "color-mix(in oklch, var(--st-rendered) 10%, transparent)",
                borderColor: "color-mix(in oklch, var(--st-rendered) 40%, transparent)",
                color: "var(--st-rendered)",
              }}
            >
              Place →
            </button>
          ) : (
            <span style={{
              fontSize: 9.5, color: "var(--st-rendered)", fontFamily: "var(--font-mono)",
              letterSpacing: "0.04em",
            }}>
              ✓ {row?.start_ms ? `@${(Number(row.start_ms) / 1000).toFixed(1)}s` : "placed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ── Fountain syntax highlighting (light) ───────────────────────────────────
//
// We render the textarea on top of a styled div that mirrors the text. Cheap
// but effective; the textarea stays the source of truth for caret/selection.

function classifyLine(line: string): "scene" | "character" | "paren" | "cue" | "action" | "blank" {
  const t = line.trim();
  if (!t) return "blank";
  if (/^(INT\.|EXT\.|EST\.|INT\/EXT\.|I\/E\.|\.[A-Z])/.test(t)) return "scene";
  if (/^(SFX|BED|MUSIC|FX)\s*:/i.test(t)) return "cue";
  if (/^\([^)]*\)\s*$/.test(t)) return "paren";
  // character cue: all caps, no lowercase, has letters
  const beforeParen = t.split("(")[0].trim();
  if (/[A-Z]/.test(beforeParen) && !/[a-z]/.test(beforeParen) && t.length < 60) return "character";
  return "action";
}

const HIGHLIGHT_COLOR: Record<ReturnType<typeof classifyLine>, string> = {
  scene:     "var(--fg-0)",
  character: "var(--tts)",
  paren:     "var(--fg-3)",
  cue:       "var(--sfx)",
  action:    "var(--fg-2)",
  blank:     "var(--fg-2)",
};

const HIGHLIGHT_WEIGHT: Record<ReturnType<typeof classifyLine>, number> = {
  scene: 600, character: 600, paren: 400, cue: 500, action: 400, blank: 400,
};

// Strip [[id:...]] from displayed text — they're machine metadata, not part of writing.
const ID_TAG_RE = /\[\[id:[a-z0-9-]+\]\]/gi;

function stripIdTags(text: string): string {
  return text.replace(ID_TAG_RE, "").replace(/[ \t]+$/gm, "");
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface FountainEditorProps {
  rows: ScriptRow[];
  characters: Character[];
  sceneNo: string;
  sceneSlug: string | null;
  onCommitRows: (rows: ScriptRow[]) => void;
}

// ── Main component ─────────────────────────────────────────────────────────

export const FountainEditor: React.FC<FountainEditorProps> = ({
  rows, characters, sceneNo, sceneSlug, onCommitRows,
}) => {
  // The Fountain text is derived from the rows on first mount, then becomes the
  // source of truth. Editing emits compiled rows back up via onCommitRows.
  const initialBlocks = useMemo(() => rowsToBlocks(rows, characters), []);
  const [text, setText] = useState<string>(() => {
    const display = serializeFountain(initialBlocks);
    return stripIdTags(display).trim() + (initialBlocks.length ? "\n" : "");
  });
  // Internal id map: line-position-derived ids. To survive edits we re-key by
  // the closest matching block from the previous parse.
  const [blocks, setBlocks] = useState<FountainBlock[]>(initialBlocks);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const taRef     = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Debounce handle for atomic-writing the fountain file. Keeps disk I/O
  // off the critical typing path while still flushing on scene/unmount.
  const fountainSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once we've done the initial load (whether from disk or from rows) we
  // start writing back. Without this gate the very first render would
  // immediately overwrite a user's existing script.fountain with the
  // rows-derived placeholder.
  const initialLoadDone = useRef(false);

  const { setView } = useUiStore();
  const { submitTts, submitSfx, submitMusic } = useGenerateJob();
  const pushToast = useToastStore((s) => s.push);
  const toast = (kind: "info" | "warn" | "error", title: string) => pushToast({ kind, title });
  const { project, realProject, realScenes, realProjectId } = useProjectStore();
  const [drafting, setDrafting] = useState(false);

  // ── Disk persistence ─────────────────────────────────────────────────────
  // On mount (or scene switch) prefer the on-disk script.fountain over the
  // CSV-derived reconstruction — it preserves the writer's formatting.
  useEffect(() => {
    if (!realProjectId || !sceneSlug) {
      // No project context (demo / launcher) — keep the in-memory rows-derived
      // text, mark loaded so user edits start saving once a project opens.
      initialLoadDone.current = true;
      return;
    }
    let cancelled = false;
    initialLoadDone.current = false;
    readFountain({ projectId: realProjectId, sceneSlug })
      .then((onDisk) => {
        if (cancelled) return;
        if (onDisk != null && onDisk.trim() !== "") {
          // Restore the writer's saved prose, then let the parse effect run
          // to derive blocks. Skip the CSV-derived reconstruction entirely.
          setText(onDisk);
        }
        initialLoadDone.current = true;
      })
      .catch((e) => {
        // A real read failure (not "no file yet" — that resolves null) means
        // we're showing CSV-derived text instead of the writer's saved prose,
        // and the next debounced save would overwrite it. Say so.
        reportError("Script prose load failed", e, { id: "fountain-load-failed" });
        initialLoadDone.current = true;
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realProjectId, sceneSlug]);

  // Persist text changes to disk (debounced 600ms) once we know we're past
  // the initial load. The writer's prose is always recoverable across
  // restarts, even if the app is force-quit mid-edit.
  useEffect(() => {
    if (!initialLoadDone.current) return;
    if (!realProjectId || !sceneSlug) return;
    if (fountainSaveTimer.current) clearTimeout(fountainSaveTimer.current);
    fountainSaveTimer.current = setTimeout(() => {
      writeFountain({ projectId: realProjectId, sceneSlug, text })
        .catch((e) => reportError("Script save failed", e, { id: "fountain-save-failed" }));
    }, 600);
    return () => {
      if (fountainSaveTimer.current) clearTimeout(fountainSaveTimer.current);
    };
  }, [text, realProjectId, sceneSlug]);

  // Flush on unmount / scene switch / before-unload so nothing is lost
  useEffect(() => {
    const flush = () => {
      if (!realProjectId || !sceneSlug || !initialLoadDone.current) return;
      if (fountainSaveTimer.current) clearTimeout(fountainSaveTimer.current);
      writeFountain({ projectId: realProjectId, sceneSlug, text })
        .catch((e) => reportError("Script save failed", e, { id: "fountain-save-failed" }));
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realProjectId, sceneSlug]);

  const handleDraftScene = async () => {
    if (!realProject) {
      toast("warn", "Open a real project to draft");
      return;
    }
    const realScene: Scene | undefined = realScenes.find(
      (s) => `S${String(s.index + 1).padStart(2, "0")}` === sceneNo,
    );
    setDrafting(true);
    try {
      const result = await draftScene({
        projectTitle: realProject.title,
        logline: realProject.logline ?? "",
        synopsis: project.synopsis ?? "",
        tone: realProject.tone ?? "",
        characters: characters.map((c) => ({
          name: c.name,
          description: c.description,
          voiceDirection: c.voice_assignment.instruct_default ?? undefined,
        })),
        sceneTitle: realScene?.title ?? "",
        sceneDescription: realScene?.description ?? "",
        sceneLocation: realScene?.location ?? "",
        previousFountain: text.trim() ? text : undefined,
        model: realProject.llm_config?.model,
        apiKeyEnv: realProject.llm_config?.api_key_env,
      });
      // Drop existing IDs so each line is fresh; re-parse picks up new ids.
      setText(result.fountain.trim() + "\n");
      toast("info", `Draft ready · ${result.input_tokens}→${result.output_tokens} tok · ${result.model}`);
    } catch (e) {
      toast("error", `Draft failed: ${e}`);
    } finally {
      setDrafting(false);
    }
  };

  // Re-parse on text change. We re-use IDs from the previous block list when the
  // (type, character, normalized-text) tuple matches, so generation state is
  // preserved across small edits.
  useEffect(() => {
    const parsed = parseFountain(text);
    const usedIds = new Set<string>();
    const reKeyed = parsed.map((b) => {
      // First try: an existing block with the same id literal in text (stable
      // across reorders). The parser already tries to extract these.
      if (b.id && !usedIds.has(b.id) && blocks.some((p) => p.id === b.id)) {
        usedIds.add(b.id);
        return b;
      }
      // Otherwise: best-effort match by (type, character, text-prefix) on the
      // previous block list, in order.
      const candidate = blocks.find((p) =>
        !usedIds.has(p.id) &&
        p.type === b.type &&
        p.character.toUpperCase() === b.character.toUpperCase() &&
        p.text.slice(0, 24) === b.text.slice(0, 24),
      );
      if (candidate) {
        usedIds.add(candidate.id);
        return { ...b, id: candidate.id };
      }
      usedIds.add(b.id);
      return b;
    });
    setBlocks(reKeyed);
  // We intentionally exclude `blocks` so this only re-runs when the text changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Compile blocks → rows whenever blocks change, and surface up.
  useEffect(() => {
    const compiled = compileBlocksToRows(blocks, sceneNo, characters, rows);
    onCommitRows(compiled);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, sceneNo, characters]);

  // Find the row that corresponds to a given block. Rows are emitted in block
  // order so index is the simplest mapping.
  const blockToRowIndex = (blockIdx: number): number | null =>
    blockIdx >= 0 && blockIdx < rows.length ? blockIdx : null;

  // ── Generate handlers ────────────────────────────────────────────────────

  const handleGenerate = async (block: FountainBlock, blockIdx: number) => {
    if (!sceneSlug) {
      toast("warn", "Open a real project to generate");
      return;
    }
    const rowIndex = blockToRowIndex(blockIdx);
    if (rowIndex == null) return;

    try {
      if (block.type === "DIALOGUE") {
        const character = characters.find(
          (c) => c.name.toUpperCase() === block.character.toUpperCase() ||
                 c.id.toLowerCase() === block.character.toLowerCase(),
        );
        if (!character) {
          toast("warn", `Character "${block.character}" not in cast — add to Cast & Voices`);
          return;
        }
        await submitTts({
          text: block.text,
          speaker: character.voice_assignment.speaker ?? "Vivian",
          character,
          instruct: block.parenthetical || character.voice_assignment.instruct_default || "",
          rowIndex,
        });
        toast("info", `Generating dialogue for ${character.name}`);
      } else if (block.type === "SFX" || block.type === "BED") {
        await submitSfx({
          prompt: block.text,
          durationSeconds: block.type === "BED" ? 30.0 : 3.0,
          rowIndex,
        });
        toast("info", `Generating ${block.type.toLowerCase()}`);
      } else if (block.type === "MUSIC") {
        await submitMusic({
          caption: block.text,
          rowIndex,
        });
        toast("info", "Generating score");
      }
    } catch (e) {
      toast("error", `Generate failed: ${e}`);
    }
  };

  const handlePlace = (blockIdx: number) => {
    const rowIndex = blockToRowIndex(blockIdx);
    if (rowIndex == null) return;
    const row = rows[rowIndex];
    if (!row?.file) return;
    const placed = rows.filter((r, i) => i !== rowIndex && r.track === row.track && r.start_ms);
    const lastEnd = placed.reduce((max, r) => {
      const end = Number(r.start_ms) + (Number(r.duration_ms) || 5000);
      return end > max ? end : max;
    }, 0);
    onCommitRows(rows.map((r, i) => i === rowIndex ? { ...r, start_ms: String(lastEnd) } : r));
  };

  // ── Generate-all (Table Read prep): generate every draft DIALOGUE block ──

  const handleGenerateAll = async (typeFilter: TrackType[]) => {
    const queue = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => {
        if (!typeFilter.includes(b.type)) return false;
        if (!b.text.trim()) return false;
        const r = rows[i];
        return !r?.file;
      });
    if (queue.length === 0) {
      toast("info", "Nothing to generate — all blocks resolved");
      return;
    }
    toast("info", `Queuing ${queue.length} blocks for generation`);
    for (const { b, i } of queue) {
      await handleGenerate(b, i);
    }
  };

  // ── Tab to cycle line type ───────────────────────────────────────────────
  //
  // Quality-of-life: Tab on a non-empty line cycles the line through
  //   action → CHARACTER → SFX: → MUSIC: → BED: → action

  const cycleLineType = () => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const before = text.slice(0, start);
    const after  = text.slice(start);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEndRel = after.indexOf("\n");
    const lineEnd = lineEndRel === -1 ? text.length : start + lineEndRel;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();
    const cls = classifyLine(line);

    let nextLine: string;
    if (cls === "character") nextLine = `SFX: ${trimmed.replace(/^[A-Z .'\-]+/, "").trim() || "..."}`;
    else if (/^SFX:/i.test(trimmed)) nextLine = `MUSIC: ${trimmed.replace(/^SFX\s*:\s*/i, "")}`;
    else if (/^MUSIC:/i.test(trimmed)) nextLine = `BED: ${trimmed.replace(/^MUSIC\s*:\s*/i, "")}`;
    else if (/^BED:/i.test(trimmed)) nextLine = trimmed.replace(/^BED\s*:\s*/i, "");
    else nextLine = trimmed.toUpperCase();

    const next = text.slice(0, lineStart) + nextLine + text.slice(lineEnd);
    setText(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = lineStart + nextLine.length;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      cycleLineType();
    }
  };

  // ── Sync overlay scroll to textarea scroll ───────────────────────────────

  const handleScroll = () => {
    if (overlayRef.current && taRef.current) {
      overlayRef.current.scrollTop  = taRef.current.scrollTop;
      overlayRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  // ── Highlighted overlay ──────────────────────────────────────────────────

  const overlayContent = useMemo(() => {
    return text.split("\n").map((line, i) => {
      const cls = classifyLine(line);
      // For character cues, indent visually like a screenplay
      const isChar = cls === "character";
      const isParen = cls === "paren";
      const padding = isChar ? "0 0 0 12ch" : isParen ? "0 0 0 8ch" : "0";
      return (
        <div
          key={i}
          style={{
            color: HIGHLIGHT_COLOR[cls],
            fontWeight: HIGHLIGHT_WEIGHT[cls],
            textTransform: isChar ? "uppercase" : "none",
            padding,
            minHeight: "1.55em",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {line || " "}
        </div>
      );
    });
  }, [text]);

  const draftCount = blocks.filter((b, i) => {
    if (b.type === "DIRECTION") return false;
    return !rows[i]?.file && b.text.trim();
  }).length;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "100%" }}>

      {/* ── Left: Fountain text editor ─────────────────────────────────── */}
      <div style={{
        flex: 1, minWidth: 0,
        display: "flex", flexDirection: "column",
        borderRight: "1px solid var(--line-1)",
        background: "var(--bg-1)",
      }}>
        <div style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--line-1)",
          display: "flex", alignItems: "center", gap: 10,
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Script · Fountain
          </span>
          <span style={{ fontSize: 10, color: "var(--fg-4)", fontStyle: "italic" }}>
            CHARACTER on its own line · (parenthetical) · SFX:/MUSIC:/BED: cues · Tab cycles line type
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="btn btn-sm"
            onClick={handleDraftScene}
            disabled={drafting || !realProject}
            title={!realProject ? "Open a real project" : text.trim() ? "Revise scene with AI" : "Draft scene with AI"}
            style={{ fontSize: 10 }}
          >
            {drafting ? "Drafting…" : text.trim() ? "✦ Revise scene" : "✦ Draft scene"}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => handleGenerateAll(["DIALOGUE"])}
            disabled={!sceneSlug || draftCount === 0}
            title={!sceneSlug ? "Open a real project" : "Generate all draft dialogue"}
            style={{ fontSize: 10 }}
          >
            Gen all dialogue ({blocks.filter((b, i) => b.type === "DIALOGUE" && !rows[i]?.file && b.text.trim()).length})
          </button>
        </div>

        {/* Editor stack: highlighted overlay underneath, transparent textarea on top */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <div
            ref={overlayRef}
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              padding: "12px 16px",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.55,
              overflow: "auto",
              pointerEvents: "none",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--fg-1)",
            }}
          >
            {overlayContent}
          </div>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
            spellCheck
            style={{
              position: "absolute", inset: 0,
              padding: "12px 16px",
              background: "transparent",
              color: "transparent",
              caretColor: "var(--fg-0)",
              border: "none",
              outline: "none",
              resize: "none",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflow: "auto",
            }}
            placeholder="MIRA&#10;(barely whispering)&#10;I thought you were dead.&#10;&#10;SFX: door creak, slow interior wood&#10;MUSIC: tension underscore, sparse piano"
          />
        </div>
      </div>

      {/* ── Right: parsed blocks with Generate buttons ─────────────────── */}
      <div style={{
        width: 320, flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "var(--bg-1)",
      }}>
        <div style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--line-1)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Blocks · {blocks.length}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
          }}>
            {draftCount} draft
          </span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", paddingTop: 6 }}>
          {blocks.length === 0 && (
            <div style={{
              margin: "24px 16px", padding: 16,
              border: "1px dashed var(--line-2)", borderRadius: 3,
              textAlign: "center", fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6,
            }}>
              Start typing on the left.
              <br />
              Each dialogue / cue / direction becomes a block here.
            </div>
          )}

          {blocks.map((block, i) => (
            <BlockCard
              key={block.id}
              block={block}
              row={rows[i] ?? null}
              rowIndex={i < rows.length ? i : null}
              sceneSlug={sceneSlug}
              characters={characters}
              selected={selectedId === block.id}
              onSelect={() => setSelectedId(block.id)}
              onGenerate={() => handleGenerate(block, i)}
              onPlace={() => handlePlace(i)}
            />
          ))}
        </div>

        {/* Routing footer — preserves the existing per-type-panel jump */}
        <div style={{
          borderTop: "1px solid var(--line-1)",
          padding: "6px 10px",
          display: "flex", gap: 6,
          flexShrink: 0,
        }}>
          <button className="btn btn-sm" onClick={() => setView("tts")}    style={{ flex: 1, fontSize: 10 }}>Voice…</button>
          <button className="btn btn-sm" onClick={() => setView("sfx")}    style={{ flex: 1, fontSize: 10 }}>Sound…</button>
          <button className="btn btn-sm" onClick={() => setView("music")}  style={{ flex: 1, fontSize: 10 }}>Score…</button>
        </div>
      </div>
    </div>
  );
};

// Re-export type names used elsewhere
export type { FountainBlock };
// avoid unused import warning
export const _typeViewMap = TYPE_VIEW;
