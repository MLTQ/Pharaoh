import React from "react";
import { FORMULA_PRESETS, SERIES_FORMATS, formatLabel } from "../../lib/archetypes";
import type { Series } from "../../lib/types";
import { Field, SectionTitle, TwoCol, monoMeta } from "./seriesUi";

export const BibleTab: React.FC<{ series: Series; patch: (p: Partial<Series>) => void }> = ({ series, patch }) => {
  const knownFormat = SERIES_FORMATS.some((f) => f.id === series.format);
  const preset = FORMULA_PRESETS[series.format];
  const setBeat = (i: number, p: Partial<Series["formula"][number]>) =>
    patch({ formula: series.formula.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  const move = (i: number, d: -1 | 1) => {
    const f = [...series.formula];
    const j = i + d;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    patch({ formula: f });
  };

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

      <div>
        <SectionTitle right={
          <span style={{ display: "flex", gap: 6 }}>
            {preset && (
              <button className="btn btn-sm"
                onClick={() => {
                  if (series.formula.length && !window.confirm("Replace the formula with the preset?")) return;
                  patch({ formula: preset.map((b) => ({ ...b })) });
                }}
              >
                Load {formatLabel(series.format).toLowerCase()} preset
              </button>
            )}
            <button className="btn btn-sm" onClick={() => patch({ formula: [...series.formula, { name: "", description: "" }] })}>+ Beat</button>
          </span>
        }>
          Formula
        </SectionTitle>
        {series.formula.length === 0 ? (
          <div style={{ fontSize: 11.5, color: "var(--fg-4)" }}>
            Empty: the writer uses the classic shape of a {formatLabel(series.format || "series").toLowerCase()}.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {series.formula.map((b, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "28px 180px minmax(0, 1fr) auto", gap: 8, alignItems: "center" }}>
                <span style={{ ...monoMeta, color: "var(--music)" }}>{i + 1}</span>
                <input className="input" value={b.name} placeholder="Beat" onChange={(e) => setBeat(i, { name: e.target.value })} />
                <input className="input" value={b.description} placeholder="What happens here" onChange={(e) => setBeat(i, { description: e.target.value })} />
                <span style={{ display: "flex", gap: 2 }}>
                  <button className="btn btn-sm" onClick={() => move(i, -1)} title="Move up">↑</button>
                  <button className="btn btn-sm" onClick={() => move(i, 1)} title="Move down">↓</button>
                  <button className="btn btn-sm" onClick={() => patch({ formula: series.formula.filter((_, j) => j !== i) })} title="Remove">×</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
