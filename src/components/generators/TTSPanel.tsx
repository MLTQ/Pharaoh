import React, { useEffect, useMemo, useState } from "react";
import { Icon, Wave } from "../shared/atoms";
import { TakeRow, TakeList, EmptyTakes } from "../shared/TakeList";
import { SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import { useProjectStore, deriveSlug } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import type { MockScene } from "../../lib/types";

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

interface TTSPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

export const TTSPanel: React.FC<TTSPanelProps> = ({ scenes, defaultScene }) => {
  const { characters, activeSceneNo, activeSceneSlug } = useProjectStore();
  const { jobs, setQaStatus } = useJobStore();
  const [scene, setScene]         = useState(defaultScene);
  const [speakerId, setSpeakerId] = useState(characters[0]?.id ?? "");
  const [line, setLine]           = useState("");
  const [direction, setDirection] = useState(characters[0]?.voice_assignment.instruct_default ?? "");
  const [pace, setPace]           = useState(0.92);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]   = useState<string | null>(null);
  const { submitTts } = useGenerateJob();

  // Match the slug source-of-truth used by useGenerateJob.submitTts so filter == write
  const fallbackScene = scenes.find((s) => s.no === activeSceneNo) ?? scenes[0];
  const sceneSlug = activeSceneSlug
    ?? (fallbackScene ? deriveSlug(fallbackScene.no, fallbackScene.title) : "");

  const takes = useMemo(
    () => [...jobs]
      .filter((j) =>
        j.model === "tts"
        && j.scene_slug === sceneSlug
        && j.row_index === 0
      )
      .reverse(),
    [jobs, sceneSlug],
  );

  const selectedChar = characters.find((c) => c.id === speakerId) ?? characters[0];
  const selectedVoice = selectedChar?.voice_assignment;
  const customSpeaker = selectedVoice?.speaker || "Vivian";

  useEffect(() => {
    if (speakerId || !characters[0]) return;
    setSpeakerId(characters[0].id);
    setDirection(characters[0].voice_assignment.instruct_default ?? "");
  }, [characters, speakerId]);

  const handleSelectSpeaker = (id: string) => {
    setSpeakerId(id);
    const next = characters.find((c) => c.id === id);
    setDirection(next?.voice_assignment.instruct_default ?? "");
  };

  const handleGenerate = async () => {
    if (!line.trim()) {
      setGenError("Add a line first.");
      return;
    }
    setGenerating(true);
    setGenError(null);
    try {
      await submitTts({
        text: line.trim(),
        speaker: customSpeaker,
        character: selectedChar,
        instruct: direction.trim(),
        seed: Math.floor(Math.random() * 99999),
        temperature: pace,
      });
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const charColor = selectedChar ? `oklch(0.7 0.12 ${CHAR_HUE(selectedChar.id)})` : "var(--tts)";

  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow tts">
              qwen3-tts · customvoice · {customSpeaker}
            </span>
            <span className="ttl">Voice / Dialogue</span>
            <span className="desc">
              Write the spoken line separately from the performance direction. Direction is sent as
              Qwen CustomVoice instruction text, not spoken dialogue.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button className="btn btn-tts" onClick={handleGenerate} disabled={generating || !line.trim()}>
              <Icon name="sparkle" style={{ width: 14, height: 14 }} />
              {generating ? "Submitting…" : "Generate take"}
            </button>
            {genError && (
              <span style={{ fontSize: 10, color: "var(--sfx)", maxWidth: 200, textAlign: "right" }}>{genError}</span>
            )}
          </div>
        </div>

        <SceneRouter scenes={scenes} scene={scene} setScene={setScene} accent="var(--tts)" onSend={() => {}} />

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Speaker</div>
        <div className="speaker-grid">
          {characters.map((c) => {
            const active = c.id === speakerId;
            const hue = CHAR_HUE(c.id);
            const color = `oklch(0.7 0.12 ${hue})`;
            const va = c.voice_assignment;
            const assignedSpeaker = va.speaker || "Vivian";
            const instruct = va.instruct_default ?? "";
            return (
              <div
                key={c.id}
                className={`speaker-card ${active ? "active" : ""}`}
                onClick={() => handleSelectSpeaker(c.id)}
              >
                <span className="id" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: color, display: "inline-block", flexShrink: 0,
                  }} />
                  {c.id}
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.04em",
                    color: active ? "var(--tts)" : "var(--fg-4)",
                    marginLeft: 2,
                  }}>
                    {assignedSpeaker}
                  </span>
                </span>
                <span className="name">{c.name}</span>
                <span className="desc" style={{ WebkitLineClamp: 2 }}>
                  {instruct || c.description || "—"}
                </span>
                <div className="wave">
                  <Wave width={200} height={16} seed={c.id.charCodeAt(0)} count={42} color="var(--tts)" />
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(260px, 0.85fr)", gap: 12, marginTop: 20 }}>
          <div className="field">
            <div className="field-label">
              <span>Line</span>
              <span className="hint">{line.length} chars</span>
            </div>
            <textarea
              className="textarea"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              placeholder="Type the words the character should speak."
              style={{ minHeight: 148, fontSize: 13, lineHeight: 1.55 }}
            />
          </div>
          <div className="field">
            <div className="field-label">
              <span>Direction</span>
              <span className="hint">CustomVoice instruct</span>
            </div>
            <textarea
              className="textarea"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder="Describe delivery, emotion, pacing, proximity, or accent."
              style={{ minHeight: 148, fontSize: 12, lineHeight: 1.55 }}
            />
          </div>
        </div>

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

      </div>

      {/* ── Side panel ──────────────────────────────────────────────────── */}
      <div className="panel-side">
        {selectedChar && (
          <div className="panel-side-section">
            <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: charColor, display: "inline-block",
              }} />
              {selectedChar.name}
            </h3>
            {selectedChar.description && (
              <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8, lineHeight: 1.5 }}>
                {selectedChar.description}
              </div>
            )}
            {selectedVoice?.instruct_default && (
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "var(--fg-2)" }}>
                {selectedVoice.instruct_default}
              </div>
            )}
            {selectedVoice?.model === "Clone" && (
              <div style={{
                marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 9.5,
                color: selectedVoice.ref_audio_path ? "var(--st-rendered)" : "var(--fg-4)",
                letterSpacing: "0.06em",
              }}>
                clone reference kept for design; dialogue uses CustomVoice
              </div>
            )}
          </div>
        )}

        <div className="panel-side-section" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h3>Takes</h3>
          {takes.length === 0 ? (
            <EmptyTakes label="No takes yet — generate a line above." />
          ) : (
            <TakeList label={`${takes.length} take${takes.length === 1 ? "" : "s"}`}>
              {takes.map((job, i) => (
                <TakeRow
                  key={job.id}
                  job={job}
                  index={takes.length - 1 - i}
                  caption={job.description}
                  onQa={(s) => setQaStatus(job.id, s)}
                />
              ))}
            </TakeList>
          )}
        </div>
      </div>
    </div>
  );
};
