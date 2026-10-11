import React, { useEffect, useState } from "react";
import { getProject, listScenes, readFountain, readScript } from "../../lib/tauriCommands";
import { rowsToBlocks, serializeFountain } from "../../lib/fountain";
import { reportError } from "../../lib/errors";
import type { Project, Scene, Series, SeriesStyle } from "../../lib/types";
import { Empty, Field, LinesInput, SectionTitle, TwoCol } from "./seriesUi";

export const StyleTab: React.FC<{ series: Series; episodes: Project[]; patch: (p: Partial<Series>) => void }> = ({ series, episodes, patch }) => {
  const st = series.style;
  const set = (p: Partial<SeriesStyle>) => patch({ style: { ...st, ...p } });
  const setGolden = (i: number, p: Partial<SeriesStyle["golden"][number]>) =>
    set({ golden: st.golden.map((g, j) => (j === i ? { ...g, ...p } : g)) });

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <TwoCol>
        <Field label="Narrator">
          <select className="select" value={st.narrator || "none"} onChange={(e) => set({ narrator: e.target.value })}>
            <option value="none">None (dialogue and sound only)</option>
            <option value="cold_open">Cold open and tag only</option>
            <option value="full">Throughout</option>
          </select>
        </Field>
        {st.narrator && st.narrator !== "none" ? (
          <Field label="Narrator name">
            <input className="input" value={st.narrator_name} placeholder="NARRATOR" onChange={(e) => set({ narrator_name: e.target.value })} />
          </Field>
        ) : <div />}
        <Field label="Rating">
          <input className="input" value={st.rating} onChange={(e) => set({ rating: e.target.value })} />
        </Field>
      </TwoCol>
      <Field label="House style">
        <textarea className="textarea" value={st.house_style} onChange={(e) => set({ house_style: e.target.value })} />
      </Field>
      <Field label="Never write" hint="One per line.">
        <LinesInput value={st.banned} onChange={(banned) => set({ banned })} />
      </Field>

      <div>
        <SectionTitle right={
          <span style={{ display: "flex", gap: 6 }}>
            <GoldenPicker episodes={episodes} onPick={(g) => set({ golden: [...st.golden, g] })} />
            <button className="btn btn-sm" onClick={() => set({ golden: [...st.golden, { title: "", note: "", fountain: "" }] })}>+ Paste a scene</button>
          </span>
        }>
          Golden scenes
        </SectionTitle>
        {st.golden.length === 0 ? (
          <Empty>No golden scenes.</Empty>
        ) : st.golden.map((g, i) => (
          <div key={i} style={{ padding: 14, border: "1px solid var(--line-1)", borderRadius: 4, background: "var(--bg-2)", marginBottom: 10 }}>
            <TwoCol>
              <Field label="Title"><input className="input" value={g.title} onChange={(e) => setGolden(i, { title: e.target.value })} /></Field>
              <Field label="Why it works"><input className="input" value={g.note} onChange={(e) => setGolden(i, { note: e.target.value })} /></Field>
            </TwoCol>
            <div style={{ marginTop: 10 }}>
              <textarea className="textarea" style={{ minHeight: 160, fontFamily: "var(--font-mono)", fontSize: 11 }} value={g.fountain}
                onChange={(e) => setGolden(i, { fountain: e.target.value })} placeholder="Fountain" />
            </div>
            <button className="btn btn-sm" style={{ marginTop: 8, color: "var(--sfx)" }}
              onClick={() => set({ golden: st.golden.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Pick an episode scene; its Fountain (saved, or rebuilt from the script rows) becomes a golden scene. */
const GoldenPicker: React.FC<{ episodes: Project[]; onPick: (g: { title: string; note: string; fountain: string }) => void }> = ({ episodes, onPick }) => {
  const [open, setOpen] = useState(false);
  const [epId, setEpId] = useState("");
  const [scenes, setScenes] = useState<Scene[]>([]);

  useEffect(() => {
    if (!epId) { setScenes([]); return; }
    listScenes(epId).then(setScenes).catch((e) => reportError("List scenes", e));
  }, [epId]);

  if (episodes.length === 0) return null;
  if (!open) return <button className="btn btn-sm" onClick={() => setOpen(true)}>+ From an episode</button>;

  const take = async (sc: Scene) => {
    try {
      let text = await readFountain({ projectId: epId, sceneSlug: sc.slug });
      if (!text) {
        const [project, rows] = await Promise.all([getProject(epId), readScript({ projectId: epId, sceneSlug: sc.slug })]);
        text = `${sc.description || sc.title}\n\n${serializeFountain(rowsToBlocks(rows, project.characters))}`;
      }
      const ep = episodes.find((e) => e.id === epId);
      onPick({ title: `${ep?.title ?? "Episode"} — ${sc.title}`, note: "", fountain: text.trim() });
      setOpen(false); setEpId("");
    } catch (e) {
      reportError("Read scene", e);
    }
  };

  return (
    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select className="select" style={{ fontSize: 11, padding: "4px 8px" }} value={epId} onChange={(e) => setEpId(e.target.value)}>
        <option value="">Episode…</option>
        {episodes.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
      </select>
      {scenes.length > 0 && (
        <select className="select" style={{ fontSize: 11, padding: "4px 8px" }} value=""
          onChange={(e) => { const sc = scenes.find((s) => s.slug === e.target.value); if (sc) take(sc); }}>
          <option value="">Scene…</option>
          {scenes.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}
        </select>
      )}
      <button className="btn btn-sm" onClick={() => { setOpen(false); setEpId(""); }}>×</button>
    </span>
  );
};
