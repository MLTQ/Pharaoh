import React, { useState } from "react";
import { saveLibraryCharacter } from "../../lib/tauriCommands";
import { emptyCharacter } from "../library/libraryShared";
import { reportError } from "../../lib/errors";
import type { CastMember, LibraryCharacterSummary, Series } from "../../lib/types";
import { Empty, Field, LinesInput, TwoCol, linkStyle, monoMeta } from "./seriesUi";

function blankCastMember(name: string): CastMember {
  return {
    id: `cast_${Math.random().toString(36).slice(2, 8)}`,
    name, description: "", want: "", flaw: "", engine: "",
    voice_notes: "", catchphrases: [], lazzi: [], never: "", relationships: [],
    library_id: null,
  };
}

export const CastTab: React.FC<{
  series: Series;
  library: LibraryCharacterSummary[];
  patch: (p: Partial<Series>) => void;
  /** Open the Voices tab on this library entry. */
  onDesignVoice: (libraryId: string) => void;
}> = ({ series, library, patch, onDesignVoice }) => {
  const [selId, setSelId] = useState<string | null>(series.cast[0]?.id ?? null);
  const sel = series.cast.find((m) => m.id === selId) ?? null;

  const setMember = (m: CastMember) =>
    patch({ cast: series.cast.map((x) => (x.id === m.id ? m : x)) });

  const add = () => {
    const m = blankCastMember(`New character ${series.cast.length + 1}`);
    patch({ cast: [...series.cast, m] });
    setSelId(m.id);
  };

  const remove = (m: CastMember) => {
    if (!window.confirm(`Remove ${m.name || "this character"} from the cast? Existing episodes keep their copy.`)) return;
    const cast = series.cast
      .filter((x) => x.id !== m.id)
      .map((x) => ({ ...x, relationships: x.relationships.filter((r) => r.with !== m.id) }));
    patch({ cast });
    setSelId(cast[0]?.id ?? null);
  };

  // A new library entry seeded from the cast sheet, linked, then opened in
  // the Voices tab for design and auditions.
  const designVoice = async (m: CastMember) => {
    try {
      const base = emptyCharacter();
      const saved = await saveLibraryCharacter({
        ...base,
        name: m.name || "Unnamed",
        description: m.description,
        voice_assignment: {
          ...base.voice_assignment,
          base_voice_description: [m.description, m.voice_notes].map((s) => s.trim()).filter(Boolean).join(". "),
        },
      });
      if (!saved.library_id) throw new Error("library save returned no id");
      setMember({ ...m, library_id: saved.library_id });
      onDesignVoice(saved.library_id);
    } catch (e) {
      reportError("Design voice", e);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: 24, alignItems: "start" }}>
      <div>
        {series.cast.map((m) => (
          <div
            key={m.id}
            onClick={() => setSelId(m.id)}
            style={{
              padding: "10px 12px", marginBottom: 6, borderRadius: 3, cursor: "pointer",
              border: `1px solid ${m.id === selId ? "var(--music)" : "var(--line-1)"}`,
              background: m.id === selId ? "color-mix(in oklch, var(--music) 6%, var(--bg-2))" : "var(--bg-2)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{m.name || "Unnamed"}</div>
            <div style={{ ...monoMeta, marginTop: 2 }}>
              {m.library_id ? "voiced" : "no voice"}
            </div>
          </div>
        ))}
        <button className="btn" onClick={add} style={{ width: "100%", marginTop: 4 }}>+ Add character</button>
      </div>

      {sel ? (
        <CastEditor
          key={sel.id} member={sel} cast={series.cast} library={library}
          onChange={setMember} onRemove={() => remove(sel)}
          onDesignVoice={() => (sel.library_id ? onDesignVoice(sel.library_id) : designVoice(sel))}
        />
      ) : (
        <Empty>No cast yet.</Empty>
      )}
    </div>
  );
};

const CastEditor: React.FC<{
  member: CastMember;
  cast: CastMember[];
  library: LibraryCharacterSummary[];
  onChange: (m: CastMember) => void;
  onRemove: () => void;
  onDesignVoice: () => void;
}> = ({ member: m, cast, library, onChange, onRemove, onDesignVoice }) => {
  const set = (p: Partial<CastMember>) => onChange({ ...m, ...p });
  const others = cast.filter((x) => x.id !== m.id);
  const dynamicWith = (id: string) => m.relationships.find((r) => r.with === id)?.dynamic ?? "";
  const setDynamic = (id: string, dynamic: string) =>
    set({ relationships: [...m.relationships.filter((r) => r.with !== id), { with: id, dynamic }] });
  const linked = library.find((l) => l.library_id === m.library_id);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Field label="Name">
        <input className="input" value={m.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>

      <Field label="Voice">
        <div style={{ display: "flex", gap: 8 }}>
          <select className="select" value={m.library_id ?? ""} onChange={(e) => set({ library_id: e.target.value || null })}>
            <option value="">No voice yet</option>
            {library.map((l) => (
              <option key={l.library_id} value={l.library_id}>
                {l.name} · {l.palette_count} approved take{l.palette_count !== 1 ? "s" : ""}
              </option>
            ))}
            {m.library_id && !linked && <option value={m.library_id}>(new entry)</option>}
          </select>
          <button className="btn" style={{ whiteSpace: "nowrap" }} onClick={onDesignVoice}>
            {m.library_id ? "Edit voice →" : "Design voice →"}
          </button>
        </div>
        {linked && linked.palette_count === 0 && (
          <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4 }}>
            No approved takes. <a onClick={onDesignVoice} style={linkStyle}>Approve one</a>
          </div>
        )}
      </Field>

      <Field label="Description">
        <textarea className="textarea" style={{ minHeight: 60 }} value={m.description}
          onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <TwoCol>
        <Field label="Want">
          <textarea className="textarea" style={{ minHeight: 60 }} value={m.want} onChange={(e) => set({ want: e.target.value })} />
        </Field>
        <Field label="Flaw">
          <textarea className="textarea" style={{ minHeight: 60 }} value={m.flaw} onChange={(e) => set({ flaw: e.target.value })} />
        </Field>
      </TwoCol>
      <Field label="Engine">
        <textarea className="textarea" style={{ minHeight: 60 }} value={m.engine} onChange={(e) => set({ engine: e.target.value })} />
      </Field>
      <Field label="How they talk">
        <textarea className="textarea" style={{ minHeight: 60 }} value={m.voice_notes} onChange={(e) => set({ voice_notes: e.target.value })} />
      </Field>
      <TwoCol>
        <Field label="Catchphrases" hint="One per line.">
          <LinesInput minHeight={80} value={m.catchphrases} onChange={(catchphrases) => set({ catchphrases })} />
        </Field>
        <Field label="Signature bits" hint="One per line.">
          <LinesInput minHeight={80} value={m.lazzi} onChange={(lazzi) => set({ lazzi })} />
        </Field>
      </TwoCol>
      <Field label="Never">
        <textarea className="textarea" style={{ minHeight: 50 }} value={m.never} onChange={(e) => set({ never: e.target.value })} />
      </Field>

      {others.length > 0 && (
        <Field label="Relationships">
          <div style={{ display: "grid", gap: 6 }}>
            {others.map((o) => (
              <div key={o.id} style={{ display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {o.name || "Unnamed"}
                </span>
                <input className="input" value={dynamicWith(o.id)} onChange={(e) => setDynamic(o.id, e.target.value)}
                />
              </div>
            ))}
          </div>
        </Field>
      )}

      <div>
        <button className="btn btn-sm" onClick={onRemove} style={{ color: "var(--sfx)" }}>Remove from cast</button>
      </div>
    </div>
  );
};
