import React, { useState } from "react";
import { Icon, Wave } from "../shared/atoms";
import { RichDirector, SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import type { MockScene } from "../../lib/types";

const SFX_TAGS = ["wet salt", "cavern · 2.4s tail", "doubled rhythm", "sub rumble", "foley", "exterior"];

const SFX_PRESETS = [
  { label: "surface", insert: "\n[surface: gravel slope, dry]\n" },
  { label: "space",   insert: "\n[space: cavern · 2.4s tail]\n" },
  { label: "rhythm",  insert: "\n[rhythm: 52 bpm · sparse]\n" },
  { label: "layer",   insert: "\n[layer: distant generator, sub 60Hz]\n" },
];

const VARIATIONS = [
  { v: "A", seed: 1188, sel: false, note: "doubled · half-beat" },
  { v: "B", seed: 1189, sel: true,  note: "doubled · in rhythm" },
  { v: "C", seed: 1190, sel: false, note: "single · pronounced" },
  { v: "D", seed: 1191, sel: false, note: "scuffle · uneven" },
];

interface SFXPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

export const SFXPanel: React.FC<SFXPanelProps> = ({ scenes, defaultScene }) => {
  const [scene, setScene] = useState(defaultScene);
  const [tags, setTags] = useState(["wet salt", "cavern · 2.4s tail", "doubled rhythm"]);
  const [value, setValue] = useState(
    "[surface: wet salt floor, fine grit underfoot]\n[space: salt chamber, 2.4s reverb tail, low rumble bed]\n[rhythm: slow walk · 52 bpm · doubled half-beat behind]\n\nFootsteps approach from camera, deliberate and measured. A second pair, half a beat behind, echoing back from the tunnel — same gait, same weight. The doubling tightens through the middle, then drifts ahead of the original."
  );
  const [duration] = useState(3.0);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { submitSfx } = useGenerateJob();

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      await submitSfx({ prompt: value, durationSeconds: duration });
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow sfx">sfx-v3 · foley</span>
            <span className="ttl">Sound Design</span>
            <span className="desc">
              Describe foley, ambiences and one-shots with structured directives.
              Length-locked to selection on the timeline.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button
              className="btn"
              style={{ borderColor: "var(--sfx-d)", color: "var(--sfx)", background: "color-mix(in oklch, var(--sfx) 10%, transparent)" }}
              onClick={handleGenerate}
              disabled={generating}
            >
              <Icon name="sparkle" style={{ width: 14, height: 14 }} />
              {generating ? "Submitting…" : "Generate · 4 variations"}
            </button>
            {genError && <span style={{ fontSize: 10, color: "var(--sfx)", maxWidth: 200, textAlign: "right" }}>{genError}</span>}
          </div>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--sfx)" onSend={() => {}} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector
          tags={tags} setTags={setTags}
          value={value} setValue={setValue}
          accent="var(--sfx)"
          allTags={SFX_TAGS}
          presets={SFX_PRESETS}
        />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Variations · 4</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
          {VARIATIONS.map((v) => (
            <div
              key={v.v}
              style={{
                border: `1px solid ${v.sel ? "var(--sfx)" : "var(--line-1)"}`,
                background: v.sel ? "color-mix(in oklch, var(--sfx) 8%, var(--bg-2))" : "var(--bg-2)",
                padding: 12, borderRadius: 2,
                display: "flex", flexDirection: "column", gap: 6,
              }}
            >
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontFamily: "var(--font-mono)", fontSize: 10,
                letterSpacing: "0.1em", textTransform: "uppercase",
              }}>
                <span style={{ color: "var(--fg-1)" }}>VARIATION {v.v}</span>
                <span style={{ color: "var(--fg-3)" }}>seed {v.seed}</span>
              </div>
              <div style={{ height: 36 }}>
                <Wave width={400} height={36} seed={v.seed} count={100} color="var(--sfx)" />
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{v.note}</span>
                <button className="btn btn-sm">{v.sel ? "use" : "audition"}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section">
          <h3>Reference uploads</h3>
          <div className="dropzone">
            <span className="label">Drop reference WAV / MP3</span>
            <span className="sublabel">Up to 30s · timbre + rhythm anchor</span>
          </div>
        </div>
        <div className="panel-side-section">
          <h3>Library matches</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
            {[
              { n: "salt-flat-walk-04.wav", m: "92%" },
              { n: "mine-shaft-double.wav", m: "81%" },
              { n: "wet-grit-slow.wav",     m: "74%" },
            ].map((l) => (
              <div
                key={l.n}
                style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line-1)" }}
              >
                <span style={{ color: "var(--fg-1)" }}>{l.n}</span>
                <span style={{ color: "var(--sfx)" }}>{l.m}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
