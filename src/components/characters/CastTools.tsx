/**
 * CastTools — cast housekeeping for Cast & Voices.
 *
 *  - CastMatchBanner: unnamed rebuild voices ("Speaker 9") that are the same
 *    dissected speaker as a named character, merged in one click.
 *  - MergeIntoControl: move one character's lines onto another and drop it.
 *  - CastPackButtons: Export cast (every character, one .pharaoh-cast pack),
 *    "…" to pick some, and Import cast (any number of packs and
 *    .pharaoh-character files at once).
 *
 * All three write project files, then reload the project from disk.
 */

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Character } from "../../lib/types";
import {
  castMatches, exportCastPack, importCastFiles, mergeCharacters, type CastMatch,
} from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { useToastStore } from "../../store/toastStore";

const toast = (title: string, body?: string) => useToastStore.getState().push({ kind: "info", title, body });

// ── Matches ────────────────────────────────────────────────────────────────

export const CastMatchBanner: React.FC<{ projectId: string; castKey: string; onChanged: () => Promise<void> }> = ({ projectId, castKey, onChanged }) => {
  const [matches, setMatches] = useState<CastMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    castMatches(projectId).then(setMatches).catch(() => setMatches([]));
  }, [projectId]);
  useEffect(load, [load, castKey]);

  if (matches.length === 0) return null;
  const chosen = matches.filter((m) => !skip.has(m.from_id));
  const lines = chosen.reduce((n, m) => n + m.lines, 0);

  const merge = async () => {
    setBusy(true);
    try {
      let moved = 0;
      for (const m of chosen) moved += (await mergeCharacters({ projectId, fromIds: [m.from_id], intoId: m.into_id })).rows_moved;
      toast(`Merged ${chosen.length} voices`, `${moved} lines now belong to their named characters.`);
      setOpen(false);
      await onChanged();
      load();
    } catch (e) {
      reportError("Merge failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "10px 24px", borderBottom: "1px solid var(--line-1)", background: "color-mix(in oklch, var(--tts) 6%, var(--bg-1))", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: "var(--fg-1)" }}>
          {matches.length} unnamed {matches.length === 1 ? "voice is" : "voices are"} the same speaker as a named character
          <span style={{ color: "var(--fg-3)" }}> ({matches.reduce((n, m) => n + m.lines, 0)} lines)</span>
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Review"}</button>
        <button className="btn btn-sm btn-primary" disabled={busy || chosen.length === 0} onClick={merge}>
          {busy ? "Merging…" : `Merge ${chosen.length}`}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto minmax(0,1fr) auto", gap: "3px 10px", alignItems: "center", fontSize: 11.5 }}>
          {matches.map((m) => (
            <React.Fragment key={m.from_id}>
              <input
                type="checkbox"
                checked={!skip.has(m.from_id)}
                onChange={(e) => setSkip((s) => { const n = new Set(s); if (e.target.checked) n.delete(m.from_id); else n.add(m.from_id); return n; })}
              />
              <span style={{ color: "var(--fg-3)" }}>{m.from_name}</span>
              <span style={{ color: "var(--fg-4)" }}>→</span>
              <span style={{ color: "var(--fg-1)" }}>{m.into_name}</span>
              <span style={{ color: "var(--fg-4)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{m.speaker_id} · {m.lines} lines</span>
            </React.Fragment>
          ))}
        </div>
      )}
      {open && <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--fg-4)" }}>
        Matched by dissected speaker. Merging moves the lines (script rows, Fountain, scene casts) and removes the unnamed character; its audio stays on disk. {lines} lines selected.
      </div>}
    </div>
  );
};

// ── Merge into ─────────────────────────────────────────────────────────────

export const MergeIntoControl: React.FC<{ projectId: string; character: Character; characters: Character[]; onChanged: () => Promise<void> }> = ({ projectId, character, characters, onChanged }) => {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const others = characters.filter((c) => c.id !== character.id);
  const into = others.find((c) => c.id === target);

  const merge = async () => {
    if (!into) return;
    if (!window.confirm(`Move all of ${character.name}'s lines to ${into.name} and remove ${character.name}? Its audio stays on disk.`)) return;
    setBusy(true);
    try {
      const r = await mergeCharacters({ projectId, fromIds: [character.id], intoId: into.id });
      toast(`${character.name} merged into ${into.name}`, `${r.rows_moved} lines moved.`);
      setTarget("");
      await onChanged();
    } catch (e) {
      reportError("Merge failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
      <select
        className="input"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        title="Move this character's lines onto another character"
        style={{ fontSize: 11, padding: "2px 4px", maxWidth: 150 }}
      >
        <option value="">Merge into…</option>
        {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {into && <button className="btn btn-sm" disabled={busy} onClick={merge}>{busy ? "Merging…" : "Merge"}</button>}
    </span>
  );
};

// ── Packs ──────────────────────────────────────────────────────────────────

export const CastPackButtons: React.FC<{ projectId: string; projectTitle: string; characters: Character[]; onChanged: () => Promise<void> }> = ({ projectId, projectTitle, characters, onChanged }) => {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [corpus, setCorpus] = useState(false);
  const [busy, setBusy] = useState(false);

  // ids: the characters to write (the whole cast for "Export cast").
  const doExport = async (ids: string[], withCorpus: boolean) => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const safe = projectTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "cast";
    const target = await save({ title: "Export cast pack", defaultPath: `${safe}.pharaoh-cast`, filters: [{ name: "Pharaoh cast pack", extensions: ["pharaoh-cast"] }] });
    if (!target) return;
    setBusy(true);
    try {
      const r = await exportCastPack({ projectId, characterIds: ids, outputPath: target, includeCorpus: withCorpus });
      toast(`Exported ${r.characters.length} characters`, `${(r.bytes / 1e6).toFixed(1)} MB · ${target}`);
      setPicking(false);
    } catch (e) {
      reportError("Export failed", e);
    } finally {
      setBusy(false);
    }
  };

  // Any number of cast packs and single-character files in one go.
  const doImport = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      title: "Import cast",
      multiple: true,
      filters: [{ name: "Pharaoh cast or character", extensions: ["pharaoh-cast", "pharaoh-character"] }],
    });
    const files = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (files.length === 0) return;
    setBusy(true);
    try {
      const r = await importCastFiles({ projectId, filePaths: files });
      if (r.added.length) toast(`Imported ${r.added.length} characters`, r.added.map((c) => c.name).join(", "));
      if (r.failed.length) {
        useToastStore.getState().push({
          kind: "warn",
          title: `${r.failed.length} of ${files.length} files didn't import`,
          body: r.failed.map((f) => `${f.file}: ${f.error}`).join("\n"),
        });
      }
      await onChanged();
    } catch (e) {
      reportError("Import failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 4, padding: "6px 10px 6px 14px", borderBottom: "1px solid var(--line-1)" }}>
        <button className="btn btn-sm" style={{ flex: 1, fontSize: 10 }} disabled={busy} onClick={doImport} title="Add characters from one or more .pharaoh-cast packs or .pharaoh-character files">Import cast</button>
        <button className="btn btn-sm" style={{ flex: 1, fontSize: 10 }} disabled={busy || characters.length === 0} onClick={() => doExport(characters.map((c) => c.id), false)} title={`Save all ${characters.length} characters as one .pharaoh-cast pack`}>{busy ? "Working…" : "Export cast"}</button>
        <button className="btn btn-sm" style={{ fontSize: 10, padding: "0 6px" }} disabled={busy || characters.length === 0} onClick={() => { setPicked(new Set(characters.map((c) => c.id))); setPicking(true); }} title="Export some characters…" aria-label="Export some characters">…</button>
      </div>
      {picking && createPortal(
        <div onClick={() => setPicking(false)} style={{ position: "fixed", inset: 0, zIndex: 100, background: "color-mix(in oklch, black 55%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div role="dialog" aria-label="Export cast pack" onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 100%)", maxHeight: "80vh", display: "flex", flexDirection: "column", background: "var(--bg-1)", border: "1px solid var(--line-2)", borderRadius: 4, padding: 16 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--fg-4)", marginBottom: 8 }}>Export some characters</div>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 8 }}>Each character goes with its voice references, palette and voice-lock model, ready to import into another project.</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <button className="btn btn-sm" onClick={() => setPicked(new Set(characters.map((c) => c.id)))}>All</button>
              <button className="btn btn-sm" onClick={() => setPicked(new Set())}>None</button>
              <button className="btn btn-sm" onClick={() => setPicked(new Set(characters.filter((c) => !/^Speaker \d+/.test(c.name)).map((c) => c.id)))}>Named only</button>
            </div>
            <div style={{ overflowY: "auto", flex: 1, border: "1px solid var(--line-1)", borderRadius: 3, padding: "4px 8px" }}>
              {characters.map((c) => (
                <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, cursor: "pointer" }}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                </label>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-3)", margin: "8px 0" }}>
              <input type="checkbox" checked={corpus} onChange={(e) => setCorpus(e.target.checked)} />
              Include voice-lock training corpus (large; only needed to retrain)
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button className="btn btn-sm" onClick={() => setPicking(false)}>Cancel</button>
              <button className="btn btn-sm btn-primary" disabled={busy || picked.size === 0} onClick={() => doExport([...picked], corpus)}>{busy ? "Exporting…" : `Export ${picked.size}`}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
