/**
 * MoveToSelect.tsx
 *
 * A compact "Move to…" picker: another speaker, or a new one (asks for a
 * name inline). Used per clip, for selected lines, and to merge a speaker.
 */

import React, { useState } from "react";
import type { DissectSpeaker } from "../../lib/types";

export interface MoveTarget {
  /** Speaker id, or null for a new speaker. */
  to: string | null;
  newLabel: string | null;
}

const NEW = "__new__";

export const MoveToSelect: React.FC<{
  speakers: DissectSpeaker[];
  /** The speaker the items are on now; left out of the list. */
  from: string;
  placeholder?: string;
  /** Offer "New voice…" (not for merging). */
  allowNew?: boolean;
  disabled?: boolean;
  /** Fixed narrow width for tight rows; the open list still shows full names. */
  width?: number;
  onMove: (t: MoveTarget) => void;
}> = ({ speakers, from, placeholder = "Move to…", allowNew = true, disabled, width, onMove }) => {
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");

  if (naming) {
    const done = () => { setNaming(false); setLabel(""); };
    return (
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus value={label} placeholder="New voice name"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onMove({ to: null, newLabel: label.trim() || null }); done(); }
            if (e.key === "Escape") done();
          }}
          style={selectStyle}
        />
        <button className="btn btn-sm" onClick={() => { onMove({ to: null, newLabel: label.trim() || null }); done(); }}>Move</button>
        <button className="btn btn-sm" onClick={done}>×</button>
      </span>
    );
  }

  return (
    <select
      value="" disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW) setNaming(true);
        else if (v) onMove({ to: v, newLabel: null });
      }}
      style={width ? { ...selectStyle, width } : selectStyle}
      title={placeholder}
    >
      <option value="">{placeholder}</option>
      {allowNew && <option value={NEW}>New voice…</option>}
      {speakers.filter((s) => s.id !== from).map((s) => (
        <option key={s.id} value={s.id}>{s.label}{s.sample_text ? ` · “${s.sample_text.slice(0, 40)}”` : ""}</option>
      ))}
    </select>
  );
};

const selectStyle: React.CSSProperties = {
  fontSize: 10.5, background: "var(--bg-0)", color: "var(--fg-2)",
  border: "1px solid var(--line-2)", borderRadius: 2, padding: "2px 4px", maxWidth: 220,
};
