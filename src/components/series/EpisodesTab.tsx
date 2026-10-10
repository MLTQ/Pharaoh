import React, { useEffect, useState } from "react";
import { createSeriesEpisode, pitchEpisodes, planEpisode } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { useSeriesStore } from "../../store/seriesStore";
import type { EpisodePitch, EpisodePlan, Project, Series } from "../../lib/types";
import { Card, Empty, Field, LinesInput, SectionTitle, TwoCol, linkStyle, monoMeta, primaryBtn } from "./seriesUi";

// The writers' room. Premise (typed or pitched) → optional beat sheet the
// user can edit → write. Writing runs in seriesStore so it survives tab and
// view changes; a toast offers to open the episode when it lands.

export const EpisodesTab: React.FC<{
  series: Series;
  episodes: Project[];
  onOpen: (id: string) => void;
  beforeCreate: () => Promise<void>;
  onGoTo: (tab: "cast" | "voices") => void;
}> = ({ series, episodes, onOpen, beforeCreate, onGoTo }) => {
  const writing = useSeriesStore((s) => s.writing[series.id]);
  const startWrite = useSeriesStore((s) => s.startWrite);
  const [premise, setPremise] = useState("");
  const [pitches, setPitches] = useState<EpisodePitch[]>([]);
  const [plan, setPlan] = useState<EpisodePlan | null>(null);
  const [punchUp, setPunchUp] = useState(true);
  const [busy, setBusy] = useState<"pitch" | "plan" | "blank" | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!writing) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - writing.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [writing]);

  const unvoiced = series.cast.filter((m) => !m.library_id);

  const pitch = async () => {
    setBusy("pitch");
    try {
      await beforeCreate();
      setPitches(await pitchEpisodes(series.id, premise.trim() || undefined));
    } catch (e) { reportError("Pitch", e); } finally { setBusy(null); }
  };

  const breakStory = async () => {
    setBusy("plan");
    try {
      await beforeCreate();
      setPlan(await planEpisode(series.id, premise));
    } catch (e) { reportError("Beat sheet", e); } finally { setBusy(null); }
  };

  const write = async (withPlan: EpisodePlan | null) => {
    await beforeCreate();
    const r = await startWrite({ series_id: series.id, premise, plan: withPlan, punch_up: punchUp });
    if (r) { setPlan(null); setPitches([]); setPremise(""); }
  };

  const blank = async () => {
    setBusy("blank");
    try {
      await beforeCreate();
      const p = await createSeriesEpisode({ seriesId: series.id, logline: premise });
      onOpen(p.id);
    } catch (e) { reportError("New episode", e); } finally { setBusy(null); }
  };

  return (
    <div>
      {writing ? (
        <Card accent>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: "var(--music)", animation: "pulse 1.2s ease-in-out infinite" }} />
            <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--fg-0)" }}>{writing.message}…</span>
            <span style={monoMeta}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>
            Planning, writing and a writers' room pass usually take a few minutes. You can keep editing the bible or leave; a notice appears when it's done.
          </div>
        </Card>
      ) : plan ? (
        <PlanEditor plan={plan} setPlan={setPlan} series={series} onWrite={() => write(plan)} onBack={() => setPlan(null)} onReplan={breakStory} replanning={busy === "plan"} punchUp={punchUp} setPunchUp={setPunchUp} />
      ) : (
        <Card>
          <SectionTitle>Make an episode</SectionTitle>
          <Field label="Premise" hint="Optional. Leave empty and Claude picks.">
            <textarea className="textarea" style={{ minHeight: 64 }} value={premise} onChange={(e) => setPremise(e.target.value)}
              placeholder="The carousel starts taking requests." />
          </Field>
          {pitches.length > 0 && (
            <div style={{ display: "grid", gap: 8, margin: "12px 0 4px" }}>
              {pitches.map((p, i) => (
                <div key={i}
                  onClick={() => { setPremise(`${p.title}: ${p.logline}`); setPitches([]); }}
                  style={{ padding: "10px 12px", border: "1px solid var(--line-1)", borderRadius: 3, cursor: "pointer", background: "var(--bg-1)" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--music)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line-1)"; }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--fg-0)" }}>{p.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2, lineHeight: 1.5 }}>{p.logline}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <button className="btn btn-primary" style={primaryBtn} disabled={!!busy} onClick={() => write(null)}>
              Write episode
            </button>
            <button className="btn" disabled={!!busy} onClick={breakStory}>{busy === "plan" ? "Breaking story…" : "Beat sheet first"}</button>
            <button className="btn" disabled={!!busy} onClick={pitch}>{busy === "pitch" ? "Pitching…" : premise.trim() ? "Pitch around this" : "Pitch me three"}</button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-3)", marginLeft: 4 }}>
              <input type="checkbox" checked={punchUp} onChange={(e) => setPunchUp(e.target.checked)} />
              Writers' room pass
            </label>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 10, lineHeight: 1.6 }}>
            {series.cast.length === 0 ? (
              <>No cast yet. <a onClick={() => onGoTo("cast")} style={linkStyle}>Add the troupe</a> first; the writer builds every scene from them.</>
            ) : unvoiced.length > 0 ? (
              <>{unvoiced.map((m) => m.name || "Unnamed").join(", ")} {unvoiced.length === 1 ? "has" : "have"} no voice yet and will join each episode as a blank character to design. <a onClick={() => onGoTo("cast")} style={linkStyle}>Give them one</a>.</>
            ) : (
              <>The whole cast joins with their library voices.</>
            )}
            {" "}Or <a onClick={blank} style={linkStyle}>{busy === "blank" ? "creating…" : "start a blank episode"}</a> and write it yourself.
          </div>
        </Card>
      )}

      <SectionTitle>Episodes</SectionTitle>
      {episodes.length === 0 ? (
        <Empty>No episodes yet.</Empty>
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
          <span style={{ ...monoMeta, color: "var(--music)", minWidth: 34 }}>{String(i + 1).padStart(2, "0")}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-0)" }}>{p.title}</div>
            {p.logline && <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, lineHeight: 1.5 }}>{p.logline}</div>}
          </div>
        </div>
      ))}
    </div>
  );
};

const PlanEditor: React.FC<{
  plan: EpisodePlan;
  setPlan: (p: EpisodePlan) => void;
  series: Series;
  onWrite: () => void;
  onBack: () => void;
  onReplan: () => void;
  replanning: boolean;
  punchUp: boolean;
  setPunchUp: (v: boolean) => void;
}> = ({ plan, setPlan, series, onWrite, onBack, onReplan, replanning, punchUp, setPunchUp }) => {
  const patch = (p: Partial<EpisodePlan>) => setPlan({ ...plan, ...p });
  const setScene = (i: number, p: Partial<EpisodePlan["scenes"][number]>) =>
    patch({ scenes: plan.scenes.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const setName = (id: string) => series.sets.find((s) => s.id === id)?.name;

  return (
    <Card accent>
      <SectionTitle right={<button className="btn btn-sm" onClick={onBack}>← Premise</button>}>Beat sheet</SectionTitle>
      <TwoCol>
        <Field label="Title"><input className="input" value={plan.title} onChange={(e) => patch({ title: e.target.value })} /></Field>
        <Field label="Logline"><input className="input" value={plan.logline} onChange={(e) => patch({ logline: e.target.value })} /></Field>
      </TwoCol>
      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {plan.scenes.map((s, i) => (
          <div key={i} style={{ padding: 12, border: "1px solid var(--line-1)", borderRadius: 3, background: "var(--bg-1)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ ...monoMeta, color: "var(--music)" }}>{s.act || `Scene ${i + 1}`}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)" }}>{s.heading}</span>
              {s.set_id && setName(s.set_id) && <span style={monoMeta}>set: {setName(s.set_id)}</span>}
              {s.characters.length > 0 && <span style={monoMeta}>{s.characters.join(", ")}</span>}
              <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                onClick={() => patch({ scenes: plan.scenes.filter((_, j) => j !== i) })}>Cut</button>
            </div>
            <textarea className="textarea" style={{ minHeight: 44 }} value={s.summary} onChange={(e) => setScene(i, { summary: e.target.value })} />
            <div style={{ marginTop: 6 }}>
              <LinesInput minHeight={60} value={s.beats} onChange={(beats) => setScene(i, { beats })} placeholder="One beat per line" />
            </div>
          </div>
        ))}
      </div>
      {plan.guests.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ ...monoMeta, textTransform: "uppercase", marginBottom: 6 }}>Guests</div>
          {plan.guests.map((g, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.6 }}>
              <b style={{ color: "var(--fg-0)" }}>{g.name}</b> — {g.description} <span style={{ color: "var(--fg-4)" }}>Voice: {g.voice}</span>
            </div>
          ))}
        </div>
      )}
      {plan.callbacks.length > 0 && (
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 10 }}>Pays off: {plan.callbacks.join("; ")}</div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
        <button className="btn btn-primary" style={primaryBtn} onClick={onWrite} disabled={plan.scenes.length === 0}>Write this episode</button>
        <button className="btn" onClick={onReplan} disabled={replanning}>{replanning ? "Breaking story…" : "Break it again"}</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-3)" }}>
          <input type="checkbox" checked={punchUp} onChange={(e) => setPunchUp(e.target.checked)} />
          Writers' room pass
        </label>
      </div>
    </Card>
  );
};
