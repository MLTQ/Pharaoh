import React, { useMemo, useState } from "react";
import { Icon, Wave } from "../shared/atoms";
import { TakeRow, TakeList, EmptyTakes } from "../shared/TakeList";
import { RichDirector, SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import { useProjectStore, deriveSlug } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import type { MockScene } from "../../lib/types";

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

const MODEL_BADGE: Record<string, string> = {
  Clone: "clone",
  VoiceDesign: "design",
  CustomVoice: "custom",
  FineTuned: "fine-tuned",
};

interface TTSPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

export const TTSPanel: React.FC<TTSPanelProps> = ({ scenes, defaultScene }) => {
  const { characters, activeSceneNo, activeSceneSlug } = useProjectStore();
  const { jobs, setQaStatus } = useJobStore();
  const [scene, setScene]         = useState(defaultScene);
  const [speakerId, setSpeakerId] = useState(characters[0]?.id ?? "");
  const [value, setValue]         = useState("");
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

  const handleSelectSpeaker = (id: string) => {
    setSpeakerId(id);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      await submitTts({
        text: value,
        speaker: speakerId,
        character: selectedChar,
        instruct: selectedChar?.voice_assignment.instruct_default ?? "",
        seed: Math.floor(Math.random() * 99999),
        temperature: pace,
      });
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const va = selectedChar?.voice_assignment;
  const charColor = selectedChar ? `oklch(0.7 0.12 ${CHAR_HUE(selectedChar.id)})` : "var(--tts)";

  return (
    <div className="panel-view">
      <div className="panel-main">
        <div className="panel-header">
          <div className="panel-header-left">
            <span className="eyebrow tts">
              qwen3-tts ·{" "}
              {va ? MODEL_BADGE[va.model] : "custom"}
            </span>
            <span className="ttl">Voice / Dialogue</span>
            <span className="desc">
              Type the line as you want it spoken. Use inline bracket directives to shape delivery —
              e.g. <code style={{ fontFamily: "var(--font-mono)", color: "var(--tts)" }}>[sad] [whisper]</code>
              {" "}before a phrase. Free-form descriptors outside brackets get spoken literally.
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <button className="btn btn-tts" onClick={handleGenerate} disabled={generating}>
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
            const hasRef = va.model === "Clone" && !!va.ref_audio_path;
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
                    color: hasRef ? "var(--st-rendered)" : active ? "var(--tts)" : "var(--fg-4)",
                    marginLeft: 2,
                  }}>
                    {hasRef ? "clone ✓" : MODEL_BADGE[va.model]}
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

        <div className="kicker" style={{ margin: "20px 0 8px" }}>Direction · rich text</div>
        <RichDirector value={value} setValue={setValue} accent="var(--tts)" />

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
            {va?.instruct_default && (
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "var(--fg-2)" }}>
                {va.instruct_default}
              </div>
            )}
            {va?.model === "Clone" && (
              <div style={{
                marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 9.5,
                color: va.ref_audio_path ? "var(--st-rendered)" : "var(--fg-4)",
                letterSpacing: "0.06em",
              }}>
                {va.ref_audio_path ? "✓ clone reference set" : "△ no reference audio — set one in Cast & Voices"}
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
