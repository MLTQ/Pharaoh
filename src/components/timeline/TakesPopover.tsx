import React, { useEffect, useMemo, useRef } from "react";
import { TakeRow } from "../shared/TakeList";
import { useJobStore, takeKey } from "../../store/jobStore";
import { updateScriptRow } from "../../lib/tauriCommands";
import { useToastStore } from "../../store/toastStore";
import type { Job, ScriptRow } from "../../lib/types";

// ── Take families popover ───────────────────────────────────────────────────
//
// Right-click a clip on the timeline → this surface lists every job that
// produced a take for that row. The user can:
//   - audition each take (PlayButton on each row)
//   - approve/reject (sidecar QA fields)
//   - "use" any take, which both sets it as the active take in jobStore *and*
//     rewrites script.csv's row to point at that take's output file. Renders
//     immediately reflect the choice.
//
// The data model already supports this — sidecars carry parent/take_index,
// jobStore tracks activeTakes, and TTSPanel/SFXPanel/MusicPanel write multiple
// takes per row. What was missing was a place inside the timeline to switch
// between them.

export interface TakesPopoverProps {
  projectId: string | null;
  sceneSlug: string | null;
  rowIndex: number;
  row: ScriptRow | null;
  // Pixel position to anchor the popover (viewport coords)
  x: number;
  y: number;
  onClose: () => void;
  // Called after script.csv is rewritten so the parent can re-pull rows
  onTakeApplied: (newRow: ScriptRow) => void;
}

export const TakesPopover: React.FC<TakesPopoverProps> = ({
  projectId, sceneSlug, rowIndex, row, x, y, onClose, onTakeApplied,
}) => {
  const { jobs, activeTakes, setActiveTake, setQaStatus } = useJobStore();
  const pushToast = useToastStore((s) => s.push);
  const ref = useRef<HTMLDivElement>(null);

  // All jobs for this scene + row, newest first
  const takes: Job[] = useMemo(
    () => [...jobs]
      .filter((j) => j.scene_slug === sceneSlug && j.row_index === rowIndex && j.model !== "post")
      .reverse(),
    [jobs, sceneSlug, rowIndex],
  );

  // Determine which take's output path matches the row's current `file` so we
  // can mark the active selection. Falls back to jobStore.activeTakes if the
  // script row hasn't been rewritten yet.
  const activeJobId = useMemo(() => {
    if (sceneSlug && row?.file) {
      const match = takes.find((j) => j.output_path === row.file);
      if (match) return match.id;
    }
    if (sceneSlug) return activeTakes[takeKey(sceneSlug, rowIndex)] ?? null;
    return null;
  }, [takes, row, sceneSlug, rowIndex, activeTakes]);

  // Dismiss on outside click + escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // setTimeout 0 so the *triggering* right-click doesn't immediately close us
    const id = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleUseTake = async (job: Job) => {
    if (!job.output_path) return;
    if (!projectId || !sceneSlug) {
      pushToast({ kind: "warn", title: "Open a real project to swap takes" });
      return;
    }
    try {
      // Persist on the row so renders use this take
      const fields: Record<string, string> = { file: job.output_path };
      // Update duration if the job knows its peaks (proxy for "settled");
      // we don't have direct duration on Job, so leave duration_ms alone —
      // CompositionView's clip-derivation reuses whatever's in the row.
      const newRow = await updateScriptRow({
        projectId,
        sceneSlug,
        rowIndex,
        fields,
      });
      setActiveTake(sceneSlug, rowIndex, job.id);
      onTakeApplied(newRow);
      pushToast({ kind: "info", title: `Using take ${takes.length - takes.indexOf(job)}` });
    } catch (e) {
      pushToast({ kind: "error", title: `Could not swap take: ${e}` });
    }
  };

  // Clamp popover into the viewport
  const POP_W = 380;
  const POP_MAX_H = 360;
  const left = Math.min(Math.max(8, x), window.innerWidth - POP_W - 8);
  const top  = Math.min(Math.max(8, y), window.innerHeight - POP_MAX_H - 8);

  return (
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left, top,
        width: POP_W,
        maxHeight: POP_MAX_H,
        background: "var(--bg-1)",
        border: "1px solid var(--line-2)",
        borderRadius: 4,
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        zIndex: 1000,
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Takes · row {rowIndex + 1}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-2)", marginTop: 2, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row?.prompt}>
            {row?.character ? `${row.character} · ` : ""}{row?.prompt || "—"}
          </div>
        </div>
        <button
          className="btn btn-sm"
          onClick={onClose}
          style={{ padding: "1px 6px", fontSize: 12, lineHeight: 1 }}
          title="Close (Esc)"
        >×</button>
      </div>

      {/* Body */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {takes.length === 0 ? (
          <div style={{ padding: 16, fontSize: 11, color: "var(--fg-4)", textAlign: "center" }}>
            No takes yet for this row. Generate one from the Voice / Sound / Score panel.
          </div>
        ) : (
          takes.map((job, i) => (
            <TakeRow
              key={job.id}
              job={job}
              index={takes.length - 1 - i}
              isSaved={activeJobId === job.id}
              saveLabel="use"
              caption={job.description}
              onSave={() => handleUseTake(job)}
              onQa={(s) => setQaStatus(job.id, s)}
              accent={job.model === "tts" ? "var(--tts)" : job.model === "sfx" ? "var(--sfx)" : "var(--music)"}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: "6px 12px",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
        flexShrink: 0,
      }}>
        right-click a clip · ✓ approve · ✕ reject · use → bind to row
      </div>
    </div>
  );
};
