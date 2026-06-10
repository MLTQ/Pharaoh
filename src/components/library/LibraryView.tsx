/**
 * LibraryView.tsx
 *
 * Character Library — project-independent browser/editor for library characters
 * (Pharaoh-z21 + g8z). Library bundles live at
 *   <projects_dir>/_library/characters/<library_id>/
 * and are reusable across episodes via fork-and-pull sync.
 *
 * Entry point + composition root. Owns all top-level state (summaries,
 * selection, character, dirty/saving, per-tab persistent UI state) and the
 * list/save/create/export/import/delete flows, and composes the extracted
 * pieces:
 *   - LibrarySidebar      — character list + Import… / + New
 *   - LibraryDetailHeader — name editor, Save, +corpus, Export…, Delete
 *   - LibraryVoiceTab     — stage 1: voice design + reference sources
 *   - LibraryPaletteTab   — stage 2: emotional palette + takes
 *   - CorpusBuilder / RvcModelStage — stages 3-4 (shared with project view)
 *
 * Palette take audio generates directly into the library bundle
 * (Pharaoh-g8z) using the synthetic projectId="_library" trick — the
 * existing `<projects_dir>/<project_id>/characters/<character_id>/...`
 * path math resolves correctly because `_library/characters/<id>/` mirrors
 * a project bundle's layout.
 */

import React, { useEffect, useMemo, useState } from "react";
import { CharacterPipeline } from "../characters/CharacterPipeline";
import { CorpusBuilder } from "../characters/CorpusBuilder";
import { RvcModelStage } from "../characters/RvcModelStage";
import {
  listLibraryCharacters,
  getLibraryCharacter,
  saveLibraryCharacter,
  deleteLibraryCharacter,
  listPaletteTakes,
  exportLibraryCharacter,
  importLibraryCharacterFromFile,
} from "../../lib/tauriCommands";
import type { PaletteTakeFile } from "../../lib/tauriCommands";
import { useProjectStore } from "../../store/projectStore";
import { reportError } from "../../lib/errors";
import type { Character, LibraryCharacterSummary } from "../../lib/types";
import {
  LIBRARY_PROJECT_ID,
  DEFAULT_TEST_LINE,
  emptyCharacter,
  formatRelative,
  tabToStage,
  stageToTab,
} from "./libraryShared";
import type { LibraryTab } from "./libraryShared";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryDetailHeader } from "./LibraryDetailHeader";
import { LibraryVoiceTab } from "./LibraryVoiceTab";
import { LibraryPaletteTab } from "./LibraryPaletteTab";

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

  // Voice Design generation state — lives here (not in LibraryVoiceTab) so
  // it survives tab switches; the tab components unmount when inactive.
  const [voiceDesignTestLine, setVoiceDesignTestLine] = useState(DEFAULT_TEST_LINE);
  const [generatingDesign, setGeneratingDesign] = useState(false);
  const [designGenError, setDesignGenError] = useState<string | null>(null);

  // Palette take generation state (Pharaoh-g8z) — same tab-survival rationale.
  const [paletteTestLine, setPaletteTestLine] = useState(DEFAULT_TEST_LINE);
  const [addingEmotion, setAddingEmotion] = useState(false);
  const [newEmotionKey, setNewEmotionKey] = useState("");
  const [newEmotionLabel, setNewEmotionLabel] = useState("");
  const [newEmotionDirection, setNewEmotionDirection] = useState("");
  const [paletteGenError, setPaletteGenError] = useState<string | null>(null);
  const [paletteDiskTakes, setPaletteDiskTakes] = useState<Record<string, PaletteTakeFile[]>>({});

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

  // ── Export / Import to file (Pharaoh-tlt4) ──

  const [exporting, setExporting] = useState(false);
  const [importing, setImportingFile] = useState(false);
  const [includeCorpusInExport, setIncludeCorpusInExport] = useState(false);

  const handleExport = async () => {
    if (!character?.library_id) return;
    setExporting(true);
    setError(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const safeName = character.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "character";
      const defaultPath = `${safeName}.pharaoh-character`;
      const target = await save({
        title: "Export character",
        defaultPath,
        filters: [{ name: "Pharaoh character", extensions: ["pharaoh-character"] }],
      });
      if (!target) {
        setExporting(false);
        return;
      }
      const result = await exportLibraryCharacter({
        libraryId: character.library_id,
        outputPath: typeof target === "string" ? target : (target as { path: string }).path,
        includeCorpus: includeCorpusInExport,
      });
      // Cheap success toast via the existing error/banner channel — paint it
      // green by clearing error and surfacing a transient note instead.
      window.alert(`Exported "${character.name}" → ${result.output_path}\n${result.file_count} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async () => {
    setImportingFile(true);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "Import character file",
        multiple: false,
        filters: [{ name: "Pharaoh character", extensions: ["pharaoh-character", "zip"] }],
      });
      if (!picked) {
        setImportingFile(false);
        return;
      }
      const filePath = typeof picked === "string" ? picked : (picked as { path: string }).path;
      const summary = await importLibraryCharacterFromFile(filePath);
      await refreshList(summary.library_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImportingFile(false);
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

  // ── Palette disk takes (Pharaoh-g8z) ──

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

  // ── Render ──
  const selectedSummary = useMemo(
    () => summaries.find((s) => s.library_id === selectedId) ?? null,
    [summaries, selectedId],
  );

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── List sidebar ─────────────────────────────────────────────── */}
      <LibrarySidebar
        summaries={summaries}
        selectedId={selectedId}
        loading={loading}
        importing={importing}
        saving={saving}
        dirty={dirty}
        onSelect={setSelectedId}
        onCreate={handleCreate}
        onImportFile={handleImportFile}
      />

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
            <LibraryDetailHeader
              character={character}
              dirty={dirty}
              saving={saving}
              exporting={exporting}
              includeCorpusInExport={includeCorpusInExport}
              setIncludeCorpusInExport={setIncludeCorpusInExport}
              patch={patch}
              onSave={handleSave}
              onExport={handleExport}
              onDelete={handleDelete}
            />

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
              <LibraryVoiceTab
                character={character}
                dirty={dirty}
                saving={saving}
                patch={patch}
                setCharacter={setCharacter}
                setDirty={setDirty}
                setSaving={setSaving}
                setError={setError}
                voiceDesignTestLine={voiceDesignTestLine}
                setVoiceDesignTestLine={setVoiceDesignTestLine}
                generatingDesign={generatingDesign}
                setGeneratingDesign={setGeneratingDesign}
                designGenError={designGenError}
                setDesignGenError={setDesignGenError}
              />
            )}

            {/* ── PALETTE tab ──────────────────────────────────────────── */}
            {tab === "palette" && (
              <LibraryPaletteTab
                character={character}
                dirty={dirty}
                patch={patch}
                setCharacter={setCharacter}
                setDirty={setDirty}
                setSaving={setSaving}
                setError={setError}
                refreshList={refreshList}
                paletteTestLine={paletteTestLine}
                setPaletteTestLine={setPaletteTestLine}
                addingEmotion={addingEmotion}
                setAddingEmotion={setAddingEmotion}
                newEmotionKey={newEmotionKey}
                setNewEmotionKey={setNewEmotionKey}
                newEmotionLabel={newEmotionLabel}
                setNewEmotionLabel={setNewEmotionLabel}
                newEmotionDirection={newEmotionDirection}
                setNewEmotionDirection={setNewEmotionDirection}
                paletteGenError={paletteGenError}
                setPaletteGenError={setPaletteGenError}
                paletteDiskTakes={paletteDiskTakes}
              />
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
                    getLibraryCharacter(selectedId)
                      .then(setCharacter)
                      .catch((e) => reportError("Reload character after training", e));
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
