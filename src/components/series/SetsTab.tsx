import React from "react";
import type { Series, SeriesSet } from "../../lib/types";
import { Empty, Field, SectionTitle, TwoCol, linkStyle, uniqueSlug } from "./seriesUi";
import { newCue } from "./SoundTab";

// Recurring locations. The writer uses a set's heading exactly and opens
// the scene with its bed: the recorded one (`BED: #tag`) when the set links a
// sound cue, else the bed prompt.

export const SetsTab: React.FC<{ series: Series; patch: (p: Partial<Series>) => void; onGoToSound: () => void }> = ({ series, patch, onGoToSound }) => {
  const setSet = (id: string, p: Partial<SeriesSet>) =>
    patch({ sets: series.sets.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  const add = () => {
    const n = series.sets.length + 1;
    patch({
      sets: [...series.sets, {
        id: uniqueSlug(`set ${n}`, series.sets.map((s) => s.id)), name: "", heading: "INT. ", description: "", bed: "", bed_sound: null,
      }],
    });
  };
  const beds = series.sounds.filter((c) => c.kind === "bed");

  // Turn the bed prompt into a sound cue so it can be recorded once.
  const recordBed = (s: SeriesSet) => {
    const cue = newCue("bed", `${s.name || s.id} bed`, series.sounds.map((c) => c.id), s.bed);
    patch({ sounds: [...series.sounds, cue], sets: series.sets.map((x) => (x.id === s.id ? { ...x, bed_sound: cue.id } : x)) });
    onGoToSound();
  };

  return (
    <div>
      <SectionTitle right={<button className="btn btn-sm" onClick={add}>+ Set</button>}>Sets</SectionTitle>
      {series.sets.length === 0 ? (
        <Empty>Where the show keeps happening: the apartment, the bar, the lab. Each set gets a heading and its own sound.</Empty>
      ) : series.sets.map((s) => (
        <div key={s.id} style={{ padding: 16, border: "1px solid var(--line-1)", borderRadius: 4, background: "var(--bg-2)", marginBottom: 12 }}>
          <TwoCol>
            <Field label="Name">
              <input className="input" value={s.name} placeholder="Food court"
                onChange={(e) => setSet(s.id, { name: e.target.value })} />
            </Field>
            <Field label="Heading" hint="Fountain scene heading.">
              <input className="input mono" value={s.heading} placeholder="INT. FOOD COURT - NIGHT"
                onChange={(e) => setSet(s.id, { heading: e.target.value.toUpperCase() })} />
            </Field>
          </TwoCol>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <Field label="Description">
              <input className="input" value={s.description} placeholder="What's here, what it feels like"
                onChange={(e) => setSet(s.id, { description: e.target.value })} />
            </Field>
            <TwoCol>
              <Field label="Bed" hint="Ambience prompt.">
                <input className="input" value={s.bed} placeholder="empty mall at night, fluorescent hum"
                  onChange={(e) => setSet(s.id, { bed: e.target.value })} />
              </Field>
              <Field label="Recorded bed">
                <select className="select" value={s.bed_sound ?? ""} onChange={(e) => setSet(s.id, { bed_sound: e.target.value || null })}>
                  <option value="">None (generate per episode)</option>
                  {beds.map((c) => <option key={c.id} value={c.id}>{c.label || c.id}{c.file ? "" : " (no take yet)"}</option>)}
                </select>
                {!s.bed_sound && s.bed.trim() && (
                  <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4 }}>
                    <a onClick={() => recordBed(s)} style={linkStyle}>Record this bed once</a> so every episode sounds like the same room.
                  </div>
                )}
              </Field>
            </TwoCol>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-sm" style={{ color: "var(--sfx)" }}
              onClick={() => patch({ sets: series.sets.filter((x) => x.id !== s.id) })}>Remove</button>
          </div>
        </div>
      ))}
    </div>
  );
};
