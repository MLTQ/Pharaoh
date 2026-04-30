import React, { useState, useRef } from "react";
import { useUiStore } from "../../store/uiStore";
import { useJobStore } from "../../store/jobStore";
import type { ScriptRow, TrackType, Character, ViewId } from "../../lib/types";

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

const ALL_TYPES: TrackType[] = ["DIALOGUE", "SFX", "BED", "MUSIC", "DIRECTION"];

// ── Status helpers ─────────────────────────────────────────────────────────

type CardStatus = "draft" | "generating" | "ready" | "placed";

function rowStatus(
  row: ScriptRow,
  rowIndex: number,
  sceneSlug: string | null,
  jobs: ReturnType<typeof useJobStore.getState>["jobs"],
): CardStatus {
  if (sceneSlug) {
    const running = jobs.find(
      (j) => j.scene_slug === sceneSlug && j.row_index === rowIndex &&
             (j.status === "running" || j.status === "pending"),
    );
    if (running) return "generating";
  }
  if (row.file && row.start_ms) return "placed";
  if (row.file) return "ready";
  return "draft";
}

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

// ── Props ──────────────────────────────────────────────────────────────────

export interface ScriptCanvasProps {
  rows: ScriptRow[];
  characters: Character[];
  sceneNo: string;
  sceneSlug: string | null;
  onAdd:    (row: ScriptRow) => void;
  onDelete: (i: number) => void;
  onUpdate: (i: number, patch: Partial<ScriptRow>) => void;
}

// ── ScriptCard ─────────────────────────────────────────────────────────────

interface ScriptCardProps {
  row: ScriptRow;
  rowIndex: number;
  sceneSlug: string | null;
  isDragOver: boolean;
  onDelete: () => void;
  onUpdate: (patch: Partial<ScriptRow>) => void;
  onGenerate: () => void;
  onPlace: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

const ScriptCard: React.FC<ScriptCardProps> = ({
  row, rowIndex, sceneSlug, isDragOver,
  onDelete, onUpdate, onGenerate, onPlace,
  onDragStart, onDragOver, onDrop, onDragEnd,
}) => {
  const { jobs } = useJobStore();
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(row.prompt);

  const status = rowStatus(row, rowIndex, sceneSlug, jobs);
  const isDirection = row.type === "DIRECTION";
  const typeColor = TYPE_COLOR[row.type] ?? "var(--fg-3)";

  const commitPrompt = () => {
    setEditingPrompt(false);
    if (promptDraft !== row.prompt) onUpdate({ prompt: promptDraft });
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        margin: "0 10px 6px",
        borderRadius: 3,
        border: isDragOver
          ? "1px solid var(--fg-0)"
          : isDirection
          ? "1px solid transparent"
          : "1px solid var(--line-1)",
        background: isDirection ? "transparent" : "var(--bg-2)",
        cursor: "grab",
        transition: "border-color 0.1s",
      }}
    >
      {/* Card header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: isDirection ? "4px 8px" : "6px 8px",
        borderBottom: isDirection ? "none" : "1px solid var(--line-1)",
      }}>
        {/* Type badge */}
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.08em",
          padding: "1px 5px", borderRadius: 2,
          color: typeColor,
          background: `color-mix(in oklch, ${typeColor} 12%, transparent)`,
          flexShrink: 0,
        }}>
          {row.type}
        </span>

        {/* Character (DIALOGUE only) */}
        {!isDirection && row.character && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9, color: typeColor,
            letterSpacing: "0.04em", flexShrink: 0,
          }}>
            {row.character}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {/* Status dot */}
        {!isDirection && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.05em",
            color: STATUS_COLOR[status],
            flexShrink: 0,
          }}>
            {STATUS_LABEL[status]}
          </span>
        )}

        {/* Delete */}
        <button
          onClick={onDelete}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--fg-4)", fontSize: 13, lineHeight: 1,
            padding: "0 2px", flexShrink: 0, opacity: 0.5,
          }}
          title="Delete row"
        >×</button>
      </div>

      {/* Prompt text */}
      {!isDirection ? (
        <div style={{ padding: "6px 8px" }}>
          {editingPrompt ? (
            <textarea
              autoFocus
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              onBlur={commitPrompt}
              onKeyDown={(e) => { if (e.key === "Escape") { setEditingPrompt(false); setPromptDraft(row.prompt); } }}
              style={{
                width: "100%", background: "var(--bg-1)", border: "1px solid var(--tts)",
                borderRadius: 2, color: "var(--fg-0)", fontFamily: "inherit",
                fontSize: 11.5, lineHeight: 1.5, padding: "4px 6px", resize: "vertical",
                minHeight: 48, outline: "none",
              }}
            />
          ) : (
            <div
              onClick={() => { setPromptDraft(row.prompt); setEditingPrompt(true); }}
              style={{
                fontSize: 11.5, color: row.prompt ? "var(--fg-1)" : "var(--fg-4)",
                lineHeight: 1.5, cursor: "text",
                fontStyle: row.prompt ? "normal" : "italic",
              }}
            >
              {row.prompt || "Click to add prompt…"}
            </div>
          )}
        </div>
      ) : (
        /* Direction: just the prompt, italic, compact */
        <div
          onClick={() => { setPromptDraft(row.prompt); setEditingPrompt(true); }}
          style={{ padding: "2px 8px 4px" }}
        >
          {editingPrompt ? (
            <input
              autoFocus
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              onBlur={commitPrompt}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPrompt();
                if (e.key === "Escape") { setEditingPrompt(false); setPromptDraft(row.prompt); }
              }}
              style={{
                width: "100%", background: "none", border: "none",
                borderBottom: "1px solid var(--fg-4)", color: "var(--fg-3)",
                fontFamily: "inherit", fontSize: 11, fontStyle: "italic",
                padding: "1px 0", outline: "none",
              }}
            />
          ) : (
            <span style={{
              fontSize: 11, color: "var(--fg-4)", fontStyle: "italic",
              cursor: "text",
            }}>
              {row.prompt || <em style={{ color: "var(--fg-4)" }}>stage direction…</em>}
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      {!isDirection && (
        <div style={{
          display: "flex", gap: 6, padding: "6px 8px",
          borderTop: "1px solid var(--line-1)",
        }}>
          {status === "draft" || status === "generating" ? (
            <button
              className="btn btn-sm"
              onClick={onGenerate}
              disabled={status === "generating"}
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
              onClick={onPlace}
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
              ✓ {row.start_ms ? `@${(Number(row.start_ms) / 1000).toFixed(1)}s` : "placed"}
            </span>
          )}

          {/* Track label */}
          {row.track && (
            <span style={{
              marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9,
              color: "var(--fg-4)", letterSpacing: "0.04em",
            }}>
              {row.track}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ── Add row form ───────────────────────────────────────────────────────────

interface AddRowFormProps {
  sceneNo: string;
  characters: Character[];
  onAdd: (row: ScriptRow) => void;
  onCancel: () => void;
}

const AddRowForm: React.FC<AddRowFormProps> = ({ sceneNo, characters, onAdd, onCancel }) => {
  const [type, setType] = useState<TrackType>("DIALOGUE");
  const [character, setCharacter] = useState(characters[0]?.id ?? "");
  const [track, setTrack] = useState(characters[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const handleTypeChange = (t: TrackType) => {
    setType(t);
    if (t === "DIALOGUE") setTrack(character || characters[0]?.id || "TRACK");
    else if (t === "DIRECTION") setTrack("NARR");
    else if (t === "SFX" || t === "BED") setTrack("FOLEY");
    else if (t === "MUSIC") setTrack("MUSIC");
  };

  const handleCharChange = (id: string) => {
    setCharacter(id);
    if (type === "DIALOGUE") setTrack(id);
  };

  const handleAdd = () => {
    if (!prompt.trim() && type !== "DIRECTION") return;
    onAdd({
      scene: sceneNo, track,
      type, character: type === "DIALOGUE" ? character : "",
      prompt: prompt.trim(),
      file: "", start_ms: "", duration_ms: "", loop: "",
      pan: "", gain_db: "", instruct: "", fade_in_ms: "",
      fade_out_ms: "", reverb_send: "", notes: "",
    });
  };

  const typeColor = TYPE_COLOR[type];

  return (
    <div style={{
      margin: "4px 10px 10px",
      border: "1px solid var(--tts)",
      borderRadius: 3, background: "var(--bg-2)",
      overflow: "hidden",
    }}>
      {/* Type chips */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--line-1)" }}>
        {ALL_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => handleTypeChange(t)}
            style={{
              flex: 1, padding: "5px 0",
              fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: type === t ? `color-mix(in oklch, ${TYPE_COLOR[t]} 15%, transparent)` : "transparent",
              color: type === t ? TYPE_COLOR[t] : "var(--fg-4)",
              border: "none", borderRight: "1px solid var(--line-1)",
              cursor: "pointer",
            }}
          >
            {t === "DIRECTION" ? "DIR" : t}
          </button>
        ))}
      </div>

      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Character select (DIALOGUE only) */}
        {type === "DIALOGUE" && (
          <select
            value={character}
            onChange={(e) => handleCharChange(e.target.value)}
            className="input"
            style={{ fontSize: 11, padding: "3px 6px" }}
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}

        {/* Track name (non-DIALOGUE) */}
        {type !== "DIALOGUE" && (
          <input
            className="input"
            value={track}
            onChange={(e) => setTrack(e.target.value)}
            placeholder="Track name…"
            style={{ fontSize: 11, padding: "3px 6px" }}
          />
        )}

        {/* Prompt */}
        <textarea
          ref={promptRef}
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) handleAdd(); if (e.key === "Escape") onCancel(); }}
          placeholder={type === "DIRECTION" ? "Stage direction…" : "Prompt or line…"}
          rows={2}
          style={{
            width: "100%", background: "var(--bg-1)", border: "1px solid var(--line-2)",
            borderRadius: 2, color: "var(--fg-0)", fontFamily: "inherit",
            fontSize: 11.5, lineHeight: 1.5, padding: "4px 6px", resize: "none",
            outline: "none",
          }}
        />

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onCancel} style={{ fontSize: 10 }}>
            Cancel
          </button>
          <button
            className="btn btn-sm"
            onClick={handleAdd}
            style={{
              fontSize: 10,
              background: `color-mix(in oklch, ${typeColor} 12%, transparent)`,
              borderColor: `color-mix(in oklch, ${typeColor} 40%, transparent)`,
              color: typeColor,
            }}
          >
            Add ⌘↵
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

export const ScriptCanvas: React.FC<ScriptCanvasProps> = ({
  rows, characters, sceneNo, sceneSlug, onAdd, onDelete, onUpdate,
}) => {
  const { setView } = useUiStore();
  const [addingRow, setAddingRow] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // ── Drag-to-reorder ──
  const handleDragStart = (i: number) => setDragIndex(i);
  const handleDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    setDragOverIndex(i);
  };
  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const reordered = [...rows];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    // Commit reordered by deleting all and re-adding — simpler: update all rows
    reordered.forEach((row, i) => {
      if (JSON.stringify(row) !== JSON.stringify(rows[i])) {
        onUpdate(i, row);
      }
    });
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const handleDragEnd = () => { setDragIndex(null); setDragOverIndex(null); };

  // ── Place (auto-set start_ms) ──
  const handlePlace = (rowIndex: number) => {
    const row = rows[rowIndex];
    const placed = rows.filter((r, i) => i !== rowIndex && r.track === row.track && r.start_ms);
    const lastEnd = placed.reduce((max, r) => {
      const end = Number(r.start_ms) + (Number(r.duration_ms) || 5000);
      return end > max ? end : max;
    }, 0);
    onUpdate(rowIndex, { start_ms: String(lastEnd) });
  };

  // ── Generate (navigate to panel) ──
  const handleGenerate = (row: ScriptRow) => {
    const target = TYPE_VIEW[row.type];
    if (target) setView(target);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        padding: "8px 12px 8px 12px",
        borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
          color: "var(--fg-4)", textTransform: "uppercase",
        }}>
          Script · {rows.length}
        </span>
        <button
          className="btn btn-sm"
          onClick={() => setAddingRow(true)}
          style={{ padding: "2px 8px", fontSize: 13, lineHeight: 1 }}
          title="Add row"
        >
          +
        </button>
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflowY: "auto", paddingTop: 6 }}>
        {rows.length === 0 && !addingRow && (
          <div style={{
            margin: "24px 16px", padding: 16,
            border: "1px dashed var(--line-2)", borderRadius: 3,
            textAlign: "center", fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6,
          }}>
            No script rows yet.
            <br />
            <button
              className="btn btn-sm"
              onClick={() => setAddingRow(true)}
              style={{ marginTop: 8 }}
            >
              + Add first row
            </button>
          </div>
        )}

        {rows.map((row, i) => (
          <ScriptCard
            key={i}
            row={row}
            rowIndex={i}
            sceneSlug={sceneSlug}
            isDragOver={dragOverIndex === i && dragIndex !== i}
            onDelete={() => onDelete(i)}
            onUpdate={(patch) => onUpdate(i, patch)}
            onGenerate={() => handleGenerate(row)}
            onPlace={() => handlePlace(i)}
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={() => handleDrop(i)}
            onDragEnd={handleDragEnd}
          />
        ))}

        {addingRow && (
          <AddRowForm
            sceneNo={sceneNo}
            characters={characters}
            onAdd={(row) => { onAdd(row); setAddingRow(false); }}
            onCancel={() => setAddingRow(false)}
          />
        )}
      </div>
    </div>
  );
};
