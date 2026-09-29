/**
 * DissectImportModal.tsx
 *
 * "Import voices from a recording": pick an existing audio drama, let the
 * dissect server separate and diarize it, then audition each detected speaker
 * and turn them into Library characters. Opened from the Library sidebar and
 * from the Cast "Add character" modal; when opened with a `projectId`, newly
 * created characters can also be added to that episode's cast.
 *
 * Stages: pick → running → review. Running imports are polled by
 * `dissectStore` (which also owns the job-queue row), so closing this modal
 * never stalls a job; the running stage just follows the store.
 * The rights confirmation gates every "Add" — nothing reaches a character
 * until it is ticked, and the Rust side refuses without it too.
 */

import React, { useCallback, useEffect, useState } from "react";
import type {
  Character,
  DissectImportSummary,
  DissectStatus,
  LibraryCharacterSummary,
} from "../../lib/types";
import {
  deleteDissectImport,
  dissectAssignSpeaker,
  dissectStatus,
  dissectSubmit,
  importCharacterFromLibrary,
  listDissectImports,
  listLibraryCharacters,
} from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { fileSrc } from "../../lib/transport";
import { DissectSpeakerCard, type AssignChoice } from "./DissectSpeakerCard";
import { useDissectStore } from "../../store/dissectStore";

export const RIGHTS_STATEMENT =
  "I own this recording or have permission from the performer to clone this voice, " +
  "and I will not use it to impersonate them.";

// .m4b / .m4a audiobooks bring chapters, tags and cover art along with the audio.
const AUDIO_EXTENSIONS = ["m4b", "m4a", "mp3", "wav", "flac", "ogg", "opus", "aac", "mp4", "mkv", "webm"];

type Stage = "pick" | "running" | "review";

export const DissectImportModal: React.FC<{
  onClose: () => void;
  /** When set, newly created characters can also be added to this project's cast. */
  projectId?: string | null;
  /** Called after each successful assignment so the caller can refresh lists. */
  onAssigned?: (character: Character, addedToProject: boolean) => void;
  /** Open straight at this import (e.g. from the "Review →" toast). */
  initialImportId?: string | null;
}> = ({ onClose, projectId, onAssigned, initialImportId }) => {
  const [stage, setStage] = useState<Stage>("pick");
  const [imports, setImports] = useState<DissectImportSummary[]>([]);
  const [separate, setSeparate] = useState(true);
  const [importId, setImportId] = useState<string | null>(null);
  const [status, setStatus] = useState<DissectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryCharacterSummary[]>([]);
  const [rights, setRights] = useState(false);
  const [addToCast, setAddToCast] = useState(!!projectId);
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [busySpeaker, setBusySpeaker] = useState<string | null>(null);
  const tracked = useDissectStore((s) => (importId ? s.statuses[importId] : undefined));
  const track = useDissectStore((s) => s.track);
  const cancelRun = useDissectStore((s) => s.cancel);
  const retryRun = useDissectStore((s) => s.retry);

  const refreshImports = useCallback(() => {
    listDissectImports().then(setImports).catch((e) => reportError("List imports", e));
  }, []);
  const refreshLibrary = useCallback(() => {
    listLibraryCharacters().then(setLibrary).catch((e) => reportError("List library", e));
  }, []);

  useEffect(() => { refreshImports(); refreshLibrary(); }, [refreshImports, refreshLibrary]);

  // Follow the store's poll of the running import.
  useEffect(() => {
    if (stage !== "running" || !tracked) return;
    setStatus(tracked);
    if (tracked.status === "complete") { setStage("review"); refreshImports(); }
    if (tracked.status === "failed") { setError(tracked.error ?? "Dissect failed"); setStage("pick"); refreshImports(); }
    if (tracked.status === "cancelled") { setStage("pick"); refreshImports(); }
  }, [stage, tracked, refreshImports]);

  // A finished import is read once; a running one is handed to the tracker
  // (which adds it to the job queue if it isn't there already).
  const openImport = useCallback(async (id: string, sourceName?: string) => {
    setError(null);
    setImportId(id);
    setStatus(null);
    setAssigned({});
    try {
      const s = await dissectStatus(id);
      if (s.status === "running") {
        setStage("running");
        track(id, sourceName ?? s.manifest?.source_name ?? "recording");
      } else if (s.status === "complete") {
        setStatus(s);
        setStage("review");
      } else {
        setError(s.error ?? "Dissect failed");
        setStage("pick");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("pick");
    }
  }, [track]);

  useEffect(() => {
    if (initialImportId) void openImport(initialImportId);
  }, [initialImportId, openImport]);

  const handleChoose = async () => {
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
      setStage("running");
      setStatus(null);
      const imp = await dissectSubmit(path, { separate });
      setImportId(imp.import_id);
      setAssigned({});
      track(imp.import_id, imp.source_name);
      refreshImports();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("pick");
    }
  };

  const handleDeleteImport = async (id: string) => {
    if (!window.confirm("Delete this import's stems and clips? Characters keep the clips they already took.")) return;
    try {
      await deleteDissectImport(id);
      refreshImports();
    } catch (e) {
      reportError("Delete import", e);
    }
  };

  const handleAssign = async (speakerId: string, choice: AssignChoice) => {
    if (!importId || !rights) return;
    setBusySpeaker(speakerId);
    setError(null);
    try {
      const character = await dissectAssignSpeaker({
        import_id: importId,
        speaker_id: speakerId,
        candidate_ids: choice.candidateIds,
        gold_candidate_id: choice.goldId,
        library_id: choice.libraryId,
        new_name: choice.newName,
        rights_confirmed: true,
        rights_statement: RIGHTS_STATEMENT,
        performer: choice.performer,
      });
      // Only brand-new characters go into the cast; an existing library
      // character is either already there or deliberately not.
      let addedToProject = false;
      if (projectId && addToCast && !choice.libraryId && character.library_id) {
        await importCharacterFromLibrary({ projectId, libraryId: character.library_id });
        addedToProject = true;
      }
      setAssigned((prev) => ({ ...prev, [speakerId]: character.name }));
      refreshLibrary();
      onAssigned?.(character, addedToProject);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySpeaker(null);
    }
  };

  const manifest = status?.manifest ?? null;
  const pct = Math.round((status?.progress ?? 0) * 100);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        background: "color-mix(in oklch, var(--bg-0) 70%, transparent)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)", border: "1px solid var(--line-2)",
          borderRadius: "var(--radius)", width: 760, maxWidth: "94vw", maxHeight: "88vh",
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "14px 18px", borderBottom: "1px solid var(--line-1)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          {manifest?.cover && status && (
            <img
              src={fileSrc(`${status.import_dir}/${manifest.cover}`)}
              alt=""
              style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 2, border: "1px solid var(--line-2)" }}
            />
          )}
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>
              {manifest
                ? (manifest.source_tags?.album || manifest.source_tags?.title || "Import voices from a recording")
                : "Import voices from a recording"}
            </span>
            {manifest && (
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {manifest.source_tags?.artist ? `${manifest.source_tags.artist} · ` : ""}
                {manifest.source_name} · {Math.round(manifest.duration_s / 60)} min
                {(manifest.chapters?.length ?? 0) > 0 ? ` · ${manifest.chapters!.length} chapters` : ""}
                {" "}· {manifest.speakers.length} speakers
              </span>
            )}
          </span>
          <span style={{ flex: 1 }} />
          {stage === "review" && (
            <button className="btn btn-sm" onClick={() => { setStage("pick"); setStatus(null); }}>
              ← Imports
            </button>
          )}
          <button className="btn btn-sm" onClick={onClose} style={{ fontSize: 13, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", flex: 1 }}>
          {error && (
            <div style={{
              marginBottom: 12, padding: "8px 12px", fontSize: 11.5,
              border: "1px solid var(--tts-d)", color: "var(--tts)", borderRadius: 2,
              whiteSpace: "pre-wrap",
            }}>{error}</div>
          )}

          {/* ── Pick ── */}
          {stage === "pick" && (
            <>
              <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6, marginBottom: 14 }}>
                Pharaoh separates dialogue from music and effects, works out who speaks when,
                transcribes each line, and picks clean 3–15 second clips of every voice for
                cloning. Runs on the dissect server (port 18007).
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
                <button className="btn btn-primary" onClick={handleChoose}>Choose recording…</button>
                <label style={{ fontSize: 11.5, color: "var(--fg-2)", display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
                  Separate music and effects first (recommended unless the source is dry dialogue)
                </label>
              </div>

              {imports.length > 0 && (
                <>
                  <div style={{
                    fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
                    color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 6,
                  }}>Previous imports</div>
                  {imports.map((imp) => (
                    <div key={imp.import_id} style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "7px 10px",
                      borderBottom: "1px solid var(--line-1)", fontSize: 12,
                    }}>
                      <span style={{ flex: 1, color: "var(--fg-1)" }}>{imp.source_name}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>
                        {imp.status === "complete"
                          ? `${imp.speaker_count ?? "?"} speakers · ${Math.round((imp.duration_s ?? 0) / 60)} min`
                          : imp.status}
                        {" · "}{new Date(imp.created_at).toLocaleDateString()}
                      </span>
                      {(imp.status === "running" || imp.status === "complete") && (
                        <button className="btn btn-sm" onClick={() => openImport(imp.import_id, imp.source_name)}>
                          {imp.status === "running" ? "Resume" : "Open"}
                        </button>
                      )}
                      {(imp.status === "failed" || imp.status === "cancelled") && (
                        <button
                          className="btn btn-sm"
                          title="Run again with the same settings"
                          onClick={async () => {
                            setError(null);
                            setImportId(imp.import_id);
                            setAssigned({});
                            setStatus(null);
                            setStage("running");
                            if (!(await retryRun(imp.import_id, imp.source_name))) setStage("pick");
                            refreshImports();
                          }}
                        >Retry</button>
                      )}
                      <button className="btn btn-sm" onClick={() => handleDeleteImport(imp.import_id)} title="Delete import">×</button>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {/* ── Running ── */}
          {stage === "running" && (
            <div style={{ padding: "30px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 12.5, color: "var(--fg-1)", marginBottom: 12 }}>
                {status?.message ?? "Submitting…"}
              </div>
              <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden", maxWidth: 420, margin: "0 auto" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--tts)", transition: "width 0.4s" }} />
              </div>
              {importId && (
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 14 }}
                  disabled={status?.message === "Cancelling…"}
                  onClick={() => cancelRun(importId)}
                >Cancel import</button>
              )}
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 8 }}>
                {pct}% · runs in the background — it's in the job queue, and you'll get a toast when it's done
              </div>
            </div>
          )}

          {/* ── Review ── */}
          {stage === "review" && manifest && status && (
            <>
              {manifest.warnings.map((w) => (
                <div key={w} style={{
                  marginBottom: 10, padding: "8px 12px", fontSize: 11.5,
                  border: "1px solid var(--line-2)", color: "var(--tts)", borderRadius: 2,
                }}>{w}</div>
              ))}

              <label style={{
                display: "flex", gap: 10, alignItems: "flex-start",
                padding: "10px 12px", marginBottom: 14, borderRadius: 2,
                border: `1px solid ${rights ? "var(--line-2)" : "var(--tts-d)"}`,
                background: rights ? "var(--bg-1)" : "color-mix(in oklch, var(--tts) 8%, var(--bg-1))",
                fontSize: 12, color: "var(--fg-1)", lineHeight: 1.5, cursor: "pointer",
              }}>
                <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  <strong>{RIGHTS_STATEMENT}</strong>
                  <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                    Required before any voice is added. Pharaoh records this confirmation and the
                    source file on each character it creates.
                  </span>
                </span>
              </label>

              {projectId && (
                <label style={{ fontSize: 11.5, color: "var(--fg-2)", display: "flex", gap: 6, alignItems: "center", marginBottom: 14 }}>
                  <input type="checkbox" checked={addToCast} onChange={(e) => setAddToCast(e.target.checked)} />
                  Also add new characters to this episode's cast
                </label>
              )}

              {manifest.speakers.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>No speech found in this recording.</div>
              )}
              {manifest.speakers.map((sp) => (
                <DissectSpeakerCard
                  key={sp.id}
                  speaker={sp}
                  importDir={status.import_dir}
                  chapters={manifest.chapters ?? []}
                  library={library}
                  assignedTo={assigned[sp.id] ?? null}
                  busy={busySpeaker === sp.id}
                  rightsConfirmed={rights}
                  onAssign={(choice) => handleAssign(sp.id, choice)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
