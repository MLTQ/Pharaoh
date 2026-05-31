/**
 * LibraryView.tsx
 *
 * Character Library — project-independent browser/editor for library characters
 * (Pharaoh-z21). Library bundles live at
 *   <projects_dir>/_library/characters/<library_id>/
 * and are reusable across episodes via fork-and-pull sync.
 *
 * Scope of this view (MVP):
 *   - Browse all library characters
 *   - Create a new (empty) library character
 *   - Edit metadata: name, description, base voice description, emotional
 *     palette directions
 *   - Play approved palette reference audio
 *   - Delete library characters
 *
 * Out of scope (deferred to a follow-up):
 *   - Generating palette takes / corpus / RVC from inside the library.
 *     For now, audio generation requires importing the character into a
 *     project first.
 */

import React, { useEffect, useMemo, useState } from "react";
import { PlayButton } from "../shared/PlayButton";
import {
  listLibraryCharacters,
  getLibraryCharacter,
  saveLibraryCharacter,
  deleteLibraryCharacter,
} from "../../lib/tauriCommands";
import type { Character, LibraryCharacterSummary, PaletteEntry } from "../../lib/types";

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

            {/* Body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
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

              {/* Palette */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>
                  Emotional palette · {character.voice_assignment.emotional_palette.length}
                </label>
                {character.voice_assignment.emotional_palette.length === 0 ? (
                  <div style={{
                    padding: "14px 16px", textAlign: "center",
                    border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                    color: "var(--fg-4)", fontSize: 11.5, lineHeight: 1.6,
                  }}>
                    No palette entries. To add or generate emotional references,
                    import this character into a project.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {character.voice_assignment.emotional_palette.map((entry, idx) => (
                      <PaletteRow
                        key={entry.emotion}
                        entry={entry}
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
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* RVC status (read-only summary) */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>
                  RVC model {character.voice_assignment.rvc?.model_path ? "· trained" : "· none"}
                </label>
                {character.voice_assignment.rvc?.model_path ? (
                  <div style={{
                    padding: "10px 12px",
                    background: "color-mix(in oklch, var(--st-rendered) 8%, var(--bg-2))",
                    border: "1px solid color-mix(in oklch, var(--st-rendered) 30%, var(--line-1))",
                    borderRadius: "var(--r)",
                    fontSize: 11, color: "var(--fg-3)", lineHeight: 1.6,
                  }}>
                    {character.voice_assignment.rvc.model_path.split("/").pop()}
                    {character.voice_assignment.rvc.index_path && (
                      <span style={{ color: "var(--fg-4)", marginLeft: 8 }}>+ index</span>
                    )}
                  </div>
                ) : (
                  <div style={{
                    padding: "12px 14px",
                    border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                    color: "var(--fg-4)", fontSize: 11.5, lineHeight: 1.6,
                  }}>
                    No RVC model. Train one in a project after importing this character.
                  </div>
                )}
              </div>

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

const PaletteRow: React.FC<{
  entry: PaletteEntry;
  onChangeDirection: (direction: string) => void;
}> = ({ entry, onChangeDirection }) => {
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
            style={{ width: "100%", resize: "vertical", fontSize: 12 }}
            placeholder="e.g. Slower, more deliberate. Controlled dread just beneath the surface."
          />
        </div>
      )}
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
