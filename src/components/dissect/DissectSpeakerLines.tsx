/**
 * DissectSpeakerLines.tsx
 *
 * Every line (diarization turn) attributed to one speaker: play it, tick the
 * ones that belong to someone else, and move them. Moving a line takes the
 * clips cut from it along (Rust `dissect_reassign`).
 */

import React, { useMemo, useState } from "react";
import type { DissectChapter, DissectSpeaker, DissectTurn } from "../../lib/types";
import { dissectClip } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { useAudioStore } from "../../store/audioStore";
import { Icon } from "../shared/atoms";
import { MoveToSelect, type MoveTarget } from "./MoveToSelect";

const PAGE = 100;

function fmtTime(s: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

const LinePlay: React.FC<{ importId: string; turn: DissectTurn }> = ({ importId, turn }) => {
  const { playing, toggle } = useAudioStore();
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const active = !!path && playing === path;
  return (
    <button
      className="btn btn-sm" disabled={loading} title="Play this line"
      style={{ padding: "2px 5px", lineHeight: 1 }}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          let p = path;
          if (!p) {
            setLoading(true);
            p = await dissectClip(importId, "dialogue", turn.start, turn.end);
            setPath(p);
          }
          await toggle(p);
        } catch (err) {
          reportError("Play line", err);
        } finally {
          setLoading(false);
        }
      }}
    >
      <Icon name={active ? "pause" : "play"} style={{ width: 11, height: 11 }} />
    </button>
  );
};

export const DissectSpeakerLines: React.FC<{
  importId: string;
  speaker: DissectSpeaker;
  speakers: DissectSpeaker[];
  turns: DissectTurn[];
  chapters: DissectChapter[];
  busy: boolean;
  onMove: (turnStarts: number[], target: MoveTarget) => void;
}> = ({ importId, speaker, speakers, turns, chapters, busy, onMove }) => {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? turns.filter((t) => t.text.toLowerCase().includes(q)) : turns;
  }, [turns, query]);

  const toggle = (start: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start); else next.add(start);
      return next;
    });

  const move = (t: MoveTarget) => {
    onMove([...picked], t);
    setPicked(new Set());
  };

  return (
    <div style={{ borderTop: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 14px", flexWrap: "wrap" }}>
        <input
          value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
          placeholder={`Search ${turns.length} lines`}
          style={{
            flex: 1, minWidth: 160, fontSize: 11.5, background: "var(--bg-0)", color: "var(--fg-1)",
            border: "1px solid var(--line-2)", borderRadius: 2, padding: "4px 8px",
          }}
        />
        {filtered.length > 0 && (
          <button className="btn btn-sm" onClick={() => setPicked(
            picked.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.start)),
          )}>
            {picked.size === filtered.length ? "Select none" : `Select ${query ? "matches" : "all"}`}
          </button>
        )}
        {picked.size > 0 && (
          <>
            <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{picked.size} selected</span>
            <MoveToSelect speakers={speakers} from={speaker.id} disabled={busy} onMove={move} />
          </>
        )}
      </div>
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {filtered.slice(0, shown).map((t) => (
          <div
            key={t.start}
            onClick={() => toggle(t.start)}
            style={{
              display: "grid", gridTemplateColumns: "18px 24px 1fr auto", gap: 8, alignItems: "center",
              padding: "4px 14px", cursor: "pointer",
              background: picked.has(t.start) ? "var(--bg-2)" : undefined,
            }}
          >
            <input type="checkbox" checked={picked.has(t.start)} onChange={() => toggle(t.start)} onClick={(e) => e.stopPropagation()} />
            <LinePlay importId={importId} turn={t} />
            <span style={{ fontSize: 11.5, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.text}>
              {t.text || <em style={{ color: "var(--fg-4)" }}>no transcript</em>}
              {t.overlap && <span style={{ color: "var(--fg-4)" }}> · overlapped</span>}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", whiteSpace: "nowrap" }}
              title={t.chapter != null ? chapters[t.chapter]?.title : undefined}>
              {(t.end - t.start).toFixed(1)}s · @{fmtTime(t.start)}
            </span>
          </div>
        ))}
        {filtered.length > shown && (
          <div style={{ padding: "6px 14px" }}>
            <button className="btn btn-sm" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length - shown}
            </button>
          </div>
        )}
        {filtered.length === 0 && (
          <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--fg-4)" }}>No lines match.</div>
        )}
      </div>
    </div>
  );
};
