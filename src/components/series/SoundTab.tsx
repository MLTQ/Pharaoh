import React, { useCallback, useEffect, useState } from "react";
import { listSeriesSoundTakes } from "../../lib/tauriCommands";
import { cueEngine, generateSeriesSound, seriesSoundSlug } from "../../lib/seriesSound";
import { reportError } from "../../lib/errors";
import { useAudioStore } from "../../store/audioStore";
import { useJobStore } from "../../store/jobStore";
import type { Series, SoundCue, SoundTake } from "../../lib/types";
import { Empty, Field, SectionTitle, TwoCol, monoMeta, primaryBtn, uniqueSlug } from "./seriesUi";

// The show's recurring audio. Each cue gets takes generated into the series
// folder; the approved one is copied, bit-exact, into every episode scene
// whose script names it (`MUSIC: #theme`).

const KINDS: { id: string; label: string; hint: string }[] = [
  { id: "theme", label: "Theme", hint: "opening titles and closing" },
  { id: "stinger", label: "Stinger", hint: "act breaks, reveals" },
  { id: "bumper", label: "Bumper", hint: "scene transitions" },
  { id: "music", label: "Music", hint: "recurring cue" },
  { id: "bed", label: "Bed", hint: "a set's ambience" },
  { id: "sfx", label: "Effect", hint: "a recurring sound" },
];

export function newCue(kind: string, label: string, taken: string[], prompt = ""): SoundCue {
  return {
    id: uniqueSlug(label || kind, taken), kind, label, prompt,
    duration_seconds: kind === "theme" ? 20 : kind === "bed" ? 20 : kind === "stinger" ? 4 : kind === "bumper" ? 5 : kind === "sfx" ? 3 : 15,
    file: null, usage: KINDS.find((k) => k.id === kind)?.hint ?? "",
  };
}

export const SoundTab: React.FC<{ series: Series; patch: (p: Partial<Series>) => void }> = ({ series, patch }) => {
  const setCue = (id: string, p: Partial<SoundCue>) =>
    patch({
      sounds: series.sounds.map((c) => (c.id === id ? { ...c, ...p } : c)),
      // A renamed tag carries its set links with it.
      ...(p.id && p.id !== id ? { sets: series.sets.map((s) => (s.bed_sound === id ? { ...s, bed_sound: p.id! } : s)) } : {}),
    });
  const add = (kind: string) => {
    const label = KINDS.find((k) => k.id === kind)?.label ?? kind;
    patch({ sounds: [...series.sounds, newCue(kind, kind === "theme" ? "Theme" : label, series.sounds.map((c) => c.id))] });
  };
  const remove = (c: SoundCue) => {
    if (!window.confirm(`Remove “${c.label || c.id}”? Its takes stay on disk; episodes already made keep their copy.`)) return;
    patch({
      sounds: series.sounds.filter((x) => x.id !== c.id),
      sets: series.sets.map((s) => (s.bed_sound === c.id ? { ...s, bed_sound: null } : s)),
    });
  };

  return (
    <div>
      <SectionTitle right={
        <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {KINDS.map((k) => <button key={k.id} className="btn btn-sm" onClick={() => add(k.id)}>+ {k.label}</button>)}
        </span>
      }>
        Sound package
      </SectionTitle>
      <div style={{ fontSize: 11.5, color: "var(--fg-4)", marginBottom: 14, lineHeight: 1.6 }}>
        Recorded once, reused in every episode. The writer places a cue with its tag, e.g. <code>MUSIC: #theme</code>; the approved take is copied into the episode losslessly. Cues without a take are generated per episode from their prompt.
      </div>
      {series.sounds.length === 0 ? (
        <Empty>No recurring sounds yet. A theme and an act-break stinger go a long way.</Empty>
      ) : (
        series.sounds.map((c) => <CueCard key={c.id} seriesId={series.id} cue={c} taken={series.sounds.map((x) => x.id)} onChange={(p) => setCue(c.id, p)} onRemove={() => remove(c)} />)
      )}
    </div>
  );
};

const CueCard: React.FC<{
  seriesId: string;
  cue: SoundCue;
  taken: string[];
  onChange: (p: Partial<SoundCue>) => void;
  onRemove: () => void;
}> = ({ seriesId, cue, taken, onChange, onRemove }) => {
  const [takes, setTakes] = useState<SoundTake[]>([]);
  const slug = seriesSoundSlug(seriesId, cue.id);
  const running = useJobStore((s) => s.jobs.filter((j) => j.scene_slug === slug && (j.status === "running" || j.status === "pending")).length);
  const finished = useJobStore((s) => s.jobs.filter((j) => j.scene_slug === slug && j.status === "complete").length);
  const { playing, toggle } = useAudioStore();

  const refresh = useCallback(() => {
    listSeriesSoundTakes(seriesId, cue.id).then(setTakes).catch(() => setTakes([]));
  }, [seriesId, cue.id]);
  useEffect(refresh, [refresh, finished]);

  const generate = async () => {
    if (!cue.prompt.trim() && !cue.label.trim()) { window.alert("Give the cue a prompt first."); return; }
    try { await generateSeriesSound(seriesId, cue); } catch (e) { reportError("Generate", e); }
  };

  return (
    <div style={{ padding: 16, border: `1px solid ${cue.file ? "var(--music)" : "var(--line-1)"}`, borderRadius: 4, background: "var(--bg-2)", marginBottom: 12 }}>
      <TwoCol min={160}>
        <Field label="Label"><input className="input" value={cue.label} onChange={(e) => onChange({ label: e.target.value })} /></Field>
        <Field label="Tag" hint={takes.length ? "Locked." : "#tag in scripts."}>
          <input className="input mono" value={cue.id} disabled={takes.length > 0}
            onChange={(e) => {
              const id = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
              if (id && !taken.filter((t) => t !== cue.id).includes(id)) onChange({ id });
            }} />
        </Field>
        <Field label="Kind">
          <select className="select" value={cue.kind} onChange={(e) => onChange({ kind: e.target.value })}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Seconds">
          <input className="input" type="number" min={1} max={240} value={cue.duration_seconds || ""}
            onChange={(e) => onChange({ duration_seconds: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
      </TwoCol>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        <Field label="Prompt" hint={cueEngine(cue) === "music" ? "For the music server (instrumental)." : "For the SFX server."}>
          <input className="input" value={cue.prompt} onChange={(e) => onChange({ prompt: e.target.value })}
            placeholder={cue.kind === "theme" ? "surf-rock organ, spooky and jaunty, 120 bpm" : "describe the sound"} />
        </Field>
        <Field label="When to use it" hint="Read by the writer.">
          <input className="input" value={cue.usage} onChange={(e) => onChange({ usage: e.target.value })} />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn btn-primary" style={primaryBtn} onClick={generate}>
          {running ? `Generating (${running})…` : takes.length ? "Another take" : "Generate"}
        </button>
        <span style={monoMeta}>{cue.file ? "approved take set" : takes.length ? "pick a take" : "no takes yet"}</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto", color: "var(--sfx)" }} onClick={onRemove}>Remove</button>
      </div>
      {takes.length > 0 && (
        <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
          {takes.map((t, i) => {
            const approved = cue.file === t.path;
            return (
              <div key={t.path} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 10px", borderRadius: 3, background: approved ? "color-mix(in oklch, var(--music) 10%, var(--bg-1))" : "var(--bg-1)" }}>
                <button className="btn btn-sm" onClick={() => toggle(t.path)}>{playing === t.path ? "■" : "▶"}</button>
                <span style={{ fontSize: 12, color: "var(--fg-1)" }}>Take {takes.length - i}</span>
                <span style={monoMeta}>{t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)} s` : ""}</span>
                <button className="btn btn-sm" style={{ marginLeft: "auto", ...(approved ? { borderColor: "var(--music)", color: "var(--music)" } : {}) }}
                  onClick={() => onChange({ file: approved ? null : t.path })}>
                  {approved ? "✓ Approved" : "Approve"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
