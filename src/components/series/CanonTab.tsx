import React, { useEffect, useState } from "react";
import { listSeriesCanon, saveSeriesCanon } from "../../lib/tauriCommands";
import { reportError } from "../../lib/errors";
import { useSeriesStore } from "../../store/seriesStore";
import type { CanonEntry, Series } from "../../lib/types";
import { Empty, Field, LinesInput, SectionTitle, TwoCol, primaryBtn } from "./seriesUi";

// What each episode established. The writer appends an entry per episode;
// edits here are what the next episode's writer believes. Kept in canon.json,
// apart from series.json, so the writer and the bible autosave never collide.

export const CanonTab: React.FC<{ series: Series }> = ({ series }) => {
  const version = useSeriesStore((s) => s.episodesVersion);
  const [canon, setCanon] = useState<CanonEntry[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listSeriesCanon(series.id).then((c) => { setCanon(c); setDirty(false); }).catch((e) => reportError("Canon", e));
  }, [series.id, version]);

  if (!canon) return null;
  const set = (i: number, p: Partial<CanonEntry>) => { setCanon(canon.map((c, j) => (j === i ? { ...c, ...p } : c))); setDirty(true); };
  const save = async () => {
    setSaving(true);
    try {
      const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
      setCanon(await saveSeriesCanon(series.id, canon.map((c) => ({ ...c, facts: clean(c.facts), gags: clean(c.gags), threads: clean(c.threads) }))));
      setDirty(false);
    } catch (e) { reportError("Save canon", e); } finally { setSaving(false); }
  };

  return (
    <div>
      <SectionTitle right={dirty ? <button className="btn btn-primary" style={primaryBtn} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save canon"}</button> : undefined}>
        Canon
      </SectionTitle>
      {canon.length === 0 ? (
        <Empty>No canon.</Empty>
      ) : [...canon].map((c, i) => ({ c, i })).reverse().map(({ c, i }) => (
        <div key={c.episode_id || i} style={{ padding: 14, border: "1px solid var(--line-1)", borderRadius: 4, background: "var(--bg-2)", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--fg-0)" }}>{c.episode_title || "Episode"}</span>
            <button className="btn btn-sm" style={{ marginLeft: "auto", color: "var(--sfx)" }}
              onClick={() => { setCanon(canon.filter((_, j) => j !== i)); setDirty(true); }}>Forget</button>
          </div>
          <Field label="Summary">
            <textarea className="textarea" style={{ minHeight: 50 }} value={c.summary} onChange={(e) => set(i, { summary: e.target.value })} />
          </Field>
          <div style={{ marginTop: 10 }}>
            <TwoCol min={200}>
              <Field label="Facts"><LinesInput value={c.facts} onChange={(facts) => set(i, { facts })} /></Field>
              <Field label="Running gags"><LinesInput value={c.gags} onChange={(gags) => set(i, { gags })} /></Field>
              <Field label="Open threads"><LinesInput value={c.threads} onChange={(threads) => set(i, { threads })} /></Field>
            </TwoCol>
          </div>
        </div>
      ))}
    </div>
  );
};
