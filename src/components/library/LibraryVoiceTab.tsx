/**
 * LibraryVoiceTab.tsx
 *
 * Stage-1 "Voice" tab of the library character editor: description + base
 * voice description metadata, Voice Design take generation, the character
 * reference-audio sources list with gold pick / concat (Pharaoh-0b3l),
 * reference transcript, and voice instructions.
 *
 * Owns the voice-tab action handlers (generate design take, upload / concat /
 * pick-gold / remove reference sources, save design take as reference).
 * Persistent UI state (test line, generating flag, inline error) lives in
 * LibraryView and arrives via props so it survives tab switches.
 */

import React from "react";
import { TakeList, TakeRow, RunningBadge, EmptyTakes } from "../shared/TakeList";
import {
  saveLibraryCharacter,
  submitTtsVoiceDesign,
  importAudioIntoLibraryBundle,
  concatAudioIntoLibraryBundle,
} from "../../lib/tauriCommands";
import { useJobStore } from "../../store/jobStore";
import { useProjectStore } from "../../store/projectStore";
import type { Character } from "../../lib/types";
import {
  LIBRARY_PROJECT_ID,
  LIBRARY_DESIGN_ROW,
  DEFAULT_TEST_LINE,
  libraryDesignSlug,
  labelStyle,
  pickAudioFiles,
} from "./libraryShared";
import { SourceRow } from "./SourceRow";

export const LibraryVoiceTab: React.FC<{
  character: Character;
  dirty: boolean;
  saving: boolean;
  patch: (mut: (c: Character) => Character) => void;
  setCharacter: (c: Character) => void;
  setDirty: (v: boolean) => void;
  setSaving: (v: boolean) => void;
  /** Surface a failure in the detail-panel error banner (LibraryView). */
  setError: (msg: string | null) => void;
  voiceDesignTestLine: string;
  setVoiceDesignTestLine: (v: string) => void;
  generatingDesign: boolean;
  setGeneratingDesign: (v: boolean) => void;
  designGenError: string | null;
  setDesignGenError: (msg: string | null) => void;
}> = ({
  character, dirty, saving, patch, setCharacter, setDirty, setSaving, setError,
  voiceDesignTestLine, setVoiceDesignTestLine,
  generatingDesign, setGeneratingDesign,
  designGenError, setDesignGenError,
}) => {
  const { jobs, addJob, setQaStatus } = useJobStore();
  const { projectsDir } = useProjectStore();

  // ── Voice Design generation (moved from CharacterDesignerView, library-scoped) ──

  const handleGenerateDesign = async () => {
    if (!character.library_id || !projectsDir) return;
    if (dirty) {
      setDesignGenError("Save your changes first — generation uses the saved character state.");
      return;
    }
    const desc = character.voice_assignment.base_voice_description?.trim() ?? "";
    if (!desc) {
      setDesignGenError("Add a base voice description first.");
      return;
    }
    setGeneratingDesign(true);
    setDesignGenError(null);

    const slug = libraryDesignSlug(character.library_id);
    const ts = Date.now();
    const designDir = `${projectsDir}/_library/characters/${character.library_id}/design`;
    const outputPath = `${designDir}/voice_${ts}.wav`;

    try {
      const jobId = await submitTtsVoiceDesign({
        projectId: LIBRARY_PROJECT_ID,
        sceneSlug: slug,
        rowIndex: LIBRARY_DESIGN_ROW,
        params: {
          text: voiceDesignTestLine || DEFAULT_TEST_LINE,
          voice_description: desc,
          language: "en",
          seed: Math.floor(Math.random() * 9999),
          temperature: 0.7,
          top_p: 0.9,
          max_new_tokens: 2048,
          output_path: outputPath,
        },
      });
      addJob({
        id: jobId,
        model: "tts",
        description: `Library voice design · ${character.name}`,
        status: "pending",
        progress: 0,
        eta: "…",
        started_at: new Date().toISOString(),
        scene_id: null,
        scene_slug: slug,
        row_index: LIBRARY_DESIGN_ROW,
        output_path: null,
        peaks: null,
        qa_status: "unreviewed",
        error: null,
      });
    } catch (e) {
      setDesignGenError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGeneratingDesign(false);
    }
  };

  // Voice tab: upload audio file(s) as candidate character voice references.
  // Each picked file is copied individually into the bundle as its own source.
  // If no gold is currently set, the first new upload becomes the gold;
  // otherwise the existing gold is preserved and the user picks via the list.
  const handleUploadCharacterReference = async () => {
    if (!character.library_id) {
      setDesignGenError("Save the character first.");
      return;
    }
    const sources = await pickAudioFiles(true);
    if (sources.length === 0) return;
    setDesignGenError(null);
    setSaving(true);
    try {
      // Copy each file individually so users can see + pick.
      const copied: string[] = [];
      for (const src of sources) {
        const { absolute_path } = await importAudioIntoLibraryBundle({
          libraryId: character.library_id,
          sourcePath: src,
          slot: "design",
          destName: "", // backend timestamps + preserves extension
        });
        copied.push(absolute_path);
      }
      const existingSources = character.voice_assignment.ref_audio_sources ?? [];
      const nextSources = [...existingSources, ...copied];
      const nextGold = character.voice_assignment.ref_audio_path ?? copied[0] ?? null;
      const updated: Character = {
        ...character,
        voice_assignment: {
          ...character.voice_assignment,
          ref_audio_sources: nextSources,
          ref_audio_path: nextGold,
        },
      };
      setCharacter(updated);
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
    } catch (e) {
      setDesignGenError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSaving(false);
    }
  };

  // Voice tab: concatenate all current sources into a single derived WAV and
  // set it as the gold. The individual sources stay in the list.
  const handleConcatCharacterSources = async () => {
    if (!character.library_id) return;
    const sources = character.voice_assignment.ref_audio_sources ?? [];
    if (sources.length < 2) return;
    setDesignGenError(null);
    setSaving(true);
    try {
      const { absolute_path } = await concatAudioIntoLibraryBundle({
        libraryId: character.library_id,
        sourcePaths: sources,
        slot: "design",
        destName: `concat_${Date.now()}.wav`,
      });
      const updated: Character = {
        ...character,
        voice_assignment: {
          ...character.voice_assignment,
          ref_audio_path: absolute_path,
        },
      };
      setCharacter(updated);
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
    } catch (e) {
      setDesignGenError(e instanceof Error ? e.message : "Concat failed");
    } finally {
      setSaving(false);
    }
  };

  // Voice tab: pick which source is the active gold for cloning.
  const handlePickCharacterGold = async (audioPath: string) => {
    const updated: Character = {
      ...character,
      voice_assignment: {
        ...character.voice_assignment,
        ref_audio_path: audioPath,
      },
    };
    setCharacter(updated);
    setSaving(true);
    try {
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
    } catch (e) {
      setDesignGenError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Voice tab: remove a source from the list. If it was the gold, the next
  // remaining source (or null) becomes the new gold.
  const handleRemoveCharacterSource = async (audioPath: string) => {
    const sources = (character.voice_assignment.ref_audio_sources ?? []).filter((p) => p !== audioPath);
    const nextGold =
      character.voice_assignment.ref_audio_path === audioPath
        ? (sources[0] ?? null)
        : character.voice_assignment.ref_audio_path;
    const updated: Character = {
      ...character,
      voice_assignment: {
        ...character.voice_assignment,
        ref_audio_sources: sources,
        ref_audio_path: nextGold,
      },
    };
    setCharacter(updated);
    setSaving(true);
    try {
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
    } catch (e) {
      setDesignGenError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDesignAsReference = async (audioPath: string) => {
    const transcript = (voiceDesignTestLine || DEFAULT_TEST_LINE).trim();
    // Add to the sources list (dedup) and set as gold so it shows up alongside
    // uploaded files in the Character reference audio section.
    const existingSources = character.voice_assignment.ref_audio_sources ?? [];
    const nextSources = existingSources.includes(audioPath)
      ? existingSources
      : [...existingSources, audioPath];
    const updated: Character = {
      ...character,
      voice_assignment: {
        ...character.voice_assignment,
        ref_audio_path: audioPath,
        ref_audio_sources: nextSources,
        ref_transcript: transcript,
      },
    };
    setCharacter(updated);
    setSaving(true);
    try {
      const saved = await saveLibraryCharacter(updated);
      setCharacter(saved);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    {/* Metadata row */}
    <div style={{ marginBottom: 18 }}>
      <label style={labelStyle}>Description</label>
      <textarea
        className="input"
        value={character.description}
        onChange={(e) => patch((c) => ({ ...c, description: e.target.value }))}
        rows={2}
        style={{ width: "100%", resize: "vertical", fontSize: 12 }}
        placeholder="Character notes — age, role, personality, vocal direction…"
      />
    </div>

    <div style={{ marginBottom: 18 }}>
      <label style={labelStyle}>Base voice description</label>
      <textarea
        className="input"
        value={character.voice_assignment.base_voice_description}
        onChange={(e) =>
          patch((c) => ({
            ...c,
            voice_assignment: {
              ...c.voice_assignment,
              base_voice_description: e.target.value,
            },
          }))
        }
        rows={3}
        style={{ width: "100%", resize: "vertical", fontSize: 12 }}
        placeholder="e.g. Burnished alto, mid-40s American, slight vocal roughness. Controlled, forensic cadence."
      />
      <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 3 }}>
        The vocal identity shared across all palette takes.
      </div>
    </div>

    {/* Voice Design generation */}
    <div style={{ marginBottom: 18 }}>
      <label style={labelStyle}>Test line</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          value={voiceDesignTestLine}
          onChange={(e) => setVoiceDesignTestLine(e.target.value)}
          style={{ flex: 1, fontSize: 12 }}
          placeholder="Line to synthesize…"
        />
        <button
          className="btn btn-primary"
          onClick={handleGenerateDesign}
          disabled={generatingDesign || !character.library_id}
          style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", flexShrink: 0 }}
        >
          {generatingDesign ? "Generating…" : "Generate"}
        </button>
      </div>
      {designGenError && (
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--sfx)" }}>{designGenError}</div>
      )}
    </div>

    {(() => {
      if (!character.library_id) return null;
      const slug = libraryDesignSlug(character.library_id);
      const designJobs = [...jobs]
        .filter((j) => j.scene_slug === slug && j.row_index === LIBRARY_DESIGN_ROW && j.status === "complete" && j.output_path)
        .reverse();
      const runningDesign = jobs.some((j) => j.scene_slug === slug && (j.status === "running" || j.status === "pending"));
      return (
        <>
          {runningDesign && <RunningBadge label="Synthesising voice…" />}
          {designJobs.length === 0 && !runningDesign && (
            <EmptyTakes label="No takes yet — write a description and generate above." />
          )}
          {designJobs.length > 0 && (
            <TakeList label={`Design takes · ${designJobs.length}`}>
              {designJobs.map((job, i) => (
                <TakeRow
                  key={job.id} job={job} index={i}
                  saveLabel="Save as character voice"
                  isSaved={character.voice_assignment.ref_audio_path === job.output_path}
                  onSave={() => job.output_path && handleSaveDesignAsReference(job.output_path)}
                  onQa={(s) => setQaStatus(job.id, s)}
                />
              ))}
            </TakeList>
          )}
        </>
      );
    })()}

    {/* Reference audio — sources list with gold pick (Pharaoh-0b3l) */}
    <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>
          Character reference audio
          {(() => {
            const n = (character.voice_assignment.ref_audio_sources ?? []).length;
            return n > 0 ? ` · ${n}` : "";
          })()}
        </label>
        <button
          className="btn btn-sm"
          onClick={handleUploadCharacterReference}
          disabled={!character.library_id || saving}
          title="Pick one or more audio files — each becomes a candidate reference. Use the radio dot to choose the gold."
        >+ Upload…</button>
      </div>
      <p style={{ fontSize: 10.5, color: "var(--fg-4)", marginBottom: 10, lineHeight: 1.6 }}>
        Multiple uploads are kept as separate candidates. The dot picks the "gold" — the single file Chatterbox uses for 0-shot cloning. Approved Voice Design takes are also added here.
      </p>

      {(() => {
        const sources = character.voice_assignment.ref_audio_sources ?? [];
        const gold = character.voice_assignment.ref_audio_path;
        const goldOutsideSources = gold != null && !sources.includes(gold);
        if (sources.length === 0 && !gold) {
          return (
            <div style={{
              padding: "10px 12px", marginBottom: 10,
              border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
              color: "var(--fg-4)", fontSize: 11, lineHeight: 1.6,
            }}>
              No reference audio yet. Generate one with Voice Design above, or upload existing recordings with + Upload…
            </div>
          );
        }
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {goldOutsideSources && gold && (
              <SourceRow
                path={gold}
                isGold={true}
                derivedConcat={true}
                onPickGold={() => {}}
                onRemove={() => handlePickCharacterGold(sources[0] ?? "")}
                disabled={saving}
              />
            )}
            {sources.map((src) => (
              <SourceRow
                key={src}
                path={src}
                isGold={src === gold}
                derivedConcat={false}
                onPickGold={() => handlePickCharacterGold(src)}
                onRemove={() => handleRemoveCharacterSource(src)}
                disabled={saving}
              />
            ))}
            {sources.length >= 2 && (
              <button
                className="btn btn-sm"
                onClick={handleConcatCharacterSources}
                disabled={saving}
                title="Concatenate all sources into one longer derived WAV and use that as the gold. Useful when you want a richer speaker embedding from multiple takes."
                style={{ alignSelf: "flex-start", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 10 }}
              >Concatenate all → gold</button>
            )}
          </div>
        );
      })()}

      <label style={labelStyle}>
        Reference transcript{" "}
        <span style={{ color: "var(--fg-4)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          — optional, helps ICL mode
        </span>
      </label>
      <input
        className="input"
        value={character.voice_assignment.ref_transcript ?? ""}
        onChange={(e) => patch((c) => ({
          ...c,
          voice_assignment: { ...c.voice_assignment, ref_transcript: e.target.value },
        }))}
        style={{ width: "100%", fontSize: 12, marginBottom: 12 }}
        placeholder="What is spoken in the reference audio…"
      />

      <label style={labelStyle}>Voice instructions</label>
      <textarea
        className="input"
        value={character.voice_assignment.instruct_default ?? ""}
        onChange={(e) => patch((c) => ({
          ...c,
          voice_assignment: { ...c.voice_assignment, instruct_default: e.target.value },
        }))}
        rows={2}
        style={{ width: "100%", resize: "vertical", fontSize: 12 }}
        placeholder="Directorial notes pre-filled in the TTS panel for every line…"
      />
    </div>
    </>
  );
};
