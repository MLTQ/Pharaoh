/**
 * LibraryDetailHeader.tsx
 *
 * Detail-panel header for the open library character: color dot, inline
 * name editor, Library badge, Save button (the "dirty" affordance), and —
 * for persisted entries — the +corpus export toggle, Export…, and Delete
 * actions. Purely presentational; save/export/delete logic lives in
 * LibraryView.
 */

import React from "react";
import type { Character } from "../../lib/types";
import { CHAR_HUE } from "./libraryShared";

export const LibraryDetailHeader: React.FC<{
  character: Character;
  dirty: boolean;
  saving: boolean;
  exporting: boolean;
  includeCorpusInExport: boolean;
  setIncludeCorpusInExport: (v: boolean) => void;
  patch: (mut: (c: Character) => Character) => void;
  onSave: () => void;
  onExport: () => void;
  onDelete: () => void;
}> = ({
  character, dirty, saving, exporting,
  includeCorpusInExport, setIncludeCorpusInExport,
  patch, onSave, onExport, onDelete,
}) => {
  return (
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
        onClick={onSave}
        disabled={!dirty || saving}
      >
        {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
      </button>
      {character.library_id && (
        <>
          <label
            title="Include the raw RVC training corpus (~hundreds of MB). Off by default — the trained model + index are always included."
            style={{
              display: "flex", alignItems: "center", gap: 4,
              fontSize: 10, color: "var(--fg-4)",
              fontFamily: "var(--font-mono)", letterSpacing: "0.04em",
              cursor: "pointer", userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={includeCorpusInExport}
              onChange={(e) => setIncludeCorpusInExport(e.target.checked)}
              style={{ width: 11, height: 11, accentColor: "var(--tts)" }}
            />
            +corpus
          </label>
          <button
            className="btn btn-sm"
            onClick={onExport}
            disabled={exporting || saving}
            title="Export this character as a .pharaoh-character file"
          >{exporting ? "Exporting…" : "Export…"}</button>
          <button
            className="btn btn-sm"
            style={{
              color: "var(--sfx)",
              borderColor: "color-mix(in oklch, var(--sfx) 45%, var(--line-1))",
              background: "color-mix(in oklch, var(--sfx) 8%, transparent)",
            }}
            onClick={onDelete}
            disabled={saving}
          >Delete</button>
        </>
      )}
    </div>
  );
};
