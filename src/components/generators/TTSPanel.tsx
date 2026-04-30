import React, { useState } from "react";
import { Icon, Wave } from "../shared/atoms";
import { RichDirector, SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import type { MockCastMember, MockScene } from "../../lib/types";

const TTS_TAGS = [
  "whispered", "intimate close mic", "weary", "weatherworn",
  "low register", "trailing breath", "slight bronchial catch",
  "deliberate cadence", "Dutch loanwords", "subvocal",
];

const TTS_PRESETS = [
  { label: "breath",          insert: "\n[breath · 0.3s]\n" },
  { label: "stage direction", insert: "\n(beat, looking away)\n" },
  { label: "voice override",  insert: "\n[voice: NARR · third-person, patinated]\n" },
  { label: "acoustic",        insert: "\n[acoustic: dry close mic, no reverb]\n" },
  { label: "emphasis",        insert: " *emphasis*" },
];

interface TTSPanelProps {
  cast: MockCastMember[];
  scenes: MockScene[];
  defaultScene: string;
}

export const TTSPanel: React.FC<TTSPanelProps> = ({ cast, scenes, defaultScene }) => {
  const [scene, setScene] = useState(defaultScene);
  const [speaker, setSpeaker] = useState("VERA");
  const [tags, setTags] = useState(["intimate close mic", "weary", "trailing breath"]);
  const [value, setValue] = useState(
    "[voice: VERA · elv·burnish-04]\n[delivery: half-whispered, looking up; the lamp is the only light]\n[acoustic: salt chamber, 2.4s tail, no music bed]\n\n(she swallows)\nIt can't go this deep. The geological survey said sixty meters — we've been descending for twenty minutes.\n\n[breath · 0.4s]\n\n(barely audible)\nAbel? Is that you down there?"
  );
  const [pace, setPace] = useState(0.92);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { submitTts } = useGenerateJob();

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      await submitTts({
        text: value,
        speaker,
        instruct: tags.join(", "),
        seed: Math.floor(Math.random() * 99999),
        temperature: pace,
      });
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
            <span className="eyebrow tts">qwen3-tts · elv·burnish-04</span>
            <span className="ttl">Voice / Dialogue</span>
            <span className="desc">
              Rich-text director: bracket directives shape voice, delivery, acoustic, and timing.
              Chip tags, inline cues, and stage directions all interpreted by the model.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button className="btn btn-tts" onClick={handleGenerate} disabled={generating}>
              <Icon name="sparkle" style={{ width: 14, height: 14 }} />
              {generating ? "Submitting…" : "Generate take"}
            </button>
            {genError && <span style={{ fontSize: 10, color: "var(--sfx)", maxWidth: 200, textAlign: "right" }}>{genError}</span>}
          </div>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--tts)" onSend={() => {}} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Speaker</div>
        <div className="speaker-grid">
          {cast.slice(0, 6).map((c) => (
            <div
              key={c.id}
              className={`speaker-card ${speaker === c.id ? "active" : ""}`}
              onClick={() => setSpeaker(c.id)}
            >
              <span className="id">{c.id} · {c.scenes} sc</span>
              <span className="name">{c.name}</span>
              <span className="desc">{c.voice}</span>
              <div className="wave">
                <Wave width={200} height={16} seed={c.id.charCodeAt(0)} count={42} color="var(--tts)" />
              </div>
            </div>
          ))}
        </div>

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector
          tags={tags} setTags={setTags}
          value={value} setValue={setValue}
          accent="var(--tts)"
          allTags={TTS_TAGS}
          presets={TTS_PRESETS}
        />

        <div className="field-row" style={{ marginTop: 18 }}>
          <div className="field">
            <div className="field-label">
              <span>Pace</span>
              <span className="hint">{pace.toFixed(2)}×</span>
            </div>
            <div className="slider-row">
              <input
                type="range" className="slider tts"
                min="0.5" max="1.5" step="0.01"
                value={pace} onChange={(e) => setPace(Number(e.target.value))}
              />
              <span className="slider-val">{pace.toFixed(2)}</span>
            </div>
          </div>
          <div className="field">
            <div className="field-label"><span>Mic distance</span></div>
            <div className="toggle-group">
              <button>close</button>
              <button className="active">intimate</button>
              <button>room</button>
              <button>distant</button>
            </div>
          </div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <div className="field-label">
            <span>Latest take · 0:18 · take 4</span>
            <span className="hint">seed 4412</span>
          </div>
          <div style={{
            border: "1px solid var(--line-1)", background: "var(--bg-2)",
            padding: 14, borderRadius: 2,
            display: "flex", alignItems: "center", gap: 14,
          }}>
            <button className="btn btn-icon" style={{ background: "var(--tts)", color: "var(--bg-0)", borderColor: "var(--tts)" }}>
              <Icon name="play" style={{ width: 12, height: 12 }} />
            </button>
            <div style={{ flex: 1, height: 36 }}>
              <Wave width={500} height={36} seed={42} count={120} color="var(--tts)" />
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)" }}>0:00 / 0:18</span>
          </div>
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section">
          <h3>Voice fingerprint</h3>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "var(--fg-2)" }}>
            Burnished alto with a slight bronchial catch on consonants. Locked to creator approval 2026-04-12.
          </div>
        </div>
        <div className="panel-side-section">
          <h3>Continuity check</h3>
          {[
            { ok: true,  t: "Pronunciation 'Constance' matches S02 take 4" },
            { ok: true,  t: "Mic distance consistent with Vault scenes" },
            { ok: false, t: "'salt' vowel drift — 2.1% from baseline" },
          ].map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 11.5, lineHeight: 1.4, marginBottom: 6 }}>
              <span style={{ color: c.ok ? "var(--st-rendered)" : "var(--st-gen)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                {c.ok ? "✓ OK" : "△ WARN"}
              </span>
              <span style={{ color: "var(--fg-1)" }}>{c.t}</span>
            </div>
          ))}
        </div>
        <div className="panel-side-section">
          <h3>Cost</h3>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { label: "EST.",    value: "0.018 cr · 12s" },
              { label: "EPISODE", value: "4.21 cr · 47m" },
              { label: "BUDGET",  value: "17.79 cr", highlight: true },
            ].map((row) => (
              <div key={row.label} style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--fg-3)" }}>{row.label}</span>
                <span style={row.highlight ? { color: "var(--st-rendered)" } : {}}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
