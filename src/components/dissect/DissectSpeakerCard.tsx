/**
 * DissectSpeakerCard.tsx
 *
 * One detected speaker in a dissect import: their stats, a sample line, and
 * the candidate reference clips to audition. The user ticks the clips to keep,
 * picks a gold, chooses a target (new or existing Library character) and adds.
 * All persistence goes through the parent's `onAssign`; this card only owns
 * the selection state.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { DissectSpeaker, LibraryCharacterSummary } from "../../lib/types";
import { PlayButton } from "../shared/PlayButton";
import { CHAR_HUE } from "../library/libraryShared";

export interface AssignChoice {
  candidateIds: string[];
  goldId: string | null;
  libraryId: string | null;
  newName: string | null;
}

const NEW = "__new__";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export const DissectSpeakerCard: React.FC<{
  speaker: DissectSpeaker;
  importDir: string;
  library: LibraryCharacterSummary[];
  /** Name of the character this speaker was already added to, if any. */
  assignedTo: string | null;
  busy: boolean;
  /** False until the rights box is ticked — the Add button stays disabled. */
  rightsConfirmed: boolean;
  onAssign: (choice: AssignChoice) => void;
}> = ({ speaker, importDir, library, assignedTo, busy, rightsConfirmed, onAssign }) => {
  // Default: keep the top three clips, best one as gold.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(speaker.candidates.slice(0, 3).map((c) => c.id)),
  );
  const [gold, setGold] = useState<string | null>(speaker.candidates[0]?.id ?? null);
  const [target, setTarget] = useState<string>(NEW);
  const [name, setName] = useState("");

  // Gold must always be one of the picked clips.
  useEffect(() => {
    if (gold && !picked.has(gold)) setGold([...picked][0] ?? null);
  }, [picked, gold]);

  const hue = CHAR_HUE(speaker.id);
  const abs = (rel: string) => `${importDir}/${rel}`;
  const canAdd =
    rightsConfirmed && !busy && picked.size > 0 &&
    (target !== NEW || name.trim().length > 0);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ordered = useMemo(
    () => speaker.candidates.filter((c) => picked.has(c.id)).map((c) => c.id),
    [speaker.candidates, picked],
  );

  return (
    <div style={{
      border: "1px solid var(--line-1)", borderRadius: "var(--radius)",
      background: "var(--bg-1)", marginBottom: 12, overflow: "hidden",
      opacity: assignedTo ? 0.7 : 1,
    }}>
      {/* Header */}
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: `oklch(0.7 0.12 ${hue})`, border: "1px solid var(--line-2)",
        }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg-0)" }}>{speaker.label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
          {fmtTime(speaker.total_speech_s)} of speech · {speaker.turn_count} turns · first at {fmtTime(speaker.first_heard_s)}
        </span>
        <span style={{ flex: 1 }} />
        {assignedTo && (
          <span style={{ fontSize: 11, color: "var(--st-rendered)" }}>✓ Added to {assignedTo}</span>
        )}
      </div>

      {speaker.sample_text && (
        <div style={{
          padding: "8px 14px", fontSize: 11.5, color: "var(--fg-2)",
          fontStyle: "italic", borderBottom: "1px solid var(--line-1)",
        }}>
          “{speaker.sample_text}”
        </div>
      )}

      {/* Candidates */}
      {speaker.candidates.length === 0 ? (
        <div style={{ padding: "10px 14px", fontSize: 11, color: "var(--fg-4)" }}>
          No clean 3–15 s solo clips found for this speaker — they may only speak in short
          lines or over other voices.
        </div>
      ) : (
        <div>
          {speaker.candidates.map((c) => {
            const on = picked.has(c.id);
            return (
              <div key={c.id} style={{
                display: "grid",
                gridTemplateColumns: "20px 24px 20px 1fr auto",
                alignItems: "center", gap: 8,
                padding: "6px 14px", borderBottom: "1px solid var(--line-1)",
                background: gold === c.id ? "var(--bg-2)" : undefined,
              }}>
                <input
                  type="checkbox" checked={on} disabled={!!assignedTo}
                  onChange={() => toggle(c.id)}
                  title="Keep this clip as a reference source"
                />
                <PlayButton path={abs(c.path)} size={12} />
                <input
                  type="radio" name={`gold-${speaker.id}`} checked={gold === c.id}
                  disabled={!on || !!assignedTo}
                  onChange={() => setGold(c.id)}
                  title="Gold: the clip Chatterbox clones from"
                />
                <span style={{
                  fontSize: 11.5, color: on ? "var(--fg-1)" : "var(--fg-3)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title={c.transcript}>
                  {c.transcript || <em style={{ color: "var(--fg-4)" }}>no transcript</em>}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)",
                  display: "flex", gap: 8, whiteSpace: "nowrap",
                }}>
                  <span>{c.duration.toFixed(1)}s</span>
                  <span title="Where in the source">@{fmtTime(c.start)}</span>
                  {c.bleed_db !== null && (
                    <span
                      title="Dialogue level above music + effects in this span. Higher is cleaner."
                      style={{ color: c.bleed_db >= 12 ? "var(--st-rendered)" : c.bleed_db >= 6 ? "var(--fg-2)" : "var(--tts)" }}
                    >
                      {c.bleed_db > 0 ? "+" : ""}{c.bleed_db.toFixed(0)} dB
                    </span>
                  )}
                  {c.similarity !== null && (
                    <span
                      title="How much this clip sounds like the rest of this speaker (voice embedding similarity)"
                      style={{ color: c.similarity >= 0.8 ? "var(--st-rendered)" : c.similarity >= 0.65 ? "var(--fg-2)" : "var(--tts)" }}
                    >
                      match {(c.similarity * 100).toFixed(0)}%
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Assign row */}
      {!assignedTo && speaker.candidates.length > 0 && (
        <div style={{ padding: "10px 14px", display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{
              fontSize: 11.5, background: "var(--bg-0)", color: "var(--fg-1)",
              border: "1px solid var(--line-2)", borderRadius: 2, padding: "4px 6px",
            }}
          >
            <option value={NEW}>New character…</option>
            {library.map((l) => (
              <option key={l.library_id} value={l.library_id}>Add to {l.name}</option>
            ))}
          </select>
          {target === NEW && (
            <input
              type="text" placeholder="Character name" value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                flex: 1, fontSize: 11.5, background: "var(--bg-0)", color: "var(--fg-1)",
                border: "1px solid var(--line-2)", borderRadius: 2, padding: "4px 8px",
              }}
            />
          )}
          {target !== NEW && <span style={{ flex: 1 }} />}
          <button
            className="btn btn-sm btn-primary"
            disabled={!canAdd}
            style={{ opacity: canAdd ? 1 : 0.4, cursor: canAdd ? "pointer" : "not-allowed" }}
            title={rightsConfirmed ? undefined : "Confirm you have the rights to these voices first"}
            onClick={() => onAssign({
              candidateIds: ordered,
              goldId: gold,
              libraryId: target === NEW ? null : target,
              newName: target === NEW ? name.trim() : null,
            })}
          >
            {busy ? "Adding…" : `Add ${picked.size} clip${picked.size === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
};
