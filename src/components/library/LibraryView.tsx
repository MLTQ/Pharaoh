/**
 * LibraryView.tsx
 *
 * Character Library — project-independent browser/editor for library characters
 * (Pharaoh-z21 + g8z). Library bundles live at
 *   <projects_dir>/_library/characters/<library_id>/
 * and are reusable across episodes via fork-and-pull sync.
 *
 * Supports:
 *   - Browse / create / delete library characters
 *   - Edit metadata: name, description, base voice description
 *   - Add emotions to the palette
 *   - Generate palette take audio directly into the library bundle
 *     (Pharaoh-g8z) using the synthetic projectId="_library" trick — the
 *     existing `<projects_dir>/<project_id>/characters/<character_id>/...`
 *     path math resolves correctly because `_library/characters/<id>/` mirrors
 *     a project bundle's layout.
 *   - Approve takes as the entry's reference audio
 *
 * Out of scope (deferred to a future follow-up):
 *   - Corpus building + RVC model training from inside the library. Both
 *     pipelines are heavier and rarely needed library-side; the recommended
 *     workflow is import-to-project, train, push-back-to-library.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { TakeList, TakeRow, RunningBadge, EmptyTakes } from "../shared/TakeList";
import { CharacterPipeline } from "../characters/CharacterPipeline";
import { CorpusBuilder } from "../characters/CorpusBuilder";
import { RvcModelStage } from "../characters/RvcModelStage";
import {
  listLibraryCharacters,
  getLibraryCharacter,
  saveLibraryCharacter,
  deleteLibraryCharacter,
  listPaletteTakes,
  submitTtsVoiceDesign,
} from "../../lib/tauriCommands";
import type { PaletteTakeFile } from "../../lib/tauriCommands";
import { useJobStore } from "../../store/jobStore";
import { useProjectStore } from "../../store/projectStore";
import type {
  Character,
  LibraryCharacterSummary,
  PaletteEntry,
  QaJobStatus,
  VoicePipelineStage,
} from "../../lib/types";

// Synthetic "project id" used at every backend path-resolution site so the
// existing tts/sidecar/corpus commands route to <projects_dir>/_library/
// instead of an actual project dir. Matches the library bundle layout.
const LIBRARY_PROJECT_ID = "_library";
const LIBRARY_PALETTE_ROW = 0;
const LIBRARY_DESIGN_ROW = 0;
const DEFAULT_TEST_LINE = "And then she said — nothing at all.";

function libraryPaletteSlug(libraryId: string, emotion: string): string {
  return `__library_palette__${libraryId}__${emotion}`;
}

function libraryDesignSlug(libraryId: string): string {
  return `__library_design__${libraryId}`;
}

type LibraryTab = "voice" | "palette" | "corpus" | "model";

function tabToStage(t: LibraryTab): VoicePipelineStage {
  if (t === "palette") return 2;
  if (t === "corpus") return 3;
  if (t === "model") return 4;
  return 1;
}

function stageToTab(s: VoicePipelineStage): LibraryTab {
  if (s === 2) return "palette";
  if (s === 3) return "corpus";
  if (s === 4) return "model";
  return "voice";
}

// ── Helpers ────────────────────────────────────────────────────────────────

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

function emptyCharacter(): Character {
  return {
    id: "LIB_NEW",
    name: "New character",
    description: "",
    voice_assignment: {
      model: "VoiceDesign",
      speaker: null,
      instruct_default: "",
      ref_audio_path: null,
      ref_transcript: null,
      base_voice_description: "",
      emotional_palette: [],
      production_pipeline: "chatterbox",
    },
    schema_version: 2,
    library_id: null,
    library_version: null,
  };
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const m = 60_000, h = 60 * m, d = 24 * h;
  if (diff < m) return "just now";
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 30 * d) return `${Math.floor(diff / d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Component ──────────────────────────────────────────────────────────────

export const LibraryView: React.FC = () => {
  const [summaries, setSummaries] = useState<LibraryCharacterSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Tab state — full 4-stage pipeline (Pharaoh-37l)
  const [tab, setTab] = useState<LibraryTab>("voice");

  // Voice Design generation state
  const [voiceDesignTestLine, setVoiceDesignTestLine] = useState(DEFAULT_TEST_LINE);
  const [generatingDesign, setGeneratingDesign] = useState(false);
  const [designGenError, setDesignGenError] = useState<string | null>(null);

  // Palette take generation state (Pharaoh-g8z)
  const [paletteTestLine, setPaletteTestLine] = useState(DEFAULT_TEST_LINE);
  const [addingEmotion, setAddingEmotion] = useState(false);
  const [newEmotionKey, setNewEmotionKey] = useState("");
  const [newEmotionLabel, setNewEmotionLabel] = useState("");
  const [newEmotionDirection, setNewEmotionDirection] = useState("");
  const [paletteGenError, setPaletteGenError] = useState<string | null>(null);
  const [paletteDiskTakes, setPaletteDiskTakes] = useState<Record<string, PaletteTakeFile[]>>({});

  const { jobs, addJob, setQaStatus } = useJobStore();
  const { projectsDir } = useProjectStore();

  // ── Load list ──
  const refreshList = async (selectAfter?: string | null) => {
    setLoading(true);
    try {
      const rows = await listLibraryCharacters();
      setSummaries(rows);
      if (selectAfter !== undefined) setSelectedId(selectAfter);
      else if (!rows.find((r) => r.library_id === selectedId)) {
        setSelectedId(rows[0]?.library_id ?? null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to list library");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load detail when selection changes ──
  useEffect(() => {
    if (!selectedId) {
      setCharacter(null);
      setDirty(false);
      return;
    }
    let cancelled = false;
    getLibraryCharacter(selectedId)
      .then((c) => {
        if (!cancelled) {
          setCharacter(c);
          setDirty(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load character");
          setCharacter(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // ── Mutations ──
  const patch = (mut: (c: Character) => Character) => {
    if (!character) return;
    setCharacter(mut(character));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!character) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveLibraryCharacter(character);
      setCharacter(saved);
      setDirty(false);
      await refreshList(saved.library_id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (dirty && !window.confirm("Discard unsaved changes to the current character?")) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveLibraryCharacter(emptyCharacter());
      setCharacter(saved);
      setDirty(false);
      await refreshList(saved.library_id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!character?.library_id) return;
    const name = character.name || "this character";
    if (!window.confirm(`Delete "${name}" from the library? Project characters that were imported from this entry will become detached (their import is unaffected).`)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteLibraryCharacter(character.library_id);
      await refreshList(null);
      setCharacter(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  // ── Palette take generation (Pharaoh-g8z) ──

  // Refresh disk-scanned palette takes for every emotion whenever the active
  // character changes. listPaletteTakes hits the library bundle dir directly
  // because the path math (<projects_dir>/<project_id>/characters/<id>/palette)
  // matches the library layout when project_id == "_library".
  useEffect(() => {
    if (!character?.library_id) {
      setPaletteDiskTakes({});
      return;
    }
    const entries = character.voice_assignment.emotional_palette ?? [];
    Promise.all(
      entries.map((e) =>
        listPaletteTakes({
          projectId: LIBRARY_PROJECT_ID,
          characterId: character.library_id!,
          emotion: e.emotion,
        })
          .then((files) => ({ emotion: e.emotion, files }))
          .catch(() => ({ emotion: e.emotion, files: [] as PaletteTakeFile[] }))
      )
    ).then((results) => {
      const map: Record<string, PaletteTakeFile[]> = {};
      for (const { emotion, files } of results) map[emotion] = files;
      setPaletteDiskTakes(map);
    });
  }, [character?.library_id, character?.voice_assignment.emotional_palette.length]);

  const handleAddEmotion = () => {
    if (!character) return;
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
    if (!character?.library_id || !projectsDir) return;
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

  // ── Voice Design generation (moved from CharacterDesignerView, library-scoped) ──

  const handleGenerateDesign = async () => {
    if (!character?.library_id || !projectsDir) return;
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

  const handleSaveDesignAsReference = async (audioPath: string) => {
    if (!character) return;
    const transcript = (voiceDesignTestLine || DEFAULT_TEST_LINE).trim();
    const updated: Character = {
      ...character,
      voice_assignment: {
        ...character.voice_assignment,
        ref_audio_path: audioPath,
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

  const handleApprovePaletteTake = async (emotion: string, audioPath: string) => {
    if (!character) return;
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

  // ── Render ──
  const selectedSummary = useMemo(
    () => summaries.find((s) => s.library_id === selectedId) ?? null,
    [summaries, selectedId],
  );

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── List sidebar ─────────────────────────────────────────────── */}
      <div style={{
        width: 240, flexShrink: 0,
        borderRight: "1px solid var(--line-1)",
        background: "var(--bg-1)", overflowY: "auto",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "10px 12px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Library · {summaries.length}
          </span>
          <button
            className="btn btn-sm btn-primary"
            style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", padding: "2px 8px" }}
            onClick={handleCreate}
            disabled={saving}
            title="New library character"
          >+ New</button>
        </div>

        {loading && summaries.length === 0 && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--fg-4)" }}>Loading…</div>
        )}
        {!loading && summaries.length === 0 && (
          <div style={{ padding: "20px 14px", fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6 }}>
            No library characters yet. Create one with the + button, or use
            "Save to library" from any character in a project.
          </div>
        )}

        {summaries.map((s) => {
          const active = s.library_id === selectedId;
          const hue = CHAR_HUE(s.library_id);
          return (
            <div
              key={s.library_id}
              className={`side-item ${active ? "active" : ""}`}
              onClick={() => {
                if (dirty && !active && !window.confirm("Discard unsaved changes?")) return;
                setSelectedId(s.library_id);
              }}
              style={{ paddingTop: 8, paddingBottom: 8, cursor: "pointer" }}
            >
              <span className="ico">
                <span style={{
                  display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                  background: `oklch(0.7 0.12 ${hue})`,
                  border: "1px solid var(--line-2)",
                }} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: "block", fontSize: 12, fontWeight: active ? 500 : 400,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{s.name}</span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
                  letterSpacing: "0.04em",
                }}>
                  {s.palette_count} palette{s.has_rvc_model ? " · rvc" : ""}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Detail panel ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {!character ? (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 10, color: "var(--fg-4)",
          }}>
            <span style={{ fontSize: 28, opacity: 0.25 }}>◎</span>
            <span style={{ fontSize: 12 }}>
              {summaries.length === 0
                ? "No characters in the library yet"
                : "Select a character to edit"}
            </span>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--line-1)",
              background: "var(--bg-1)", flexShrink: 0,
              display: "flex", alignItems: "center", gap: 12,
            }}>
              <span style={{
                width: 14, height: 14, borderRadius: "50%",
                background: character.library_id
                  ? `oklch(0.7 0.12 ${CHAR_HUE(character.library_id)})`
                  : "var(--fg-4)",
                flexShrink: 0,
              }} />
              <input
                className="input"
                value={character.name}
                onChange={(e) => patch((c) => ({ ...c, name: e.target.value }))}
                style={{
                  background: "transparent", border: "none", padding: 0,
                  fontSize: 20, fontWeight: 600, color: "var(--fg-1)", flex: 1,
                }}
              />
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
                color: "var(--tts)", textTransform: "uppercase",
                background: "color-mix(in oklch, var(--tts) 12%, var(--bg-2))",
                padding: "2px 6px", borderRadius: 3, flexShrink: 0,
              }}>Library</span>
              <button
                className="btn btn-sm btn-primary"
                style={{
                  background: dirty ? "var(--tts)" : "var(--bg-2)",
                  borderColor: dirty ? "var(--tts)" : "var(--line-2)",
                  color: dirty ? "var(--bg-1)" : "var(--fg-3)",
                  opacity: saving ? 0.5 : 1,
                }}
                onClick={handleSave}
                disabled={!dirty || saving}
              >
                {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
              </button>
              {character.library_id && (
                <button
                  className="btn btn-sm"
                  style={{
                    color: "var(--sfx)",
                    borderColor: "color-mix(in oklch, var(--sfx) 45%, var(--line-1))",
                    background: "color-mix(in oklch, var(--sfx) 8%, transparent)",
                  }}
                  onClick={handleDelete}
                  disabled={saving}
                >Delete</button>
              )}
            </div>

            {error && (
              <div style={{
                padding: "8px 20px", fontSize: 11,
                background: "color-mix(in oklch, var(--sfx) 8%, var(--bg-1))",
                color: "var(--sfx)", borderBottom: "1px solid var(--line-1)",
              }}>
                {error}
              </div>
            )}

            {/* Pipeline stage header — Pharaoh-37l */}
            {(() => {
              const approvedPalette = (character.voice_assignment.emotional_palette ?? [])
                .filter((e) => e.qa_status === "approved");
              const stage1Done = (character.voice_assignment.base_voice_description ?? "").trim().length > 0;
              const stage2Done = approvedPalette.length >= 2;
              const corpusCount = character.voice_assignment.rvc?.corpus_count ?? 0;
              const corpusDurationMs = character.voice_assignment.rvc?.corpus_duration_ms ?? 0;
              const corpusTarget = 50;
              const modelTrained = (character.voice_assignment.rvc?.model_path ?? null) !== null;
              const rvcEnabled = character.voice_assignment.rvc?.enabled ?? false;
              const rvcPipelineActive = character.voice_assignment.production_pipeline === "chatterbox+rvc";
              return (
                <CharacterPipeline
                  stage1Done={stage1Done}
                  stage2Done={stage2Done}
                  corpusCount={corpusCount}
                  corpusTarget={corpusTarget}
                  corpusDurationMs={corpusDurationMs}
                  modelTrained={modelTrained}
                  rvcEnabled={rvcEnabled}
                  rvcPipelineActive={rvcPipelineActive}
                  onToggleRvcPipeline={(active) => {
                    const next = active ? "chatterbox+rvc" : "chatterbox";
                    const rvc = character.voice_assignment.rvc
                      ? { ...character.voice_assignment.rvc, enabled: active }
                      : (active ? { model_path: null, index_path: null, pitch_shift: 0, index_rate: 0.5, protect: 0.33, enabled: true, corpus_count: 0, corpus_duration_ms: 0 } : null);
                    patch((c) => ({
                      ...c,
                      voice_assignment: { ...c.voice_assignment, production_pipeline: next, rvc },
                    }));
                    if (!active && (tab === "corpus" || tab === "model")) {
                      setTab("palette");
                    }
                  }}
                  activeStage={tabToStage(tab)}
                  onSelectStage={(s) => setTab(stageToTab(s))}
                />
              );
            })()}

            {/* Body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>

            {/* ── VOICE tab ────────────────────────────────────────────── */}
            {tab === "voice" && (
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

              {/* Reference audio (single-ref fallback) */}
              <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--line-1)" }}>
                <label style={labelStyle}>Character reference audio</label>
                <p style={{ fontSize: 10.5, color: "var(--fg-4)", marginBottom: 10, lineHeight: 1.6 }}>
                  Single-ref fallback used when no palette is approved. Approved Voice Design takes save here automatically.
                </p>
                {character.voice_assignment.ref_audio_path ? (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", marginBottom: 10,
                    background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
                    borderRadius: "var(--r)", border: "1px solid var(--line-2)",
                  }}>
                    <PlayButton path={character.voice_assignment.ref_audio_path} size={12} />
                    <Wave width={90} height={16} seed={(character.library_id ?? "x").charCodeAt(0)} count={26} color="var(--tts)" opacity={0.7} />
                    <span style={{
                      flex: 1, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-3)", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {character.voice_assignment.ref_audio_path.split("/").pop()}
                    </span>
                    <button
                      className="btn btn-sm"
                      style={{ color: "var(--sfx)" }}
                      onClick={() => patch((c) => ({
                        ...c,
                        voice_assignment: { ...c.voice_assignment, ref_audio_path: null },
                      }))}
                    >clear</button>
                  </div>
                ) : (
                  <div style={{
                    padding: "10px 12px", marginBottom: 10,
                    border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                    color: "var(--fg-4)", fontSize: 11, lineHeight: 1.6,
                  }}>
                    No reference audio yet. Generate one above, or import a take from another tool.
                  </div>
                )}

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
            )}

            {/* ── PALETTE tab ──────────────────────────────────────────── */}
            {tab === "palette" && (
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
            )}

            {/* ── CORPUS tab (Pharaoh-37l) ─────────────────────────────── */}
            {tab === "corpus" && character.library_id && projectsDir && (
              <CorpusBuilder
                projectId={LIBRARY_PROJECT_ID}
                character={character}
                projectsDir={projectsDir}
                corpusCount={character.voice_assignment.rvc?.corpus_count ?? 0}
                corpusDurationMs={character.voice_assignment.rvc?.corpus_duration_ms ?? 0}
                corpusTarget={50}
                onCorpusUpdated={() => {
                  // CorpusBuilder polls its own status internally; nothing
                  // to refresh in our local state.
                }}
              />
            )}

            {/* ── MODEL tab (Pharaoh-37l) ──────────────────────────────── */}
            {tab === "model" && character.library_id && projectsDir && (
              <RvcModelStage
                projectId={LIBRARY_PROJECT_ID}
                character={character}
                projectsDir={projectsDir}
                corpusReady={(character.voice_assignment.rvc?.corpus_duration_ms ?? 0) >= 5 * 60 * 1000}
                onModelTrained={() => {
                  // Re-fetch the library character so the trained model path
                  // appears immediately (RvcModelStage finishes training but
                  // doesn't mutate our local state).
                  if (selectedId) {
                    getLibraryCharacter(selectedId).then(setCharacter).catch(() => {});
                  }
                }}
              />
            )}

            {/* Meta footer */}
              {selectedSummary && (
                <div style={{
                  marginTop: 24, paddingTop: 12,
                  borderTop: "1px solid var(--line-1)",
                  fontSize: 10.5, color: "var(--fg-4)", fontFamily: "var(--font-mono)",
                  display: "flex", gap: 16, flexWrap: "wrap",
                }}>
                  <span>library_id: {character.library_id?.slice(0, 8) ?? "—"}</span>
                  <span>updated: {formatRelative(character.library_version ?? selectedSummary.library_version)}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ── PaletteRow ─────────────────────────────────────────────────────────────

// Job-shaped object accepted by TakeList — includes job-store jobs and synthesized
// "disk job" rows for MCP-generated takes that bypass the in-memory queue.
type TakeJob = Parameters<typeof TakeRow>[0]["job"];

const PaletteRow: React.FC<{
  entry: PaletteEntry;
  allTakes: TakeJob[];
  running: boolean;
  canGenerate: boolean;
  onChangeDirection: (direction: string) => void;
  onGenerateTake: () => void;
  onApprove: (audioPath: string) => void;
  onQa: (jobId: string, status: QaJobStatus) => void;
}> = ({ entry, allTakes, running, canGenerate, onChangeDirection, onGenerateTake, onApprove, onQa }) => {
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

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
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
            {running && <RunningBadge label="Synthesising…" />}
          </div>

          {allTakes.length === 0 && !running && (
            <EmptyTakes label="No takes yet — click Generate take." />
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

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
