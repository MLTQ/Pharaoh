/**
 * RebuildWizard.tsx
 *
 * "Rebuild from a recording": turn a finished audio drama back into the
 * project that could have made it — scenes, script, characters with voice
 * references, sound effects, music, and remainder beds that make it render
 * back to the source. Opened from the project launcher.
 *
 *   1. Source     a finished Dissect import, or dissect a new recording here
 *   2. Configure  title, chapters, what to itemise; live plan preview with
 *                 scenes, characters and disk estimate; rights confirmation
 *   3. Build      background job (dissectStore.trackRebuild), then Open
 *
 * The plan comes from the backend (dissect_rebuild_plan) so what's previewed
 * is exactly what gets built.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { DissectImportSummary, RebuildOptions, RebuildPlan } from "../../lib/types";
import { dissectRebuildPlan, dissectRebuildStart, dissectSubmit, listDissectImports } from "../../lib/tauriCommands";
import { openProjectById } from "../../lib/openProject";
import { useDissectStore } from "../../store/dissectStore";
import { RIGHTS_STATEMENT } from "../dissect/DissectReview";

const AUDIO_EXTENSIONS = ["m4b", "m4a", "mp3", "wav", "flac", "ogg", "opus", "aac", "mp4", "mkv", "webm"];

function fmt(s: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
const gb = (b: number) => `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB`;

const box: React.CSSProperties = {
  background: "var(--bg-1)", border: "1px solid var(--line-1)", borderRadius: 3, padding: "12px 14px", marginBottom: 12,
};
const kicker: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em", color: "var(--fg-4)",
  textTransform: "uppercase", marginBottom: 6,
};

export const RebuildWizard: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [imports, setImports] = useState<DissectImportSummary[]>([]);
  const [importId, setImportId] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ id: string; name: string } | null>(null);
  const [title, setTitle] = useState("");
  const [chapters, setChapters] = useState<Set<number> | null>(null); // null = all
  const [sounds, setSounds] = useState(true);
  const [remainders, setRemainders] = useState(true);
  const [rights, setRights] = useState(false);
  const [plan, setPlan] = useState<RebuildPlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const statuses = useDissectStore((s) => s.statuses);
  const rebuilds = useDissectStore((s) => s.rebuilds);
  const job = jobId ? rebuilds[jobId] : undefined;

  useEffect(() => {
    listDissectImports().then((xs) => setImports(xs.filter((x) => x.status === "complete"))).catch((e) => setErr(String(e)));
  }, []);

  // A recording dissected from inside the wizard: continue when it completes.
  const pending = pendingImport ? statuses[pendingImport.id] : undefined;
  useEffect(() => {
    if (!pendingImport || !pending) return;
    if (pending.status === "complete") { setImportId(pendingImport.id); setPendingImport(null); }
    if (pending.status === "failed" || pending.status === "cancelled") {
      setErr(pending.error ?? `Dissect ${pending.status}`);
      setPendingImport(null);
    }
  }, [pendingImport, pending]);

  const options: RebuildOptions = useMemo(() => ({
    title: title.trim() || null,
    chapters: chapters ? [...chapters].sort((a, b) => a - b) : null,
    include_sounds: sounds,
    include_remainders: remainders,
    rights_confirmed: rights,
    rights_statement: RIGHTS_STATEMENT,
  }), [title, chapters, sounds, remainders, rights]);

  // Live plan preview (debounced).
  useEffect(() => {
    if (!importId) { setPlan(null); return; }
    const t = window.setTimeout(() => {
      dissectRebuildPlan(importId, { ...options, rights_confirmed: false })
        .then((p) => { setPlan(p); setPlanErr(null); if (!title) setTitle(p.title); })
        .catch((e) => { setPlan(null); setPlanErr(String(e)); });
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId, options.chapters?.join(","), sounds, remainders]);

  const dissectNew = async () => {
    setErr(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: "Choose a recording to rebuild", multiple: false,
        filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as { path: string }).path;
      const imp = await dissectSubmit(path, { separate: true });
      useDissectStore.getState().track(imp.import_id, imp.source_name);
      setPendingImport({ id: imp.import_id, name: imp.source_name });
    } catch (e) {
      setErr(String(e));
    }
  };

  const build = async () => {
    if (!importId || !plan) return;
    setErr(null);
    try {
      const id = await dissectRebuildStart(importId, { ...options, title: title.trim() || plan.title });
      useDissectStore.getState().trackRebuild(id, title.trim() || plan.title);
      setJobId(id);
    } catch (e) {
      setErr(String(e));
    }
  };

  const tooBig = plan && plan.free_bytes !== null && plan.est_bytes + 2e9 > plan.free_bytes;
  const toggleChapter = (i: number) => setChapters((prev) => {
    const all = new Set(plan?.chapters.map((c) => c.index) ?? []);
    const next = new Set(prev ?? all);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next.size === all.size ? null : next;
  });

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 60, background: "color-mix(in oklch, var(--bg-0) 75%, transparent)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 720, maxWidth: "94vw", maxHeight: "90vh", overflow: "auto",
        background: "var(--bg-0)", border: "1px solid var(--line-2)", borderRadius: 4,
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)", padding: "18px 20px",
      }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>Rebuild a project from a recording</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={onClose} style={{ fontSize: 13, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 14 }}>
          Turns a finished audio drama back into a Pharaoh project: scenes from its chapters, a script with
          every line, characters with their voices, its sound effects and music, and the rest as beds so it
          renders back to the original. Then change whatever you like and render it out again.
        </div>

        {err && <div style={{ ...box, borderColor: "var(--sfx)", color: "var(--sfx)", fontSize: 11.5, whiteSpace: "pre-wrap" }}>{err}</div>}

        {/* ── Building / done ─────────────────────────────────────── */}
        {jobId ? (
          <div style={box}>
            <div style={kicker}>{job?.done ? (job.error ? "Failed" : "Done") : "Building"}</div>
            <div style={{ fontSize: 13, color: "var(--fg-1)", marginBottom: 8 }}>{job?.error ?? job?.message ?? "Starting…"}</div>
            {!job?.done && (
              <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%`, height: "100%", background: "var(--tts)", transition: "width 0.4s" }} />
              </div>
            )}
            {job?.done && job.project_id && (
              <button className="btn btn-primary" style={{ marginTop: 6 }}
                      onClick={() => { void openProjectById(job.project_id!); onClose(); }}>
                Open project →
              </button>
            )}
            {!job?.done && (
              <div style={{ fontSize: 10.5, color: "var(--fg-4)", marginTop: 8 }}>
                It keeps going if you close this — it's in the job queue, and a toast opens the project when it's done.
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ── 1. Source ─────────────────────────────────────────── */}
            <div style={box}>
              <div style={kicker}>1 · Source</div>
              {pendingImport ? (
                <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
                  Dissecting <strong>{pendingImport.name}</strong> — {pending?.message ?? "starting…"}{" "}
                  ({Math.round((pending?.progress ?? 0) * 100)}%). This continues automatically when it's done.
                </div>
              ) : (
                <>
                  {imports.map((imp) => (
                    <label key={imp.import_id} style={{
                      display: "flex", gap: 8, alignItems: "center", padding: "5px 2px", fontSize: 12, cursor: "pointer",
                      color: importId === imp.import_id ? "var(--fg-0)" : "var(--fg-2)",
                    }}>
                      <input type="radio" name="src" checked={importId === imp.import_id}
                             onChange={() => { setImportId(imp.import_id); setTitle(""); setChapters(null); }} />
                      <span style={{ flex: 1 }}>{imp.source_name}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)" }}>
                        {imp.duration_s ? fmt(imp.duration_s) : ""} · {imp.speaker_count ?? "?"} voices
                      </span>
                    </label>
                  ))}
                  {imports.length === 0 && (
                    <div style={{ fontSize: 11.5, color: "var(--fg-4)", marginBottom: 6 }}>No finished Dissect imports yet.</div>
                  )}
                  <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={dissectNew}>Dissect a new recording…</button>
                </>
              )}
            </div>

            {/* ── 2. Configure + preview ──────────────────────────────── */}
            {importId && (
              <div style={box}>
                <div style={kicker}>2 · Project</div>
                {planErr && <div style={{ fontSize: 11.5, color: "var(--sfx)", marginBottom: 8 }}>{planErr}</div>}
                <label style={{ fontSize: 10.5, color: "var(--fg-3)", display: "block", marginBottom: 10 }}>
                  Title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} style={{
                    width: "100%", boxSizing: "border-box", fontSize: 13, background: "var(--bg-0)", color: "var(--fg-0)",
                    border: "1px solid var(--line-2)", borderRadius: 3, padding: "6px 8px", marginTop: 3,
                  }} />
                </label>

                {plan && plan.chapters.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginBottom: 4 }}>
                      Chapters ({chapters ? chapters.size : plan.chapters.length} of {plan.chapters.length})
                      <button className="btn btn-sm" style={{ marginLeft: 8, padding: "0 6px" }} onClick={() => setChapters(null)}>All</button>
                    </div>
                    <div style={{ maxHeight: 140, overflow: "auto", border: "1px solid var(--line-1)", borderRadius: 2 }}>
                      {plan.chapters.map((c) => (
                        <label key={c.index} style={{ display: "flex", gap: 8, padding: "3px 8px", fontSize: 11.5, color: "var(--fg-2)", cursor: "pointer" }}>
                          <input type="checkbox" checked={!chapters || chapters.has(c.index)} onChange={() => toggleChapter(c.index)} />
                          <span style={{ flex: 1 }}>{c.title}</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)" }}>{fmt(c.end - c.start)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--fg-2)", marginBottom: 4 }}>
                  <input type="checkbox" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
                  Itemise sound effects, ambience and music as their own rows
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--fg-2)", marginBottom: 10 }}>
                  <input type="checkbox" checked={remainders} onChange={(e) => setRemainders(e.target.checked)} />
                  Keep everything else as beds — renders back to the original (recommended)
                </label>

                {plan && (
                  <>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-3)", marginBottom: 8 }}>
                      {plan.scenes.length} scenes · {plan.rows} script rows · {plan.characters.length} characters · {fmt(plan.duration_s)}
                      {" "}· about {gb(plan.est_bytes)} on disk
                      {plan.free_bytes !== null && <> of {gb(plan.free_bytes)} free</>}
                    </div>
                    {tooBig && (
                      <div style={{ fontSize: 11.5, color: "var(--sfx)", marginBottom: 8 }}>
                        Not enough disk for all of it — untick some chapters.
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                      {plan.characters.map((c) => (
                        <span key={c.name} title={c.extras ? `${c.speaker_ids.length} minor voices, no voice reference` : `${c.reference_clips} reference clips${c.performer ? ` · performed by ${c.performer}` : ""}`}
                              style={{ fontSize: 11, padding: "2px 8px", border: "1px solid var(--line-2)", borderRadius: 10,
                                       color: c.extras ? "var(--fg-4)" : "var(--tts)" }}>
                          {c.name} <span style={{ color: "var(--fg-4)" }}>{fmt(c.speech_s)}</span>
                        </span>
                      ))}
                    </div>
                    <div style={{ maxHeight: 160, overflow: "auto", border: "1px solid var(--line-1)", borderRadius: 2 }}>
                      {plan.scenes.map((sc, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, padding: "3px 8px", fontSize: 11.5, color: "var(--fg-2)" }}>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)", width: 22 }}>{String(i + 1).padStart(2, "0")}</span>
                          <span style={{ flex: 1 }}>{sc.title}</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-4)" }}>
                            {fmt(sc.end - sc.start)} · {sc.lines} lines · {sc.sounds} sounds
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── 3. Rights + build ───────────────────────────────────── */}
            {importId && plan && (
              <>
                <label style={{
                  display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", marginBottom: 12, borderRadius: 3,
                  border: `1px solid ${rights ? "var(--line-2)" : "var(--tts-d)"}`, fontSize: 12, color: "var(--fg-1)", cursor: "pointer",
                }}>
                  <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>
                    <strong>{RIGHTS_STATEMENT}</strong>
                    <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                      The rebuilt project reproduces the recording's performances and clones its voices; this
                      confirmation is recorded on every character it creates.
                    </span>
                  </span>
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button className="btn" onClick={onClose}>Cancel</button>
                  <button className="btn btn-primary" disabled={!rights || !!tooBig || !plan.scenes.length}
                          style={{ opacity: !rights || tooBig ? 0.45 : 1 }} onClick={build}>
                    Build project
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
