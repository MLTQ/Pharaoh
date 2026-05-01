import React, { useState } from "react";
import { Icon } from "../shared/atoms";
import { RichDirector, SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import type { MockScene } from "../../lib/types";

const HIT_LIST = [
  { t: "0:00", n: "Cue start · solo voice enters" },
  { t: "0:18", n: "Strings join · sub on Db" },
  { t: "0:42", n: "HIT · Vera reaches chamber floor" },
  { t: "1:04", n: "Metronome begins to drift (-3%)" },
  { t: "1:28", n: "HIT · final line · cut to silence" },
];

interface MusicPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

export const MusicPanel: React.FC<MusicPanelProps> = ({ scenes, defaultScene }) => {
  const [scene, setScene] = useState(defaultScene);
  const [value, setValue] = useState(
    "[key: Am · tempo: 64 bpm · meter: 4/4]\n[ensemble: textless female voice, low strings, hand percussion, metronome that drifts -3% by 1:04]\n[arc: salt hymn dissolving into arithmetic]\n[hits: 0:42 — Vera reaches chamber floor; 1:28 — final line, cut to silence]\n\nA salt hymn dissolving into arithmetic. Begin sparse on solo voice. Strings join at 0:18 with a sub on Db. The metronome, once steady, gradually loses time. Resolves on Vera's last line."
  );
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { submitMusic } = useGenerateJob();

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      await submitMusic({ caption: value, key: "Am", bpm: 64, durationSeconds: 96 });
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
            <span className="eyebrow music">score-v2</span>
            <span className="ttl">Score Composition</span>
            <span className="desc">
              Compose cues against a hit list. Score-v2 follows tempo, key, and beat anchors locked to the scene timeline.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button
              className="btn"
              style={{ borderColor: "var(--music-d)", color: "var(--music)", background: "color-mix(in oklch, var(--music) 10%, transparent)" }}
              onClick={handleGenerate}
              disabled={generating}
            >
              <Icon name="sparkle" style={{ width: 14, height: 14 }} />
              {generating ? "Submitting…" : "Compose cue"}
            </button>
            {genError && <span style={{ fontSize: 10, color: "var(--sfx)", maxWidth: 200, textAlign: "right" }}>{genError}</span>}
          </div>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--music)" onSend={() => {}} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector value={value} setValue={setValue} accent="var(--music)" />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Hit list · 1:36</div>
        <div style={{ border: "1px solid var(--line-1)", background: "var(--bg-2)", borderRadius: 2 }}>
          {HIT_LIST.map((h, i) => (
            <div
              key={i}
              style={{
                display: "grid", gridTemplateColumns: "70px 1fr auto",
                padding: "8px 14px",
                borderBottom: i < HIT_LIST.length - 1 ? "1px solid var(--line-1)" : "none",
                alignItems: "center",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--music)" }}>{h.t}</span>
              <span style={{ fontSize: 12, color: "var(--fg-1)" }}>{h.n}</span>
              <button className="btn btn-sm">edit</button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel-side">
        <div className="panel-side-section">
          <h3>Reference</h3>
          <div className="dropzone">
            <span className="label">Drop reference cue</span>
            <span className="sublabel">Stems separate automatically</span>
          </div>
        </div>
      </div>
    </div>
  );
};
