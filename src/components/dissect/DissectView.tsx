/**
 * DissectView.tsx
 *
 * The Dissect tab: take an existing recording apart and pull out what's
 * useful. Left, every import with live status (Cancel / Retry / Delete);
 * right, the selected import — progress while running, the error and a Retry
 * when it failed, and the extraction review (DissectReview) when done.
 *
 * Running imports are polled by `dissectStore` (which also owns their job-queue
 * rows), so this view only reads their status. The completion toast's
 * "Review →" lands here via `openRequest`.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { DissectImportSummary, DissectStatus } from "../../lib/types";
import { deleteDissectImport, dissectStatus, dissectSubmit, listDissectImports } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { useDissectStore } from "../../store/dissectStore";
import { useProjectStore } from "../../store/projectStore";
import { DissectReview } from "./DissectReview";

// .m4b / .m4a audiobooks bring chapters, tags and cover art along with the audio.
const AUDIO_EXTENSIONS = ["m4b", "m4a", "mp3", "wav", "flac", "ogg", "opus", "aac", "mp4", "mkv", "webm"];

const STATUS_COLOR: Record<string, string> = {
  running: "var(--st-gen)", complete: "var(--st-rendered)", failed: "var(--sfx)", cancelled: "var(--fg-4)",
};

export const DissectView: React.FC = () => {
  const { realProjectId, realScenes, reloadProjectFromDisk } = useProjectStore();
  const statuses = useDissectStore((s) => s.statuses);
  const track = useDissectStore((s) => s.track);
  const cancelRun = useDissectStore((s) => s.cancel);
  const retryRun = useDissectStore((s) => s.retry);
  const openRequest = useDissectStore((s) => s.openRequest);

  const [imports, setImports] = useState<DissectImportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DissectStatus | null>(null);
  const [separate, setSeparate] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listDissectImports().then(setImports).catch((e) => reportError("List imports", e));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Keep the list fresh while anything is running (status changes arrive via the store).
  const anyRunning = imports.some((i) => i.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, [anyRunning, refresh]);

  // "Review →" from a completion toast.
  useEffect(() => {
    if (!openRequest) return;
    setSelected(openRequest);
    useDissectStore.getState().requestOpen(null);
  }, [openRequest]);

  // Default selection: newest import.
  useEffect(() => {
    if (!selected && imports.length) setSelected(imports[0].import_id);
  }, [imports, selected]);

  const tracked = selected ? statuses[selected] : undefined;

  // Load the selected import's full status; running ones are handed to the tracker.
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false;
    setError(null);
    dissectStatus(selected).then((s) => {
      if (cancelled) return;
      setDetail(s);
      if (s.status === "running") {
        const name = imports.find((i) => i.import_id === selected)?.source_name ?? "recording";
        track(selected, name);
      }
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Follow the tracker; on a terminal state refresh the list + detail.
  useEffect(() => {
    if (!tracked || !selected || tracked.import_id !== selected) return;
    setDetail(tracked);
    if (tracked.status !== "running") refresh();
  }, [tracked, selected, refresh]);

  const handleNew = async () => {
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "Choose a recording to dissect",
        multiple: false,
        filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
      setSubmitting(true);
      const imp = await dissectSubmit(path, { separate });
      track(imp.import_id, imp.source_name);
      setSelected(imp.import_id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this import's stems and clips? Characters and scene assets keep what they already took.")) return;
    try {
      await deleteDissectImport(id);
      if (selected === id) { setSelected(null); setDetail(null); }
      refresh();
    } catch (e) {
      reportError("Delete import", e);
    }
  };

  const sel = useMemo(() => imports.find((i) => i.import_id === selected) ?? null, [imports, selected]);
  const liveStatus = detail?.status ?? sel?.status;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Imports list ─────────────────────────────────────────── */}
      <div style={{ width: 260, flexShrink: 0, borderRight: "1px solid var(--line-1)", background: "var(--bg-1)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--line-1)" }}>
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={handleNew} disabled={submitting}>
            {submitting ? "Uploading…" : "Import a recording…"}
          </button>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10.5, color: "var(--fg-3)", marginTop: 8 }}>
            <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
            Separate music & effects (needed for sounds)
          </label>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {imports.length === 0 && (
            <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6 }}>
              No imports yet. Pick an audio drama or audiobook (.m4b, .mp3, .wav …) to find its voices,
              sound effects, ambience and music.
            </div>
          )}
          {imports.map((imp) => {
            const st = statuses[imp.import_id];
            const status = st?.status ?? imp.status;
            const active = imp.import_id === selected;
            return (
              <div key={imp.import_id} className={`side-item ${active ? "active" : ""}`}
                   onClick={() => setSelected(imp.import_id)} style={{ paddingTop: 8, paddingBottom: 8, cursor: "pointer", display: "block" }}>
                <div style={{ fontSize: 12, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {imp.source_name}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", marginTop: 2, display: "flex", gap: 6 }}>
                  <span style={{ color: STATUS_COLOR[status] ?? "var(--fg-4)" }}>
                    {status === "running" ? `${Math.round((st?.progress ?? 0) * 100)}%` : status}
                  </span>
                  {imp.duration_s ? <span>{imp.duration_s >= 3600 ? `${(imp.duration_s / 3600).toFixed(1)} h` : `${Math.round(imp.duration_s / 60)} min`}</span> : null}
                  {imp.speaker_count !== null ? <span>{imp.speaker_count} voices</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Detail ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {error && (
          <div style={{ margin: "16px 26px 0", padding: "8px 12px", fontSize: 11.5, border: "1px solid var(--tts-d)", color: "var(--tts)", borderRadius: 2, whiteSpace: "pre-wrap" }}>{error}</div>
        )}

        {!sel && (
          <div style={{ padding: "60px 40px", maxWidth: 560, color: "var(--fg-3)", fontSize: 12.5, lineHeight: 1.7 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-1)", marginBottom: 8 }}>Dissect a recording</div>
            Import an existing audio drama or audiobook. Pharaoh separates dialogue from music and
            effects, works out who speaks when, transcribes every line, and finds sound effects,
            ambience and music. Then pull out what you need: voices become Library characters,
            sounds become scene assets. Runs on the dissect server (Models tab).
          </div>
        )}

        {sel && liveStatus === "running" && (
          <div style={{ padding: "60px 40px", maxWidth: 560 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)", marginBottom: 6 }}>{sel.source_name}</div>
            <div style={{ fontSize: 12.5, color: "var(--fg-2)", marginBottom: 12 }}>{detail?.message ?? "Starting…"}</div>
            <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${Math.round((detail?.progress ?? 0) * 100)}%`, height: "100%", background: "var(--tts)", transition: "width 0.4s" }} />
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
              <button className="btn btn-sm" disabled={detail?.message === "Cancelling…"} onClick={() => cancelRun(sel.import_id)}>Cancel import</button>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)" }}>
                {Math.round((detail?.progress ?? 0) * 100)}% · runs in the background; it's in the job queue
              </span>
            </div>
          </div>
        )}

        {sel && (liveStatus === "failed" || liveStatus === "cancelled") && (
          <div style={{ padding: "60px 40px", maxWidth: 620 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)", marginBottom: 6 }}>{sel.source_name}</div>
            <div style={{ fontSize: 12.5, color: liveStatus === "failed" ? "var(--sfx)" : "var(--fg-3)", marginBottom: 14, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {liveStatus === "cancelled" ? "Cancelled." : detail?.error ?? "Failed."}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={async () => { await retryRun(sel.import_id, sel.source_name); refresh(); }}>Retry</button>
              <button className="btn" onClick={() => handleDelete(sel.import_id)}>Delete</button>
            </div>
          </div>
        )}

        {sel && liveStatus === "complete" && detail?.manifest && (
          <>
            <DissectReview
              status={detail}
              projectId={realProjectId}
              scenes={realScenes}
              onAssigned={(_c, addedToProject) => { if (addedToProject) void reloadProjectFromDisk(); }}
            />
            <div style={{ padding: "0 26px 30px" }}>
              <button className="btn btn-sm" onClick={() => handleDelete(sel.import_id)}>Delete this import</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
