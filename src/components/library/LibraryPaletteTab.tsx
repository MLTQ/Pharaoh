/**
 * LibraryPaletteTab.tsx
 *
 * Stage-2 "Palette" tab of the library character editor: add emotions,
 * generate per-emotion Voice Design takes into the library bundle
 * (Pharaoh-g8z), upload existing recordings as per-emotion references, and
 * approve a take as the entry's reference audio.
 *
 * Owns the palette action handlers (add emotion, generate take, upload
 * reference, approve take) and the per-emotion `PaletteRow` accordion.
 * Persistent UI state (test line, add-emotion form, inline error) lives in
 * LibraryView and arrives via props so it survives tab switches; disk-scanned
 * takes (`paletteDiskTakes`) are refreshed by LibraryView on character change.
 */

import React, { useState } from "react";
import { PlayButton } from "../shared/PlayButton";
import { TakeList, TakeRow, RunningBadge, EmptyTakes } from "../shared/TakeList";
import {
  saveLibraryCharacter,
  submitTtsVoiceDesign,
  importAudioIntoLibraryBundle,
} from "../../lib/tauriCommands";
import type { PaletteTakeFile } from "../../lib/tauriCommands";
import { useJobStore } from "../../store/jobStore";
import { useProjectStore } from "../../store/projectStore";
import type { Character, PaletteEntry, QaJobStatus } from "../../lib/types";
import {
  LIBRARY_PROJECT_ID,
  LIBRARY_PALETTE_ROW,
  DEFAULT_TEST_LINE,
  libraryPaletteSlug,
  labelStyle,
  pickAudioFiles,
} from "./libraryShared";
import type { TakeJob } from "./libraryShared";

export const LibraryPaletteTab: React.FC<{
  character: Character;
  dirty: boolean;
  patch: (mut: (c: Character) => Character) => void;
  setCharacter: (c: Character) => void;
  setDirty: (v: boolean) => void;
  setSaving: (v: boolean) => void;
  /** Surface a failure in the detail-panel error banner (LibraryView). */
  setError: (msg: string | null) => void;
  /** Re-fetch the sidebar summaries (after an approve persists). */
  refreshList: (selectAfter?: string | null) => Promise<void>;
  paletteTestLine: string;
  setPaletteTestLine: (v: string) => void;
  addingEmotion: boolean;
  setAddingEmotion: (v: boolean) => void;
  newEmotionKey: string;
  setNewEmotionKey: (v: string) => void;
  newEmotionLabel: string;
  setNewEmotionLabel: (v: string) => void;
  newEmotionDirection: string;
  setNewEmotionDirection: (v: string) => void;
  paletteGenError: string | null;
  setPaletteGenError: (msg: string | null) => void;
  /** Disk-scanned takes per emotion (MCP-generated, bypass the job store). */
  paletteDiskTakes: Record<string, PaletteTakeFile[]>;
}> = ({
  character, dirty, patch, setCharacter, setDirty, setSaving, setError, refreshList,
  paletteTestLine, setPaletteTestLine,
  addingEmotion, setAddingEmotion,
  newEmotionKey, setNewEmotionKey,
  newEmotionLabel, setNewEmotionLabel,
  newEmotionDirection, setNewEmotionDirection,
  paletteGenError, setPaletteGenError,
  paletteDiskTakes,
}) => {
  const { jobs, addJob, setQaStatus } = useJobStore();
  const { projectsDir } = useProjectStore();

  const handleAddEmotion = () => {
    const key = newEmotionKey.trim().toLowerCase().replace(/\s+/g, "_");
    if (!key) return;
    const existing = character.voice_assignment.emotional_palette ?? [];
    if (existing.some((e) => e.emotion === key)) {
      setPaletteGenError(`Emotion "${key}" already exists.`);
      return;
    }
    const entry: PaletteEntry = {
      emotion: key,
      label: newEmotionLabel.trim() || key.charAt(0).toUpperCase() + key.slice(1),
      direction: newEmotionDirection.trim(),
      ref_audio_path: null,
      ref_transcript: null,
      qa_status: "unreviewed",
    };
    patch((c) => ({
      ...c,
      voice_assignment: {
        ...c.voice_assignment,
        emotional_palette: [...(c.voice_assignment.emotional_palette ?? []), entry],
      },
    }));
    setNewEmotionKey("");
    setNewEmotionLabel("");
    setNewEmotionDirection("");
    setAddingEmotion(false);
    setPaletteGenError(null);
  };

  const handleGeneratePaletteTake = async (entry: PaletteEntry) => {
    if (!character.library_id || !projectsDir) return;
    if (dirty) {
      setPaletteGenError("Save your changes first — generation uses the saved character state.");
      return;
    }
    const baseDesc = (character.voice_assignment.base_voice_description ?? "").trim();
    if (!baseDesc) {
      setPaletteGenError("Set the base voice description first.");
      return;
    }
    const fullInstruct = entry.direction.trim()
      ? `${baseDesc} ${entry.direction.trim()}`
      : baseDesc;
    setPaletteGenError(null);

    const slug = libraryPaletteSlug(character.library_id, entry.emotion);
    const seed = Math.floor(Math.random() * 9999);
    const ts = Date.now();
    const paletteDir = `${projectsDir}/_library/characters/${character.library_id}/palette`;
    const outputPath = `${paletteDir}/${entry.emotion}_${seed}_${ts}.wav`;

    try {
      const jobId = await submitTtsVoiceDesign({
        projectId: LIBRARY_PROJECT_ID,
        sceneSlug: slug,
        rowIndex: LIBRARY_PALETTE_ROW,
        params: {
          text: paletteTestLine || DEFAULT_TEST_LINE,
          voice_description: fullInstruct,
          language: "en",
          seed,
          temperature: 0.7,
          top_p: 0.9,
          max_new_tokens: 2048,
          output_path: outputPath,
        },
      });
      addJob({
        id: jobId,
        model: "tts",
        description: `Library palette · ${character.name} · ${entry.label}`,
        status: "pending",
        progress: 0,
        eta: "…",
        started_at: new Date().toISOString(),
        scene_id: null,
        scene_slug: slug,
        row_index: LIBRARY_PALETTE_ROW,
        output_path: null,
        peaks: null,
        qa_status: "unreviewed",
        error: null,
      });
    } catch (e) {
      setPaletteGenError(e instanceof Error ? e.message : "Generation failed");
    }
  };

  // Palette tab: per-emotion equivalent of upload-as-source.
  const handleUploadPaletteReference = async (emotion: string) => {
    if (!character.library_id) {
      setPaletteGenError("Save the character first.");
      return;
    }
    const sources = await pickAudioFiles(true);
    if (sources.length === 0) return;
    setPaletteGenError(null);
    setSaving(true);
    try {
      const copied: string[] = [];
      for (const src of sources) {
        const { absolute_path } = await importAudioIntoLibraryBundle({
          libraryId: character.library_id,
          sourcePath: src,
          slot: "palette",
          destName: `${emotion}_upload_${Date.now()}_${copied.length}.wav`,
        });
        copied.push(absolute_path);
      }
      // Add to the entry's sources; promote first new one to gold if no
      // existing gold (mirrors voice-tab semantics).
      const updated: Character = {
        ...character,
        voice_assignment: {
          ...character.voice_assignment,
          emotional_palette: character.voice_assignment.emotional_palette.map((e) =>
            e.emotion === emotion
              ? {
                  ...e,
                  ref_audio_sources: [...(e.ref_audio_sources ?? []), ...copied],
                  ref_audio_path: e.ref_audio_path ?? copied[0] ?? null,
                  qa_status: e.ref_audio_path ? e.qa_status : "approved",
                }
              : e,
          ),
        },
      };
      setCharacter(updated);
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
    } catch (e) {
      setPaletteGenError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSaving(false);
    }
  };

  const handleApprovePaletteTake = async (emotion: string, audioPath: string) => {
    const updated: Character = {
      ...character,
      voice_assignment: {
        ...character.voice_assignment,
        emotional_palette: character.voice_assignment.emotional_palette.map((e) =>
          e.emotion === emotion
            ? { ...e, ref_audio_path: audioPath, qa_status: "approved" as const }
            : e,
        ),
      },
    };
    setCharacter(updated);
    // Persist immediately — approval is a high-value action; don't make the
    // user remember to hit Save afterwards.
    setSaving(true);
    try {
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
      await refreshList(saved.library_id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    {/* Palette */}
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 8 }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>
          Emotional palette · {character.voice_assignment.emotional_palette.length}
        </label>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => {
            setAddingEmotion(true);
            setNewEmotionKey(""); setNewEmotionLabel(""); setNewEmotionDirection("");
            setPaletteGenError(null);
          }}
          style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", padding: "2px 8px" }}
        >+ Add emotion</button>
      </div>

      {/* Test line for take generation */}
      {character.voice_assignment.emotional_palette.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <input
            className="input"
            value={paletteTestLine}
            onChange={(e) => setPaletteTestLine(e.target.value)}
            placeholder="Test line to synthesise for palette takes…"
            style={{ width: "100%", fontSize: 12 }}
          />
        </div>
      )}

      {addingEmotion && (
        <div style={{
          padding: "12px 14px", marginBottom: 10,
          border: "1px solid var(--tts)", borderRadius: "var(--r)",
          background: "color-mix(in oklch, var(--tts) 6%, var(--bg-1))",
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Emotion key (slug)</label>
              <input
                className="input" autoFocus
                value={newEmotionKey}
                onChange={(e) => setNewEmotionKey(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
                placeholder="neutral, sardonic, tense…"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Display label</label>
              <input
                className="input"
                value={newEmotionLabel}
                onChange={(e) => setNewEmotionLabel(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
                placeholder="Defaults to key"
              />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Emotional direction</label>
            <textarea
              className="input"
              value={newEmotionDirection}
              onChange={(e) => setNewEmotionDirection(e.target.value)}
              rows={2}
              style={{ width: "100%", resize: "vertical", fontSize: 12 }}
              placeholder="e.g. Slower, more deliberate. Controlled dread just beneath the surface."
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-sm" onClick={() => setAddingEmotion(false)}>Cancel</button>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleAddEmotion}
              disabled={!newEmotionKey.trim()}
              style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)" }}
            >Add</button>
          </div>
        </div>
      )}

      {paletteGenError && (
        <div style={{ marginBottom: 8, fontSize: 11, color: "var(--sfx)" }}>{paletteGenError}</div>
      )}

      {character.voice_assignment.emotional_palette.length === 0 && !addingEmotion ? (
        <div style={{
          padding: "14px 16px", textAlign: "center",
          border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
          color: "var(--fg-4)", fontSize: 11.5, lineHeight: 1.6,
        }}>
          No palette entries. Click "+ Add emotion" to start.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {character.voice_assignment.emotional_palette.map((entry, idx) => {
            const libraryId = character.library_id;
            const slug = libraryId ? libraryPaletteSlug(libraryId, entry.emotion) : "";
            const entryJobs = libraryId
              ? [...jobs]
                  .filter((j) => j.scene_slug === slug && j.row_index === LIBRARY_PALETTE_ROW && j.status === "complete" && j.output_path)
                  .reverse()
              : [];
            const runningEntry = libraryId && jobs.some(
              (j) => j.scene_slug === slug && (j.status === "running" || j.status === "pending"),
            );
            const jobPaths = new Set(entryJobs.map((j) => j.output_path));
            const diskTakes = (paletteDiskTakes[entry.emotion] ?? []).filter(
              (f) => !jobPaths.has(f.path),
            );
            const diskJobs = diskTakes.map((f) => ({
              id: `disk::${f.path}`,
              model: "tts" as const,
              description: f.path.split("/").pop() ?? "",
              status: "complete" as const,
              progress: 100,
              eta: "",
              started_at: f.sidecar?.generated_at ?? "",
              scene_id: null,
              scene_slug: slug,
              row_index: LIBRARY_PALETTE_ROW,
              output_path: f.path,
              peaks: null,
              qa_status: (f.sidecar?.qa_status ?? "unreviewed") as QaJobStatus,
              error: null,
            }));
            const allTakes = [...entryJobs, ...diskJobs];

            return (
              <PaletteRow
                key={entry.emotion}
                entry={entry}
                allTakes={allTakes}
                running={!!runningEntry}
                canGenerate={!!character.library_id && !!projectsDir}
                onChangeDirection={(direction) =>
                  patch((c) => ({
                    ...c,
                    voice_assignment: {
                      ...c.voice_assignment,
                      emotional_palette: c.voice_assignment.emotional_palette.map((e, i) =>
                        i === idx ? { ...e, direction } : e,
                      ),
                    },
                  }))
                }
                onGenerateTake={() => handleGeneratePaletteTake(entry)}
                onUploadTake={() => handleUploadPaletteReference(entry.emotion)}
                onApprove={(audioPath) => handleApprovePaletteTake(entry.emotion, audioPath)}
                onQa={(jobId, status) => {
                  if (!jobId.startsWith("disk::")) setQaStatus(jobId, status);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
    </>
  );
};

// ── PaletteRow ─────────────────────────────────────────────────────────────

const PaletteRow: React.FC<{
  entry: PaletteEntry;
  allTakes: TakeJob[];
  running: boolean;
  canGenerate: boolean;
  onChangeDirection: (direction: string) => void;
  onGenerateTake: () => void;
  onUploadTake: () => void;
  onApprove: (audioPath: string) => void;
  onQa: (jobId: string, status: QaJobStatus) => void;
}> = ({ entry, allTakes, running, canGenerate, onChangeDirection, onGenerateTake, onUploadTake, onApprove, onQa }) => {
  const [expanded, setExpanded] = useState(false);
  const approved = entry.qa_status === "approved";
  return (
    <div style={{
      border: `1px solid ${approved ? "var(--st-rendered)" : "var(--line-1)"}`,
      borderRadius: "var(--r)",
      background: "var(--bg-1)",
      overflow: "hidden",
    }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px", cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-3)",
        }}>{expanded ? "▾" : "▸"}</span>
        <span style={{ flex: 1, fontSize: 12, color: "var(--fg-1)" }}>
          {entry.label}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)", marginLeft: 6 }}>
            {entry.emotion}
          </span>
        </span>
        {entry.ref_audio_path && (
          <span onClick={(e) => e.stopPropagation()}>
            <PlayButton path={entry.ref_audio_path} size={11} />
          </span>
        )}
        <span style={{
          fontSize: 9.5,
          color: approved ? "var(--st-rendered)" : "var(--fg-4)",
          fontFamily: "var(--font-mono)",
        }}>
          {approved ? "✓ approved" : entry.ref_audio_path ? "○ unreviewed" : "no ref"}
        </span>
      </div>
      {expanded && (
        <div style={{ padding: "10px 14px 12px", borderTop: "1px solid var(--line-1)" }}>
          <label style={labelStyle}>Emotional direction</label>
          <textarea
            className="input"
            value={entry.direction}
            onChange={(e) => onChangeDirection(e.target.value)}
            rows={2}
            style={{ width: "100%", resize: "vertical", fontSize: 12, marginBottom: 10 }}
            placeholder="e.g. Slower, more deliberate. Controlled dread just beneath the surface."
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              onClick={onGenerateTake}
              disabled={running || !canGenerate}
              style={{
                background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)",
                opacity: canGenerate ? 1 : 0.4,
              }}
              title={canGenerate ? "Generate a Voice Design take for this emotion" : "Save the character first"}
            >
              {running ? "Generating…" : "Generate take"}
            </button>
            <button
              className="btn"
              onClick={onUploadTake}
              disabled={running || !canGenerate}
              title="Upload an existing recording (e.g. a voice actor take) as this emotion's reference"
              style={{ opacity: canGenerate ? 1 : 0.4 }}
            >Upload reference…</button>
            {running && <RunningBadge label="Synthesising…" />}
          </div>

          {allTakes.length === 0 && !running && (
            <EmptyTakes label="No takes yet — generate one or upload an existing recording." />
          )}
          {allTakes.length > 0 && (
            <TakeList label={`Takes · ${allTakes.length}`}>
              {allTakes.map((job, i) => (
                <TakeRow
                  key={job.id}
                  job={job}
                  index={i}
                  saveLabel="Approve as reference"
                  isSaved={entry.ref_audio_path === job.output_path && approved}
                  onSave={() => job.output_path && onApprove(job.output_path)}
                  onQa={(s) => onQa(job.id, s)}
                />
              ))}
            </TakeList>
          )}
        </div>
      )}
    </div>
  );
};
