import React, { useState } from "react";
import { createSeries, draftSeriesBible } from "../../lib/tauriCommands";
import { errorMessage } from "../../lib/errors";
import { SERIES_FORMATS, formatLabel } from "../../lib/archetypes";
import { useSeriesStore } from "../../store/seriesStore";
import type { Project, Series } from "../../lib/types";

// Left column of the launcher: series. Clicking one opens its Series home;
// episodes never appear in the one-shot column.

const NewSeriesForm: React.FC<{ onCreated: (s: Series) => void; onCancel: () => void }> = ({ onCreated, onCancel }) => {
  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [format, setFormat] = useState("sitcom");
  const [pitch, setPitch] = useState("");
  const [busy, setBusy] = useState<"" | "create" | "draft">("");
  const [err, setErr] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim()) { setErr("Title is required."); return; }
    setBusy("create"); setErr(null);
    let created: Series | null = null;
    try {
      created = await createSeries({ title: title.trim(), logline, format });
      if (pitch.trim()) {
        setBusy("draft");
        created = await draftSeriesBible(created.id, pitch);
      }
      onCreated(created);
    } catch (e) {
      // The series exists even if drafting failed; open it and say why.
      if (created) { window.alert(`The series was created, but drafting its bible failed: ${errorMessage(e)}`); onCreated(created); }
      else setErr(String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div style={{
      padding: "24px", borderRadius: 4, marginBottom: 20,
      border: "1px solid var(--music)",
      background: "color-mix(in oklch, var(--music) 5%, var(--bg-2))",
    }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)", marginBottom: 16 }}>New series</div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Title *</label>
        <input
          className="input" autoFocus value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") onCancel(); }}
          placeholder="The Night Shift"
          style={{ width: "100%", fontSize: 14 }}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Logline</label>
        <input
          className="input" value={logline}
          onChange={(e) => setLogline(e.target.value)}
          placeholder="Three security guards, one haunted mall, every night."
          style={{ width: "100%", fontSize: 12 }}
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Format</label>
        <select className="select" value={format} onChange={(e) => setFormat(e.target.value)} style={{ fontSize: 12 }}>
          {SERIES_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Describe the show <span style={{ textTransform: "none", letterSpacing: 0 }}>(optional: Claude drafts the bible)</span></label>
        <textarea
          className="textarea" value={pitch} onChange={(e) => setPitch(e.target.value)}
          placeholder="Who's in it, where it happens, what keeps going wrong, what it should feel like."
          style={{ minHeight: 80, fontSize: 12 }}
        />
      </div>
      {err && <div style={{ fontSize: 11, color: "var(--sfx)", marginBottom: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="btn btn-primary" onClick={handleCreate} disabled={!!busy}
          style={{ background: "var(--music)", borderColor: "var(--music)", color: "var(--bg-0)" }}
        >
          {busy === "draft" ? "Drafting the bible…" : busy ? "Creating…" : pitch.trim() ? "Create and draft" : "Create series"}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

const SeriesCard: React.FC<{ series: Series; episodes: number; onOpen: () => void }> = ({ series, episodes, onOpen }) => (
  <div
    onClick={onOpen}
    style={{
      padding: "16px 20px", marginBottom: 10,
      border: "1px solid var(--line-1)", borderRadius: 3,
      background: "var(--bg-2)", cursor: "pointer",
      transition: "border-color 0.1s, background 0.1s",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = "var(--music)";
      e.currentTarget.style.background = "color-mix(in oklch, var(--music) 4%, var(--bg-2))";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = "var(--line-1)";
      e.currentTarget.style.background = "var(--bg-2)";
    }}
  >
    <div style={{ fontWeight: 600, fontSize: 15, color: "var(--fg-0)", marginBottom: 4 }}>{series.title}</div>
    {series.logline && (
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
        {series.logline.slice(0, 140)}{series.logline.length > 140 ? "…" : ""}
      </div>
    )}
    <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {series.format && (
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.04em",
          color: "var(--music)", background: "color-mix(in oklch, var(--music) 10%, transparent)",
          padding: "1px 6px", borderRadius: 2,
        }}>{formatLabel(series.format)}</span>
      )}
      <span style={metaStyle}>{series.cast.length} in cast</span>
      <span style={metaStyle}>{episodes} episode{episodes !== 1 ? "s" : ""}</span>
    </div>
  </div>
);

export const SeriesColumn: React.FC<{ series: Series[]; projects: Project[]; loading: boolean }> = ({ series, projects, loading }) => {
  const [showNew, setShowNew] = useState(false);
  const openSeries = useSeriesStore((s) => s.openSeries);
  const episodeCount = (id: string) => projects.filter((p) => p.series_id === id).length;

  return (
    <div>
      {showNew && (
        <NewSeriesForm onCreated={(s) => openSeries(s.id)} onCancel={() => setShowNew(false)} />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, minHeight: 28 }}>
        <span style={headerStyle}>{loading ? "Loading…" : `Series · ${series.length}`}</span>
        {!showNew && (
          <button
            className="btn btn-primary" onClick={() => setShowNew(true)}
            style={{ background: "var(--music)", borderColor: "var(--music)", color: "var(--bg-0)", fontSize: 12 }}
          >
            + New series
          </button>
        )}
      </div>

      {!loading && series.length === 0 && !showNew && (
        <div style={{
          padding: "40px 24px", textAlign: "center",
          border: "1px dashed var(--line-2)", borderRadius: 3,
          fontSize: 12, color: "var(--fg-4)", lineHeight: 1.7,
        }}>
          A series keeps a cast, a world and a house style,
          <br />so every episode sounds like the same show.
          <br />
          <button className="btn" onClick={() => setShowNew(true)} style={{ marginTop: 12 }}>
            Start a series →
          </button>
        </div>
      )}

      {series.map((s) => (
        <SeriesCard key={s.id} series={s} episodes={episodeCount(s.id)} onOpen={() => openSeries(s.id)} />
      ))}
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
const headerStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
  color: "var(--fg-4)", textTransform: "uppercase",
};
const metaStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.04em", color: "var(--fg-4)",
};
