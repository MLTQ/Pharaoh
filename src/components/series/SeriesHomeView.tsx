import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  createSeriesEpisode, getSeries, listLibraryCharacters, listSeriesEpisodes, updateSeries,
} from "../../lib/tauriCommands";
import {
  ARCHETYPES, ARCHETYPE_FAMILIES, SERIES_FORMATS, applyArchetype, blankCastMember, formatLabel,
} from "../../lib/archetypes";
import { openProjectById } from "../../lib/openProject";
import { reportError } from "../../lib/errors";
import { useSeriesStore } from "../../store/seriesStore";
import type { CastMember, LibraryCharacterSummary, Project, Series } from "../../lib/types";

// Series home: the show bible above its episodes. Edits autosave to
// series.json. An episode opens in the ordinary project workspace.

type Tab = "episodes" | "bible" | "cast";

/** Drop the blank lines left by one-item-per-line editing. */
function clean(s: Series): Series {
  const nonEmpty = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return {
    ...s,
    themes: nonEmpty(s.themes),
    cast: s.cast.map((m) => ({
      ...m,
      catchphrases: nonEmpty(m.catchphrases),
      lazzi: nonEmpty(m.lazzi),
      relationships: m.relationships.filter((r) => r.dynamic.trim()),
    })),
  };
}

export const SeriesHomeView: React.FC<{ seriesId: string }> = ({ seriesId }) => {
  const closeSeries = useSeriesStore((s) => s.closeSeries);
  const [draft, setDraft] = useState<Series | null>(null);
  const [episodes, setEpisodes] = useState<Project[]>([]);
  const [library, setLibrary] = useState<LibraryCharacterSummary[]>([]);
  const [tab, setTab] = useState<Tab>("episodes");
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [err, setErr] = useState<string | null>(null);
  const savedJson = useRef("");

  useEffect(() => {
    Promise.all([getSeries(seriesId), listSeriesEpisodes(seriesId)])
      .then(([s, eps]) => {
        savedJson.current = JSON.stringify(clean(s));
        setDraft(s);
        setEpisodes(eps);
        if (s.cast.length === 0) setTab("bible");
      })
      .catch((e) => setErr(String(e)));
    listLibraryCharacters().then(setLibrary).catch((e) => reportError("List library", e));
  }, [seriesId]);

  const save = useCallback(async (s: Series) => {
    const c = clean(s);
    const json = JSON.stringify(c);
    if (json === savedJson.current) { setSaveState("saved"); return; }
    setSaveState("saving");
    try {
      await updateSeries(c);
      savedJson.current = json;
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      reportError("Save series", e);
    }
  }, []);

  // Debounced autosave.
  useEffect(() => {
    if (!draft) return;
    if (JSON.stringify(clean(draft)) === savedJson.current) return;
    setSaveState("pending");
    const t = setTimeout(() => save(draft), 700);
    return () => clearTimeout(t);
  }, [draft, save]);

  const patch = (p: Partial<Series>) => setDraft((d) => (d ? { ...d, ...p } : d));

  if (err) {
    return (
      <Shell>
        <button className="btn btn-sm" onClick={closeSeries}>← All projects</button>
        <div style={{ marginTop: 16, fontSize: 12, color: "var(--sfx)" }}>{err}</div>
      </Shell>
    );
  }
  if (!draft) return <Shell><div style={{ fontSize: 12, color: "var(--fg-4)" }}>Loading…</div></Shell>;

  const openEpisode = async (id: string) => {
    await save(draft);
    try { await openProjectById(id); } catch (e) { reportError("Open episode", e); }
  };

  return (
    <Shell>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <button className="btn btn-sm" onClick={async () => { await save(draft); closeSeries(); }}>
          ← All projects
        </button>
        <span style={{ ...monoMeta, color: saveState === "error" ? "var(--sfx)" : "var(--fg-4)" }}>
          {saveState === "saved" ? "saved" : saveState === "error" ? "save failed" : "saving…"}
        </span>
      </div>
      <div style={{ ...monoMeta, color: "var(--music)", textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 4 }}>
        Series · {formatLabel(draft.format)}
      </div>
      <div style={{ fontWeight: 600, fontSize: 26, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>{draft.title}</div>
      {draft.logline && <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.5 }}>{draft.logline}</div>}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, margin: "22px 0 20px", borderBottom: "1px solid var(--line-1)" }}>
        {([
          ["episodes", `Episodes · ${episodes.length}`],
          ["bible", "Bible"],
          ["cast", `Cast · ${draft.cast.length}`],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "8px 14px", marginBottom: -1, fontSize: 12.5,
              color: tab === id ? "var(--fg-0)" : "var(--fg-3)",
              borderBottom: `2px solid ${tab === id ? "var(--music)" : "transparent"}`,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "episodes" && (
        <EpisodesTab
          series={draft}
          episodes={episodes}
          onOpen={openEpisode}
          onCreated={async (p) => { setEpisodes((e) => [...e, p]); await openEpisode(p.id); }}
          beforeCreate={() => save(draft)}
          onGoToCast={() => setTab("cast")}
        />
      )}
      {tab === "bible" && <BibleTab series={draft} patch={patch} />}
      {tab === "cast" && <CastTab series={draft} library={library} patch={patch} />}
    </Shell>
  );
};

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--bg-0)" }}>
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 24px 60px" }}>{children}</div>
  </div>
);

// ── Episodes ──────────────────────────────────────────────────────────────────

const EpisodesTab: React.FC<{
  series: Series;
  episodes: Project[];
  onOpen: (id: string) => void;
  onCreated: (p: Project) => void;
  beforeCreate: () => Promise<void>;
  onGoToCast: () => void;
}> = ({ series, episodes, onOpen, onCreated, beforeCreate, onGoToCast }) => {
  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [busy, setBusy] = useState(false);
  const unvoiced = series.cast.filter((m) => !m.library_id);

  const create = async () => {
    setBusy(true);
    try {
      await beforeCreate();
      const p = await createSeriesEpisode({ seriesId: series.id, title: title.trim() || undefined, logline });
      setTitle(""); setLogline("");
      onCreated(p);
    } catch (e) {
      reportError("New episode", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{
        padding: 20, borderRadius: 4, marginBottom: 24,
        border: "1px solid var(--line-1)", background: "var(--bg-2)",
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)", marginBottom: 12 }}>New episode</div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={`Episode ${episodes.length + 1}`} />
          </div>
          <div>
            <label style={labelStyle}>Premise</label>
            <input className="input" value={logline} onChange={(e) => setLogline(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) create(); }}
              placeholder="What happens this week?" />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary" disabled={busy} onClick={create}
            style={{ background: "var(--music)", borderColor: "var(--music)", color: "var(--bg-0)" }}
          >
            {busy ? "Creating…" : "Create episode"}
          </button>
          <span style={{ fontSize: 11, color: "var(--fg-4)", lineHeight: 1.5 }}>
            {series.cast.length === 0 ? (
              <>No cast yet. <a href="#" onClick={(e) => { e.preventDefault(); onGoToCast(); }} style={linkStyle}>Add the troupe</a> so episodes start with their voices.</>
            ) : unvoiced.length > 0 ? (
              <>{unvoiced.map((m) => m.name || "Unnamed").join(", ")} {unvoiced.length === 1 ? "has" : "have"} no library voice and won't be added.</>
            ) : (
              <>The whole cast joins with their library voices.</>
            )}
          </span>
        </div>
      </div>

      {episodes.length === 0 ? (
        <div style={{
          padding: "36px 24px", textAlign: "center", border: "1px dashed var(--line-2)",
          borderRadius: 3, fontSize: 12, color: "var(--fg-4)",
        }}>
          No episodes yet.
        </div>
      ) : episodes.map((p, i) => (
        <div
          key={p.id}
          onClick={() => onOpen(p.id)}
          style={{
            display: "flex", gap: 16, alignItems: "baseline",
            padding: "14px 18px", marginBottom: 8, cursor: "pointer",
            border: "1px solid var(--line-1)", borderRadius: 3, background: "var(--bg-2)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--music)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line-1)"; }}
        >
          <span style={{ ...monoMeta, color: "var(--music)", minWidth: 34 }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)" }}>{p.title}</div>
            {p.logline && <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, lineHeight: 1.5 }}>{p.logline}</div>}
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Bible ─────────────────────────────────────────────────────────────────────

const BibleTab: React.FC<{ series: Series; patch: (p: Partial<Series>) => void }> = ({ series, patch }) => {
  const knownFormat = SERIES_FORMATS.some((f) => f.id === series.format);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <TwoCol>
        <Field label="Title">
          <input className="input" value={series.title} onChange={(e) => patch({ title: e.target.value })} />
        </Field>
        <Field label="Format">
          <div style={{ display: "flex", gap: 8 }}>
            <select
              className="select" value={knownFormat ? series.format : "__custom"}
              onChange={(e) => patch({ format: e.target.value === "__custom" ? "" : e.target.value })}
            >
              {SERIES_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              <option value="__custom">Other…</option>
            </select>
            {!knownFormat && (
              <input className="input" value={series.format} placeholder="e.g. Radio serial"
                onChange={(e) => patch({ format: e.target.value })} />
            )}
          </div>
        </Field>
      </TwoCol>
      <Field label="Logline">
        <input className="input" value={series.logline} onChange={(e) => patch({ logline: e.target.value })}
          placeholder="One sentence that sells the show." />
      </Field>
      <Field label="Premise" hint="The situation that keeps producing episodes.">
        <textarea className="textarea" value={series.premise} onChange={(e) => patch({ premise: e.target.value })}
          placeholder="Who is stuck together, where, and why can't they leave?" />
      </Field>
      <TwoCol>
        <Field label="Tone">
          <input className="input" value={series.tone} onChange={(e) => patch({ tone: e.target.value })}
            placeholder="e.g. Warm, fast, a little macabre" />
        </Field>
        <Field label="Themes" hint="Comma separated.">
          <input
            className="input" value={series.themes.join(", ")}
            onChange={(e) => patch({ themes: e.target.value.split(",") })}
            placeholder="found family, ambition, the cost of lying"
          />
        </Field>
      </TwoCol>
      <Field label="World" hint="Setting, recurring places and the rules that never bend.">
        <textarea className="textarea" style={{ minHeight: 160 }} value={series.world}
          onChange={(e) => patch({ world: e.target.value })} />
      </Field>
      <TwoCol>
        <Field label="Continuity">
          <div style={{ display: "flex", gap: 8 }}>
            {([["episodic", "Episodic", "Status quo resets each episode"], ["serialized", "Serialized", "Events carry forward"]] as const).map(([id, label, title]) => (
              <button
                key={id} title={title} className="btn"
                onClick={() => patch({ continuity: id })}
                style={series.continuity === id ? { borderColor: "var(--music)", color: "var(--fg-0)" } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Episode length (minutes)">
          <input
            className="input" type="number" min={1} max={120} value={series.episode_minutes || ""}
            onChange={(e) => patch({ episode_minutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
        </Field>
      </TwoCol>
    </div>
  );
};

// ── Cast ──────────────────────────────────────────────────────────────────────

const CastTab: React.FC<{
  series: Series;
  library: LibraryCharacterSummary[];
  patch: (p: Partial<Series>) => void;
}> = ({ series, library, patch }) => {
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
              {m.archetype || "no archetype"} · {m.library_id ? "voiced" : "no voice"}
            </div>
          </div>
        ))}
        <button className="btn" onClick={add} style={{ width: "100%", marginTop: 4 }}>+ Add character</button>
      </div>

      {sel ? (
        <CastEditor
          key={sel.id} member={sel} cast={series.cast} library={library}
          onChange={setMember} onRemove={() => remove(sel)}
        />
      ) : (
        <div style={{
          padding: "36px 24px", textAlign: "center", border: "1px dashed var(--line-2)",
          borderRadius: 3, fontSize: 12, color: "var(--fg-4)", lineHeight: 1.7,
        }}>
          The troupe: the characters every episode is built from.
          <br />Start blank or from a stock type.
        </div>
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
}> = ({ member: m, cast, library, onChange, onRemove }) => {
  const set = (p: Partial<CastMember>) => onChange({ ...m, ...p });
  const lines = (xs: string[]) => xs.join("\n");
  const others = cast.filter((x) => x.id !== m.id);
  const dynamicWith = (id: string) => m.relationships.find((r) => r.with === id)?.dynamic ?? "";
  const setDynamic = (id: string, dynamic: string) =>
    set({ relationships: [...m.relationships.filter((r) => r.with !== id), { with: id, dynamic }] });
  const linked = library.find((l) => l.library_id === m.library_id);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <TwoCol>
        <Field label="Name">
          <input className="input" value={m.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Archetype" hint="Fills empty fields only.">
          <select
            className="select" value={ARCHETYPES.some((a) => a.name === m.archetype) ? m.archetype : ""}
            onChange={(e) => {
              const a = ARCHETYPES.find((x) => x.name === e.target.value);
              onChange(a ? applyArchetype(m, a) : { ...m, archetype: "" });
            }}
          >
            <option value="">{m.archetype && !ARCHETYPES.some((a) => a.name === m.archetype) ? m.archetype : "None"}</option>
            {ARCHETYPE_FAMILIES.map((f) => (
              <optgroup key={f} label={f}>
                {ARCHETYPES.filter((a) => a.family === f).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
      </TwoCol>

      <Field label="Voice" hint="A character-library entry. Its approved takes are copied into each new episode.">
        <select className="select" value={m.library_id ?? ""} onChange={(e) => set({ library_id: e.target.value || null })}>
          <option value="">No voice yet</option>
          {library.map((l) => (
            <option key={l.library_id} value={l.library_id}>
              {l.name} · {l.palette_count} approved take{l.palette_count !== 1 ? "s" : ""}
            </option>
          ))}
        </select>
        {m.library_id && !linked && (
          <div style={{ fontSize: 11, color: "var(--sfx)", marginTop: 4 }}>That library entry no longer exists.</div>
        )}
        {library.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4, lineHeight: 1.5 }}>
            The character library is empty. Design a voice in any project's Cast &amp; Voices and save it to the library.
          </div>
        )}
      </Field>

      <Field label="Description">
        <textarea className="textarea" style={{ minHeight: 60 }} value={m.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Age, job, look, the one-line pitch." />
      </Field>
      <TwoCol>
        <Field label="Want">
          <textarea className="textarea" style={{ minHeight: 60 }} value={m.want} onChange={(e) => set({ want: e.target.value })} />
        </Field>
        <Field label="Flaw">
          <textarea className="textarea" style={{ minHeight: 60 }} value={m.flaw} onChange={(e) => set({ flaw: e.target.value })} />
        </Field>
      </TwoCol>
      <Field label="Engine" hint="What reliably makes their scenes go.">
        <textarea className="textarea" style={{ minHeight: 60 }} value={m.engine} onChange={(e) => set({ engine: e.target.value })} />
      </Field>
      <Field label="How they talk" hint="Rhythm, vocabulary, tics.">
        <textarea className="textarea" style={{ minHeight: 60 }} value={m.voice_notes} onChange={(e) => set({ voice_notes: e.target.value })} />
      </Field>
      <TwoCol>
        <Field label="Catchphrases" hint="One per line.">
          <textarea className="textarea" style={{ minHeight: 80 }} value={lines(m.catchphrases)}
            onChange={(e) => set({ catchphrases: e.target.value.split("\n") })} />
        </Field>
        <Field label="Lazzi" hint="Signature bits, one per line.">
          <textarea className="textarea" style={{ minHeight: 80 }} value={lines(m.lazzi)}
            onChange={(e) => set({ lazzi: e.target.value.split("\n") })} />
        </Field>
      </TwoCol>
      <Field label="Never" hint="What they would never say or do.">
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
                  placeholder={`How ${m.name || "they"} treats ${o.name || "them"}`} />
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

// ── Bits ──────────────────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ minWidth: 0 }}>
    <label style={labelStyle}>
      {label}
      {hint && <span style={{ textTransform: "none", letterSpacing: 0, marginLeft: 8, color: "var(--fg-4)", opacity: 0.8 }}>{hint}</span>}
    </label>
    {children}
  </div>
);

const TwoCol: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>{children}</div>
);

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};
const monoMeta: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.04em", color: "var(--fg-4)",
};
const linkStyle: React.CSSProperties = { color: "var(--music)", textDecoration: "underline" };
