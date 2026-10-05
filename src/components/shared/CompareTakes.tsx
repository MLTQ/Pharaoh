/**
 * CompareTakes — every take of one script line, blind.
 *
 * Takes are lettered A, B, C… in a fresh random order each time the panel
 * opens, so the newest (or the one in use) doesn't get a head start. Each can
 * be played, rated 1–5 (saved with the scene), and put on the row. "Reveal"
 * shows which is which: engine, seed, direction, and whether it was voice
 * locked or cleaned up. Breeze's take check (how far it was off the script)
 * is shown blind, since it's a fact about the take, not its source.
 */

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PlayButton } from "./PlayButton";
import { rateTake, rowTakes, type RowTake } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";

interface Props {
  projectId: string;
  sceneSlug: string;
  rowIndex: number;
  line: string;
  who: string;
  direction: string;
  /** Put a take on the row. */
  onUse: (path: string) => void;
  onClose: () => void;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** "take check: 12% off the script; heard "…"" → "12% off the script". */
function takeCheck(notes: string): string | null {
  const m = notes.match(/take check:\s*([^;·]+)/);
  return m ? m[1].trim() : null;
}

function versionsLabel(t: RowTake): string {
  const v = t.versions.map((p) => p.split("/").pop() ?? p);
  const steps = [v.some((n) => n.includes(".lock.")) && "voice lock", v.some((n) => n.includes(".upscaled.")) && "AudioSR"].filter(Boolean);
  return steps.length ? ` + ${steps.join(" + ")}` : "";
}

export const CompareTakes: React.FC<Props> = ({ projectId, sceneSlug, rowIndex, line, who, direction, onUse, onClose }) => {
  const [takes, setTakes] = useState<RowTake[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [usedPath, setUsedPath] = useState<string | null>(null);

  useEffect(() => {
    rowTakes({ projectId, sceneSlug, rowIndex })
      .then((t) => setTakes(shuffled(t)))
      .catch((e) => { reportError("Couldn't list takes", e); setTakes([]); });
  }, [projectId, sceneSlug, rowIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rate = (t: RowTake, r: number) => {
    const next = t.rating === r ? null : r;
    setTakes((ts) => ts?.map((x) => (x.key === t.key ? { ...x, rating: next } : x)) ?? ts);
    rateTake({ projectId, sceneSlug, key: t.key, rating: next }).catch((e) => reportError("Rating not saved", e));
  };

  const best = useMemo(() => {
    const rated = (takes ?? []).filter((t) => t.rating != null);
    return rated.length ? Math.max(...rated.map((t) => t.rating!)) : null;
  }, [takes]);

  // Portalled: the panel opens from inside draggable script cards.
  return createPortal(
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, black 55%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div
        role="dialog"
        aria-label="Compare takes"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(720px, 100%)", maxHeight: "85vh", overflow: "auto", background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 4, padding: "16px 18px" }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg-4)" }}>
            Compare takes · {who}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => setRevealed((r) => !r)} title="Show which take is which">
            {revealed ? "Hide" : "Reveal"}
          </button>
          <button className="btn btn-sm" onClick={onClose} title="Close (Esc)">×</button>
        </div>
        <div style={{ fontSize: 14, color: "var(--fg-0)", lineHeight: 1.5 }}>{line}</div>
        {direction && <div style={{ fontSize: 11.5, color: "var(--fg-3)", fontStyle: "italic", marginTop: 2 }}>{direction}</div>}

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {takes == null && <div style={{ fontSize: 11, color: "var(--fg-4)" }}>Finding takes…</div>}
          {takes?.length === 0 && <div style={{ fontSize: 11, color: "var(--fg-4)" }}>No takes of this line yet.</div>}
          {takes?.map((t, i) => {
            const check = takeCheck(t.qa_notes);
            const inUse = usedPath ? t.versions.includes(usedPath) : t.in_use;
            return (
              <div
                key={t.key}
                style={{
                  display: "grid", gridTemplateColumns: "28px auto minmax(0, 1fr) auto auto", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 3,
                  background: "var(--bg-2)",
                  border: `1px solid ${t.rating != null && t.rating === best ? "var(--tts)" : "var(--line-1)"}`,
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>{LETTERS[i] ?? i + 1}</span>
                <PlayButton path={t.path} size={14} />
                <div style={{ minWidth: 0, fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.45 }}>
                  {check && <div title={t.qa_notes}>take check: {check}</div>}
                  {revealed && (
                    <div style={{ color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.versions.join("\n")}>
                      {t.model}{versionsLabel(t)}{t.seed != null ? ` · seed ${t.seed}` : ""}
                      {t.instruct ? ` · “${t.instruct}”` : ""}
                      {t.generated_at ? ` · ${new Date(t.generated_at).toLocaleString()}` : ""}
                    </div>
                  )}
                  {inUse && <div style={{ color: "var(--st-rendered)" }}>on the row</div>}
                </div>
                <div style={{ display: "flex", gap: 2 }} aria-label={`Rate take ${LETTERS[i]}`}>
                  {[1, 2, 3, 4, 5].map((r) => (
                    <button
                      key={r}
                      onClick={() => rate(t, r)}
                      title={`Rate ${r}`}
                      style={{
                        width: 24, height: 22, fontSize: 10.5, fontFamily: "var(--font-mono)", cursor: "pointer", borderRadius: 2,
                        border: "1px solid var(--line-2)",
                        background: t.rating === r ? "var(--tts)" : "transparent",
                        color: t.rating === r ? "var(--bg-0)" : "var(--fg-2)",
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn-sm"
                  disabled={inUse}
                  onClick={() => { onUse(t.path); setUsedPath(t.path); }}
                  title="Put this take on the row"
                >
                  {inUse ? "In use" : "Use"}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 10 }}>
          Order is shuffled each time. Ratings are saved with the scene; the highest-rated take is outlined.
        </div>
      </div>
    </div>,
    document.body,
  );
};
