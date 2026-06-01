import React, { useState, useEffect, useMemo } from "react";
import { PlayButton } from "../shared/PlayButton";
import { useProjectStore } from "../../store/projectStore";
import { useUiStore } from "../../store/uiStore";
import {
  listLibraryCharacters,
  importCharacterFromLibrary,
  saveCharacterToLibrary,
  pullCharacterFromLibrary,
  readScript,
} from "../../lib/tauriCommands";
import type { Character, LibraryCharacterSummary, ScriptRow } from "../../lib/types";

// ── Cast manifest types (Pharaoh-8xu) ──────────────────────────────────────
//
// The Cast view is a per-episode manifest: read-only character summary plus
// the lines this character speaks across all scenes. Voice/Palette/Corpus/
// Model editing all happens in the Character Library.

interface LineEntry {
  sceneSlug: string;
  sceneTitle: string;
  sceneIndex: number;
  rowIndex: number;
  prompt: string;
  emotion: string;
  file: string;
  durationMs: string;
}

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

function newCharId() {
  return "CHAR_" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Voice badge derivation ─────────────────────────────────────────────────
//
// The legacy `model` enum mixed "how the ref was made" with "what runs at
// production time". We now derive a UI badge purely from data shape so the
// field can be dropped in a future cleanup without UI changes.

function deriveVoiceBadge(c: Character): { label: string; tone: "tts" | "fg" } {
  const va = c.voice_assignment;
  const hasRvc = va.rvc?.model_path != null && va.production_pipeline === "chatterbox+rvc";
  const hasPalette = (va.emotional_palette ?? []).some((e) => e.qa_status === "approved");
  const hasRef = !!va.ref_audio_path;
  const hasDesign = (va.base_voice_description ?? "").trim().length > 0;

  if (hasRvc) return { label: "Chatterbox + RVC", tone: "tts" };
  if (hasPalette) return { label: "Chatterbox", tone: "tts" };
  if (hasRef) return { label: "Reference", tone: "tts" };
  if (hasDesign) return { label: "Voice Design", tone: "tts" };
  return { label: "Empty", tone: "fg" };
}

export const CharacterDesignerView: React.FC = () => {
  const {
    characters, selectedCharId,
    setSelectedChar, addCharacter, removeCharacter,
    updateCharacter,
    realProjectId,
    reloadProjectFromDisk,
    realScenes,
  } = useProjectStore();
  const setView = useUiStore((s) => s.setView);

  const char = characters.find((c) => c.id === selectedCharId) ?? characters[0];

  const [localName, setLocalName] = useState(char?.name ?? "");
  const [localDesc, setLocalDesc] = useState(char?.description ?? "");
  const [newName, setNewName] = useState("");
  // Cast + button opens a modal: import from library or new project-only character.
  const [castModalOpen, setCastModalOpen] = useState(false);
  const [castModalMode, setCastModalMode] = useState<"choose" | "import" | "new">("choose");
  const [librarySummaries, setLibrarySummaries] = useState<LibraryCharacterSummary[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [pullingFromLibrary, setPullingFromLibrary] = useState(false);

  // Lines manifest: rows from every scene's script.csv where this character speaks.
  const [lines, setLines] = useState<LineEntry[]>([]);

  // Sync header inputs when the active character switches.
  useEffect(() => {
    if (!char) return;
    setLocalName(char.name);
    setLocalDesc(char.description);
  }, [char?.id]);

  // Library summaries — used for both drift detection and the import modal.
  const refreshLibrary = React.useCallback(async () => {
    setLibraryLoading(true);
    try {
      const rows = await listLibraryCharacters();
      setLibrarySummaries(rows);
    } catch {
      setLibrarySummaries([]);
    } finally {
      setLibraryLoading(false);
    }
  }, []);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary, characters.length]);

  const libraryVersionMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of librarySummaries) m.set(s.library_id, s.library_version);
    return m;
  }, [librarySummaries]);

  const hasDrift = (c: Character): boolean => {
    if (!c.library_id || !c.library_version) return false;
    const remote = libraryVersionMap.get(c.library_id);
    if (!remote) return false;
    return remote !== c.library_version;
  };

  // ── Lines manifest (Pharaoh-8xu) ──────────────────────────────────────────
  //
  // Reads every scene's script.csv and filters by character. Refreshes on
  // active character change.

  useEffect(() => {
    if (!char || !realProjectId || !realScenes || realScenes.length === 0) {
      setLines([]);
      return;
    }
    const charNameUpper = char.name.toUpperCase();
    let cancelled = false;
    Promise.all(
      realScenes.map((scene) =>
        readScript({ projectId: realProjectId, sceneSlug: scene.slug })
          .then((rows) =>
            rows
              .map((row, rowIndex) => ({ row, rowIndex }))
              .filter(({ row }) => {
                if (row.type !== "DIALOGUE") return false;
                const speaker = (row.character ?? "").trim();
                return speaker === char.id || speaker.toUpperCase() === charNameUpper;
              })
              .map(({ row, rowIndex }): LineEntry => ({
                sceneSlug: scene.slug,
                sceneTitle: scene.title,
                sceneIndex: scene.index,
                rowIndex,
                prompt: row.prompt,
                emotion: (row as ScriptRow & { emotion?: string }).emotion ?? "",
                file: row.file,
                durationMs: row.duration_ms,
              }))
          )
          .catch(() => [] as LineEntry[])
      )
    ).then((perScene) => {
      if (!cancelled) {
        const flat = perScene
          .flat()
          .sort((a, b) =>
            a.sceneIndex === b.sceneIndex
              ? a.rowIndex - b.rowIndex
              : a.sceneIndex - b.sceneIndex,
          );
        setLines(flat);
      }
    });
    return () => { cancelled = true; };
  }, [char?.id, char?.name, realProjectId, realScenes]);

  // ── Header sync ──

  const saveCharMeta = () => {
    if (!char) return;
    updateCharacter(char.id, { name: localName, description: localDesc });
  };

  // ── Character CRUD ──

  const handleAddCharacter = () => {
    if (!newName.trim()) return;
    const id = newCharId();
    addCharacter({
      id,
      name: newName.trim(),
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
    });
    setNewName("");
    setCastModalOpen(false);
  };

  const handleRemoveCharacter = (id: string) => {
    const name = characters.find((c) => c.id === id)?.name ?? "this character";
    if (!window.confirm(`Delete "${name}" from the cast? This keeps existing generated audio files but removes the character from project.json.`)) return;
    removeCharacter(id);
  };

  const openCastModal = () => {
    setCastModalOpen(true);
    setCastModalMode("choose");
    setNewName("");
    refreshLibrary();
  };

  const handleImportFromLibrary = async (libraryId: string) => {
    if (!realProjectId) return;
    setImporting(libraryId);
    try {
      const imported = await importCharacterFromLibrary({
        projectId: realProjectId,
        libraryId,
      });
      // Pull fresh project state from disk so the new character lands in the
      // sidebar with its full bundle data (palette refs, RVC config) intact —
      // a plain addCharacter() would only know what import returned.
      await reloadProjectFromDisk();
      setSelectedChar(imported.id);
      setCastModalOpen(false);
    } catch (e) {
      window.alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(null);
    }
  };

  const handleSaveToLibrary = async () => {
    if (!char || !realProjectId) return;
    const isUpdate = !!char.library_id;
    const verb = isUpdate ? "Update" : "Save";
    if (!window.confirm(`${verb} "${char.name}" ${isUpdate ? "in" : "to"} the library? This copies the full bundle (palette refs, RVC model if trained, corpus).`)) return;
    setSavingToLibrary(true);
    try {
      await saveCharacterToLibrary({ projectId: realProjectId, characterId: char.id });
      // Pull fresh project state so the new library_id + library_version
      // appear on the character (used by drift detection).
      await reloadProjectFromDisk();
      await refreshLibrary();
    } catch (e) {
      window.alert(`Save to library failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingToLibrary(false);
    }
  };

  const handlePullFromLibrary = async () => {
    if (!char || !realProjectId || !char.library_id) return;
    if (!window.confirm(
      `Pull the library version of "${char.name}" into this project? ` +
      `This OVERWRITES any local edits to palette refs, RVC config, ` +
      `description, and voice settings. The character's script-row id (${char.id}) is preserved.`
    )) return;
    setPullingFromLibrary(true);
    try {
      await pullCharacterFromLibrary({ projectId: realProjectId, characterId: char.id });
      await reloadProjectFromDisk();
      await refreshLibrary();
    } catch (e) {
      window.alert(`Pull from library failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPullingFromLibrary(false);
    }
  };

  const handleDetachFromLibrary = () => {
    if (!char || !char.library_id) return;
    if (!window.confirm(
      `Detach "${char.name}" from the library? ` +
      `The character stays in the project unchanged, but loses its link to ` +
      `the library entry. Push/pull will no longer be available.`
    )) return;
    updateCharacter(char.id, { library_id: null, library_version: null });
  };

  const charColor = char ? `oklch(0.7 0.12 ${CHAR_HUE(char.id)})` : "";
  const refPath   = char?.voice_assignment.ref_audio_path ?? null;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>

      {/* ── Character list ──────────────────────────────────────────────── */}
      <div style={{
        width: 200, flexShrink: 0,
        borderRight: "1px solid var(--line-1)",
        display: "flex", flexDirection: "column",
        background: "var(--bg-1)", overflowY: "auto",
      }}>
        <div style={{
          padding: "8px 10px 8px 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Cast · {characters.length}
          </span>
          <button
            className="btn btn-sm"
            style={{ padding: "2px 7px", fontSize: 14, lineHeight: 1 }}
            title="Add character"
            onClick={openCastModal}
          >+</button>
        </div>

        {characters.map((c) => {
          const active = c.id === char.id;
          const hue = CHAR_HUE(c.id);
          const modelLabel = deriveVoiceBadge(c).label.toLowerCase();
          const driftDot = hasDrift(c);
          const libraryLinked = !!c.library_id;
          return (
            <div
              key={c.id}
              className={`side-item ${active ? "active" : ""}`}
              onClick={() => setSelectedChar(c.id)}
              style={{ paddingTop: 8, paddingBottom: 8, cursor: "pointer", paddingRight: 6 }}
              title={driftDot
                ? "Library has a newer version of this character"
                : libraryLinked
                  ? "Imported from library"
                  : undefined}
            >
              <span className="ico" style={{ position: "relative" }}>
                <span style={{
                  display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                  background: `oklch(0.7 0.12 ${hue})`,
                  border: "1px solid var(--line-2)",
                }} />
                {driftDot && (
                  <span style={{
                    position: "absolute",
                    top: -2, right: -3,
                    width: 6, height: 6, borderRadius: "50%",
                    background: "var(--st-gen)",
                    border: "1px solid var(--bg-1)",
                  }} />
                )}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <span style={{
                  display: "block", fontSize: 12, fontWeight: active ? 500 : 400,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {c.name.split(" ")[0]}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 8.5,
                  color: "var(--fg-4)", letterSpacing: "0.04em",
                }}>
                  {modelLabel}
                </span>
              </span>
              <button
                className="btn btn-sm"
                style={{
                  padding: "1px 6px", minWidth: 0, fontSize: 11,
                  color: "var(--sfx)", borderColor: "transparent",
                }}
                title={`Delete ${c.name}`}
                aria-label={`Delete ${c.name}`}
                onClick={(e) => { e.stopPropagation(); handleRemoveCharacter(c.id); }}
              >×</button>
            </div>
          );
        })}
      </div>

      {/* ── Detail panel + right meta ──────────────────────────────────── */}
      {!char ? (
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "var(--fg-4)",
        }}>
          <span style={{ fontSize: 28, opacity: 0.25 }}>◎</span>
          <span style={{ fontSize: 12 }}>No characters yet</span>
          <button
            className="btn btn-primary"
            style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", marginTop: 4 }}
            onClick={openCastModal}
          >
            + Add character
          </button>
        </div>
      ) : (
      <div style={{ flex: 1, display: "flex", minWidth: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", minWidth: 0 }}>

        {/* Character header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{
              width: 14, height: 14, borderRadius: "50%",
              background: charColor, display: "inline-block", flexShrink: 0,
            }} />
            <input
              className="input"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={saveCharMeta}
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
            }}>
              {deriveVoiceBadge(char).label}
            </span>
            {char.library_id && (
              <span
                title={hasDrift(char)
                  ? "Library has a newer version. Use Update library to push your changes."
                  : "Imported from library — in sync"}
                style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
                  color: hasDrift(char) ? "var(--st-gen)" : "var(--st-rendered)",
                  textTransform: "uppercase",
                  background: hasDrift(char)
                    ? "color-mix(in oklch, var(--st-gen) 12%, var(--bg-2))"
                    : "color-mix(in oklch, var(--st-rendered) 10%, var(--bg-2))",
                  padding: "2px 6px", borderRadius: 3, flexShrink: 0,
                  display: "inline-flex", alignItems: "center", gap: 4,
                }}
              >
                {hasDrift(char) && <span style={{
                  width: 5, height: 5, borderRadius: "50%",
                  background: "var(--st-gen)",
                }} />}
                {hasDrift(char) ? "Drift" : "Linked"}
              </span>
            )}
            <button
              className="btn btn-sm"
              onClick={handleSaveToLibrary}
              disabled={savingToLibrary}
              title={char.library_id
                ? "Push the current project version over the existing library entry"
                : "Create a new library entry from this character"}
              style={{
                color: "var(--tts)",
                borderColor: "color-mix(in oklch, var(--tts) 45%, var(--line-1))",
                background: "color-mix(in oklch, var(--tts) 8%, transparent)",
                flexShrink: 0,
              }}
            >
              {savingToLibrary
                ? "Saving…"
                : char.library_id
                  ? "Update library"
                  : "Save to library"}
            </button>
            <button
              className="btn btn-sm"
              style={{
                color: "var(--sfx)",
                borderColor: "color-mix(in oklch, var(--sfx) 45%, var(--line-1))",
                background: "color-mix(in oklch, var(--sfx) 8%, transparent)",
                flexShrink: 0,
              }}
              onClick={() => handleRemoveCharacter(char.id)}
            >
              Delete
            </button>
          </div>
          <textarea
            className="input"
            value={localDesc}
            onChange={(e) => setLocalDesc(e.target.value)}
            onBlur={saveCharMeta}
            rows={2}
            style={{
              background: "transparent", border: "none", padding: 0,
              fontSize: 12, color: "var(--fg-3)", width: "100%",
              resize: "none", lineHeight: 1.5,
            }}
            placeholder="Character notes — age, role, personality, vocal direction…"
          />
        </div>

        {/* ── Library drift banner ───────────────────────────────────────── */}
        {char.library_id && hasDrift(char) && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "10px 24px",
            background: "color-mix(in oklch, var(--st-gen) 8%, var(--bg-1))",
            borderBottom: "1px solid color-mix(in oklch, var(--st-gen) 30%, var(--line-1))",
            flexShrink: 0,
            fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: "var(--st-gen)", flexShrink: 0,
            }} />
            <span style={{ flex: 1 }}>
              <strong style={{ color: "var(--fg-1)" }}>This character has drifted from the library.</strong>{" "}
              The library copy was last updated{" "}
              {(() => {
                const remote = libraryVersionMap.get(char.library_id!);
                if (!remote) return "(unknown)";
                try { return new Date(remote).toLocaleString(); }
                catch { return remote; }
              })()}.
            </span>
            <button
              className="btn btn-sm"
              onClick={handleSaveToLibrary}
              disabled={savingToLibrary || pullingFromLibrary}
              title="Save the project version over the library entry"
              style={{
                background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)",
              }}
            >
              {savingToLibrary ? "Pushing…" : "Push your changes"}
            </button>
            <button
              className="btn btn-sm"
              onClick={handlePullFromLibrary}
              disabled={savingToLibrary || pullingFromLibrary}
              title="Overwrite the project version with the library copy"
            >
              {pullingFromLibrary ? "Pulling…" : "Pull library version"}
            </button>
            <button
              className="btn btn-sm"
              onClick={handleDetachFromLibrary}
              disabled={savingToLibrary || pullingFromLibrary}
              title="Keep this character but break the link to the library"
              style={{ color: "var(--fg-3)" }}
            >
              Detach
            </button>
          </div>
        )}

        {/* ── Character summary + Lines manifest (Pharaoh-8xu) ─────────────────
            Cast view is now read-only. Voice design / palette / corpus / RVC
            editing all happens in the Character Library. */}
        <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>

          {/* Summary card */}
          <div style={{
            display: "flex", flexDirection: "column", gap: 10,
            padding: "12px 14px", marginBottom: 18,
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)", borderRadius: "var(--r)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11 }}>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
                color: "var(--fg-4)", textTransform: "uppercase",
              }}>Voice mode</span>
              <span style={{ color: "var(--tts)", fontWeight: 500 }}>
                {deriveVoiceBadge(char).label}
              </span>
              {char.voice_assignment.ref_audio_path ? (
                <span style={{ color: "var(--st-rendered)", fontSize: 10 }}>✓ reference set</span>
              ) : (
                <span style={{ color: "var(--fg-4)", fontSize: 10 }}>no reference</span>
              )}
            </div>
            {char.voice_assignment.base_voice_description && (
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.6 }}>
                {char.voice_assignment.base_voice_description}
              </div>
            )}
            {(() => {
              const approved = char.voice_assignment.emotional_palette.filter(
                (e) => e.qa_status === "approved",
              );
              if (approved.length === 0) {
                return (
                  <div style={{ fontSize: 11, color: "var(--fg-4)", fontStyle: "italic" }}>
                    No approved emotions yet — open in Library to add some.
                  </div>
                );
              }
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {approved.map((e) => (
                    <span
                      key={e.emotion}
                      style={{
                        fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.04em",
                        color: "var(--st-rendered)",
                        background: "color-mix(in oklch, var(--st-rendered) 10%, var(--bg-2))",
                        border: "1px solid color-mix(in oklch, var(--st-rendered) 30%, var(--line-1))",
                        padding: "2px 7px", borderRadius: 3,
                      }}
                    >
                      {e.label}
                    </span>
                  ))}
                </div>
              );
            })()}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                className="btn btn-sm"
                onClick={() => setView("library")}
                title="Open this character in the Character Library to edit voice, palette, corpus, or RVC"
                style={{
                  background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)",
                }}
              >
                {char.library_id ? "Open in Library →" : "Design voice in Library →"}
              </button>
            </div>
          </div>

          {/* Lines manifest */}
          <div style={{ marginBottom: 8, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
              color: "var(--fg-4)", textTransform: "uppercase",
            }}>
              Lines in this episode · {lines.length}
            </span>
            {lines.length > 0 && (
              <span style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                {lines.filter((l) => l.file.trim()).length} rendered · {lines.filter((l) => !l.file.trim()).length} unresolved
              </span>
            )}
          </div>

          {lines.length === 0 ? (
            <div style={{
              padding: "20px 16px", textAlign: "center",
              border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
              color: "var(--fg-4)", fontSize: 11.5, lineHeight: 1.6,
            }}>
              No dialogue rows reference this character. Assign lines in the
              Scenes view — every script row whose <em>character</em> column
              matches <strong style={{ color: "var(--fg-3)" }}>{char.name}</strong>{" "}
              or <code style={{ fontFamily: "var(--font-mono)", color: "var(--fg-3)" }}>{char.id}</code>{" "}
              will appear here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {(() => {
                const grouped = new Map<string, LineEntry[]>();
                for (const ln of lines) {
                  const key = `${ln.sceneIndex}__${ln.sceneSlug}`;
                  if (!grouped.has(key)) grouped.set(key, []);
                  grouped.get(key)!.push(ln);
                }
                return Array.from(grouped.entries()).map(([key, sceneLines]) => {
                  const head = sceneLines[0];
                  return (
                    <div key={key} style={{ marginBottom: 14 }}>
                      <div style={{
                        fontSize: 10, fontFamily: "var(--font-mono)",
                        letterSpacing: "0.06em", color: "var(--fg-4)",
                        textTransform: "uppercase",
                        padding: "4px 0 6px",
                        borderBottom: "1px solid var(--line-1)",
                        marginBottom: 6,
                      }}>
                        {String(head.sceneIndex).padStart(2, "0")} · {head.sceneTitle}
                      </div>
                      {sceneLines.map((ln) => (
                        <div key={`${ln.sceneSlug}_${ln.rowIndex}`} style={{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr auto auto",
                          alignItems: "center",
                          gap: 10,
                          padding: "6px 4px",
                          borderBottom: "1px solid color-mix(in oklch, var(--line-1) 50%, transparent)",
                        }}>
                          <span style={{
                            fontFamily: "var(--font-mono)", fontSize: 9.5,
                            color: ln.file.trim() ? "var(--st-rendered)" : "var(--fg-4)",
                            minWidth: 16,
                          }}>
                            {ln.file.trim() ? "●" : "○"}
                          </span>
                          <span style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5, minWidth: 0 }}>
                            {ln.prompt || <span style={{ color: "var(--fg-4)", fontStyle: "italic" }}>(empty)</span>}
                          </span>
                          {ln.emotion ? (
                            <span style={{
                              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.04em",
                              color: "var(--fg-4)", textTransform: "lowercase",
                              padding: "1px 6px",
                              border: "1px solid var(--line-1)", borderRadius: 3,
                            }}>{ln.emotion}</span>
                          ) : (
                            <span />
                          )}
                          {ln.file.trim() ? (
                            <PlayButton path={ln.file} size={11} />
                          ) : (
                            <span />
                          )}
                        </div>
                      ))}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

      </div>

      {/* ── Right meta panel ────────────────────────────────────────────── */}
      <div style={{
        width: 174, flexShrink: 0,
        borderLeft: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "14px 12px", overflowY: "auto", fontSize: 11,
      }}>
        <MetaSection label="Mode">
          <div style={{ color: "var(--tts)", fontWeight: 500 }}>
            {deriveVoiceBadge(char).label}
          </div>
          {refPath
            ? <div style={{ color: "var(--st-rendered)", fontSize: 10, marginTop: 4 }}>✓ Reference set</div>
            : <div style={{ color: "var(--fg-4)", fontSize: 10, marginTop: 4 }}>No reference</div>}
        </MetaSection>

        {char.voice_assignment.emotional_palette.length > 0 && (
          <MetaSection label="Palette">
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {char.voice_assignment.emotional_palette.map((e) => (
                <div key={e.emotion} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                    background: e.qa_status === "approved" ? "var(--st-rendered)" : "var(--fg-4)",
                  }} />
                  <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{e.label}</span>
                </div>
              ))}
            </div>
          </MetaSection>
        )}

        {char.voice_assignment.instruct_default && (
          <MetaSection label="Voice instructions">
            <div style={{ color: "var(--fg-3)", lineHeight: 1.5, fontSize: 10.5 }}>
              {char.voice_assignment.instruct_default}
            </div>
          </MetaSection>
        )}

        <MetaSection label="Lines">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ color: "var(--fg-3)" }}>Total: <strong style={{ color: "var(--fg-1)" }}>{lines.length}</strong></span>
            <span style={{ color: "var(--fg-3)" }}>Rendered: <strong style={{ color: "var(--fg-1)" }}>{lines.filter((l) => l.file.trim()).length}</strong></span>
          </div>
        </MetaSection>
      </div>
      </div>
      )}

      {/* ── Add-character modal ────────────────────────────────────────── */}
      {castModalOpen && (
        <div
          onClick={() => setCastModalOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "color-mix(in oklch, var(--bg-0) 70%, transparent)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--r)",
              width: 480, maxHeight: "80vh",
              boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
              display: "flex", flexDirection: "column", overflow: "hidden",
            }}
          >
            <div style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--line-1)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>
                {castModalMode === "choose" ? "Add character"
                  : castModalMode === "import" ? "Import from library"
                  : "New character"}
              </span>
              <button
                className="btn btn-sm"
                onClick={() => setCastModalOpen(false)}
                style={{ padding: "2px 8px", fontSize: 13, lineHeight: 1 }}
              >×</button>
            </div>

            <div style={{ padding: "16px 18px", flex: 1, overflowY: "auto" }}>
              {/* ── Choose path ── */}
              {castModalMode === "choose" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <button
                    className="btn"
                    onClick={() => setCastModalMode("import")}
                    style={{
                      textAlign: "left", padding: "12px 14px",
                      background: "var(--bg-2)", border: "1px solid var(--line-2)",
                      borderRadius: "var(--r)", cursor: "pointer",
                      display: "flex", flexDirection: "column", gap: 4,
                    }}
                  >
                    <span style={{ fontSize: 13, color: "var(--fg-1)", fontWeight: 500 }}>
                      Import from library
                    </span>
                    <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                      {libraryLoading
                        ? "Loading library…"
                        : `${librarySummaries.length} character${librarySummaries.length === 1 ? "" : "s"} available — reuse across episodes`}
                    </span>
                  </button>
                  <button
                    className="btn"
                    onClick={() => setCastModalMode("new")}
                    style={{
                      textAlign: "left", padding: "12px 14px",
                      background: "var(--bg-2)", border: "1px solid var(--line-2)",
                      borderRadius: "var(--r)", cursor: "pointer",
                      display: "flex", flexDirection: "column", gap: 4,
                    }}
                  >
                    <span style={{ fontSize: 13, color: "var(--fg-1)", fontWeight: 500 }}>
                      New character (project-only)
                    </span>
                    <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                      Create from scratch. You can save it to the library later.
                    </span>
                  </button>
                </div>
              )}

              {/* ── Import from library ── */}
              {castModalMode === "import" && (
                <div>
                  {libraryLoading && (
                    <div style={{ padding: "20px 12px", textAlign: "center", color: "var(--fg-4)", fontSize: 12 }}>
                      Loading…
                    </div>
                  )}
                  {!libraryLoading && librarySummaries.length === 0 && (
                    <div style={{
                      padding: "20px 14px", textAlign: "center",
                      border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                      color: "var(--fg-4)", fontSize: 11.5, lineHeight: 1.6,
                    }}>
                      Library is empty. Use "Save to library" on any character
                      in this project, or create one in the Character Library
                      view.
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {librarySummaries.map((s) => {
                      const alreadyImported = characters.some((c) => c.library_id === s.library_id);
                      return (
                        <button
                          key={s.library_id}
                          onClick={() => handleImportFromLibrary(s.library_id)}
                          disabled={importing === s.library_id || alreadyImported}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "auto 1fr auto",
                            alignItems: "center", gap: 10,
                            width: "100%", textAlign: "left",
                            padding: "10px 12px",
                            border: "1px solid var(--line-1)",
                            borderRadius: "var(--r)",
                            background: alreadyImported
                              ? "color-mix(in oklch, var(--bg-2) 60%, transparent)"
                              : "var(--bg-1)",
                            cursor: alreadyImported ? "default" : "pointer",
                            color: "var(--fg-1)",
                            opacity: alreadyImported ? 0.55 : 1,
                          }}
                        >
                          <span style={{
                            display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                            background: `oklch(0.7 0.12 ${(s.library_id.charCodeAt(0) * 13) % 360})`,
                            border: "1px solid var(--line-2)",
                          }} />
                          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {s.name}
                            </span>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", letterSpacing: "0.04em" }}>
                              {s.palette_count} palette
                              {s.has_rvc_model ? " · rvc" : ""}
                              {alreadyImported ? " · already in cast" : ""}
                            </span>
                          </span>
                          <span style={{ fontSize: 11, color: "var(--tts)", fontFamily: "var(--font-mono)" }}>
                            {importing === s.library_id ? "Importing…" : alreadyImported ? "" : "Import →"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 12, textAlign: "right" }}>
                    <button className="btn btn-sm" onClick={() => setCastModalMode("choose")}>← Back</button>
                  </div>
                </div>
              )}

              {/* ── New project-only character ── */}
              {castModalMode === "new" && (
                <div>
                  <label style={labelStyle}>Character name</label>
                  <input
                    className="input"
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddCharacter();
                      if (e.key === "Escape") setCastModalOpen(false);
                    }}
                    placeholder="e.g. Jack Rourke"
                    style={{ width: "100%", fontSize: 13, padding: "6px 9px" }}
                  />
                  <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <button className="btn btn-sm" onClick={() => setCastModalMode("choose")}>← Back</button>
                    <button
                      className="btn btn-primary"
                      onClick={handleAddCharacter}
                      disabled={!newName.trim()}
                      style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)" }}
                    >
                      Create
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

// ── Small shared sub-components ────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};

const MetaSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 12, marginTop: 12 }}>
    <div style={{
      fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
      color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 6,
    }}>
      {label}
    </div>
    {children}
  </div>
);
