/**
 * LibrarySidebar.tsx
 *
 * Left sidebar of the Character Library: header with Import… / + New actions
 * and the scrollable list of library character summaries. Purely
 * presentational — all state and mutations live in LibraryView.
 */

import React from "react";
import type { LibraryCharacterSummary } from "../../lib/types";
import { CHAR_HUE } from "./libraryShared";

export const LibrarySidebar: React.FC<{
  summaries: LibraryCharacterSummary[];
  selectedId: string | null;
  loading: boolean;
  importing: boolean;
  saving: boolean;
  /** Unsaved edits on the open character — selection prompts to discard. */
  dirty: boolean;
  onSelect: (libraryId: string) => void;
  onCreate: () => void;
  onImportFile: () => void;
}> = ({ summaries, selectedId, loading, importing, saving, dirty, onSelect, onCreate, onImportFile }) => {
  return (
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
        <div style={{ display: "flex", gap: 4 }}>
          <button
            className="btn btn-sm"
            style={{ padding: "2px 8px" }}
            onClick={onImportFile}
            disabled={importing}
            title="Import a .pharaoh-character file exported from another machine"
          >{importing ? "…" : "Import…"}</button>
          <button
            className="btn btn-sm btn-primary"
            style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", padding: "2px 8px" }}
            onClick={onCreate}
            disabled={saving}
            title="New library character"
          >+ New</button>
        </div>
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
              onSelect(s.library_id);
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
  );
};
