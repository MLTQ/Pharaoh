import React, { useState, useEffect, useMemo } from "react";
import { Wave, PeaksWave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { useProjectStore } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import {
  submitTtsVoiceDesign,
  submitTtsVoiceClone,
  submitTtsCustomVoice,
} from "../../lib/tauriCommands";
import type { Job, Character, QaJobStatus } from "../../lib/types";

// ── Constants ──────────────────────────────────────────────────────────────

const TONE_CHIPS = [
  "warm", "cold", "breathy", "gravelly", "nasal",
  "bright", "dark", "smooth", "rough", "husky",
  "whispered", "resonant", "crisp", "airy",
];

const SPEAKERS = [
  { id: "Vivian",   desc: "Bright, edgy young female" },
  { id: "Lili",     desc: "Warm, gentle young female" },
  { id: "Magnus",   desc: "Seasoned male, low mellow" },
  { id: "Jinchen",  desc: "Youthful Beijing male, natural" },
  { id: "Chengdu",  desc: "Lively male, slightly husky" },
  { id: "Dynamic",  desc: "Male, strong rhythmic drive" },
  { id: "Ryan",     desc: "Sunny American male, clear" },
  { id: "Japanese", desc: "Playful female, light nimble" },
  { id: "Korean",   desc: "Warm female, rich emotion" },
];

const MODEL_LABEL: Record<string, string> = {
  CustomVoice: "custom",
  VoiceDesign: "design",
  Clone: "clone",
  FineTuned: "fine-tuned",
};

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

const DEFAULT_TEST_LINE = "And then she said — nothing at all.";

// ── CharSceneSlug: maps char id to a stable scene_slug for the job store ──

const charSceneSlug = (charId: string) => `__char__${charId}`;
const DESIGN_ROW  = 0;
const CLONE_ROW   = 1;
const CUSTOM_ROW  = 2;

// ── TakeRow ────────────────────────────────────────────────────────────────

interface TakeRowProps {
  job: Job;
  index: number;
  isRef: boolean;
  onSetRef: () => void;
  onQa: (status: QaJobStatus) => void;
}

const TakeRow: React.FC<TakeRowProps> = ({ job, index, isRef, onSetRef, onQa }) => {
  const color = "var(--tts)";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 12px",
      background: isRef ? "color-mix(in oklch, var(--tts) 8%, var(--bg-1))" : undefined,
      borderLeft: isRef ? "2px solid var(--tts)" : "2px solid transparent",
      borderBottom: "1px solid var(--line-1)",
    }}>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
        letterSpacing: "0.06em", minWidth: 40,
      }}>
        take {index + 1}
      </span>
      <div style={{ flex: 1 }}>
        {job.peaks ? (
          <PeaksWave peaks={job.peaks} width={140} height={18} color={color} opacity={0.8} />
        ) : (
          <Wave width={140} height={18} seed={job.id.charCodeAt(0)} count={28} color={color} opacity={0.6} />
        )}
      </div>
      <PlayButton path={job.output_path} size={11} />
      <button
        className="btn btn-sm"
        style={{
          padding: "2px 4px", minWidth: 0,
          color: job.qa_status === "approved" ? "var(--st-rendered)" : "var(--fg-4)",
          borderColor: job.qa_status === "approved" ? "var(--st-rendered)" : undefined,
        }}
        onClick={() => onQa(job.qa_status === "approved" ? "unreviewed" : "approved")}
        title="Approve"
      >✓</button>
      <button
        className="btn btn-sm"
        style={{
          padding: "2px 4px", minWidth: 0,
          color: job.qa_status === "rejected" ? "var(--sfx)" : "var(--fg-4)",
          borderColor: job.qa_status === "rejected" ? "var(--sfx)" : undefined,
        }}
        onClick={() => onQa(job.qa_status === "rejected" ? "unreviewed" : "rejected")}
        title="Reject"
      >✕</button>
      <button
        className={`btn btn-sm${isRef ? " btn-primary" : ""}`}
        style={isRef ? { borderColor: "var(--tts)", color: "var(--tts)" } : undefined}
        onClick={() => !isRef && onSetRef()}
        disabled={isRef}
        title={isRef ? "Currently the reference voice" : "Use as reference for Clone"}
      >
        {isRef ? "ref ✓" : "set ref"}
      </button>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────────────────────

type DesignTab = "design" | "clone" | "custom";

export const CharacterDesignerView: React.FC = () => {
  const {
    characters, selectedCharId,
    setSelectedChar, updateCharacter, updateVoiceAssignment,
    realProjectId, projectsDir,
  } = useProjectStore();
  const { jobs, addJob, setQaStatus } = useJobStore();

  const char = characters.find((c) => c.id === selectedCharId) ?? characters[0];

  // ── Per-character local editable state ──
  const [tab, setTab] = useState<DesignTab>(() => {
    const m = char?.voice_assignment.model;
    if (m === "Clone") return "clone";
    if (m === "CustomVoice") return "custom";
    return "design";
  });
  const [localName, setLocalName]     = useState(char?.name ?? "");
  const [localDesc, setLocalDesc]     = useState(char?.description ?? "");
  const [voiceDesc, setVoiceDesc]     = useState(char?.voice_assignment.instruct_default ?? "");
  const [toneChips, setToneChips]     = useState<Set<string>>(new Set());
  const [testLine, setTestLine]       = useState(DEFAULT_TEST_LINE);
  const [instruct, setInstruct]       = useState(char?.voice_assignment.instruct_default ?? "");
  const [refTranscript, setRefTranscript] = useState(char?.voice_assignment.ref_transcript ?? "");
  const [selectedSpeaker, setSelectedSpeaker] = useState(char?.voice_assignment.speaker ?? "Vivian");
  const [generating, setGenerating]   = useState(false);
  const [genError, setGenError]       = useState<string | null>(null);

  // Sync local state when character changes
  useEffect(() => {
    if (!char) return;
    setLocalName(char.name);
    setLocalDesc(char.description);
    setVoiceDesc(char.voice_assignment.instruct_default ?? "");
    setInstruct(char.voice_assignment.instruct_default ?? "");
    setRefTranscript(char.voice_assignment.ref_transcript ?? "");
    setSelectedSpeaker(char.voice_assignment.speaker ?? "Vivian");
    setToneChips(new Set());
    setGenError(null);
    const m = char.voice_assignment.model;
    setTab(m === "Clone" ? "clone" : m === "CustomVoice" ? "custom" : "design");
  }, [char?.id]);

  // ── Jobs for this character ──
  const slug = char ? charSceneSlug(char.id) : "";

  const designJobs = useMemo(() =>
    [...jobs]
      .filter((j) => j.scene_slug === slug && j.row_index === DESIGN_ROW && j.status === "complete" && j.output_path)
      .reverse(),
    [jobs, slug]
  );

  const cloneJobs = useMemo(() =>
    [...jobs]
      .filter((j) => j.scene_slug === slug && j.row_index === CLONE_ROW && j.status === "complete" && j.output_path)
      .reverse(),
    [jobs, slug]
  );

  const runningJobs = useMemo(() =>
    jobs.filter((j) => j.scene_slug === slug && (j.status === "running" || j.status === "pending")),
    [jobs, slug]
  );

  // ── Save helpers ──

  const saveCharMeta = () => {
    if (!char) return;
    updateCharacter(char.id, { name: localName, description: localDesc });
  };

  const saveVoiceAssignment = (patch: Partial<Character["voice_assignment"]>) => {
    if (!char) return;
    updateVoiceAssignment(char.id, patch);
  };

  // ── Generation ──

  const outputPath = (suffix: string) => {
    const ts = Date.now();
    if (realProjectId && projectsDir) {
      return `${projectsDir}/${realProjectId}/characters/${char!.id}/${suffix}_${ts}.wav`;
    }
    return `/tmp/pharaoh_${char!.id}_${suffix}_${ts}.wav`;
  };

  const handleGenerateDesign = async () => {
    if (!char || generating) return;
    const description = [voiceDesc, ...Array.from(toneChips)].filter(Boolean).join(", ");
    if (!description) { setGenError("Add a voice description first."); return; }
    setGenerating(true);
    setGenError(null);
    try {
      const jobId = await submitTtsVoiceDesign({
        projectId: realProjectId ?? "demo",
        sceneSlug: slug,
        rowIndex: DESIGN_ROW,
        params: {
          text: testLine || DEFAULT_TEST_LINE,
          voice_description: description,
          language: "en",
          seed: Math.floor(Math.random() * 9999),
          temperature: 0.7,
          top_p: 0.9,
          max_new_tokens: 2048,
          output_path: outputPath("design"),
        },
      });
      addJob({
        id: jobId,
        model: "tts",
        description: `Voice design · ${char.name}`,
        status: "pending",
        progress: 0,
        eta: "~2s",
        started_at: new Date().toISOString(),
        scene_id: null,
        scene_slug: slug,
        row_index: DESIGN_ROW,
        output_path: null,
        peaks: null,
        qa_status: "unreviewed",
        error: null,
      });
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : "Generation failed. Is the TTS server running?");
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateClone = async () => {
    if (!char || generating) return;
    const refPath = char.voice_assignment.ref_audio_path;
    if (!refPath) { setGenError("No reference audio set. Generate a Voice Design take first."); return; }
    setGenerating(true);
    setGenError(null);
    try {
      const jobId = await submitTtsVoiceClone({
        projectId: realProjectId ?? "demo",
        sceneSlug: slug,
        rowIndex: CLONE_ROW,
        params: {
          text: testLine || DEFAULT_TEST_LINE,
          ref_audio_path: refPath,
          ref_transcript: refTranscript,
          language: "en",
          icl_mode: false,
          seed: Math.floor(Math.random() * 9999),
          temperature: 0.7,
          top_p: 0.9,
          output_path: outputPath("clone"),
        },
      });
      addJob({
        id: jobId,
        model: "tts",
        description: `Clone test · ${char.name}`,
        status: "pending",
        progress: 0,
        eta: "~2s",
        started_at: new Date().toISOString(),
        scene_id: null,
        scene_slug: slug,
        row_index: CLONE_ROW,
        output_path: null,
        peaks: null,
        qa_status: "unreviewed",
        error: null,
      });
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : "Generation failed. Is the TTS server running?");
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateCustom = async () => {
    if (!char || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const jobId = await submitTtsCustomVoice({
        projectId: realProjectId ?? "demo",
        sceneSlug: slug,
        rowIndex: CUSTOM_ROW,
        params: {
          text: testLine || DEFAULT_TEST_LINE,
          speaker: selectedSpeaker,
          language: "en",
          instruct: instruct,
          seed: Math.floor(Math.random() * 9999),
          temperature: 0.7,
          top_p: 0.9,
          max_new_tokens: 2048,
          output_path: outputPath("custom"),
        },
      });
      addJob({
        id: jobId,
        model: "tts",
        description: `Custom voice test · ${char.name}`,
        status: "pending",
        progress: 0,
        eta: "~2s",
        started_at: new Date().toISOString(),
        scene_id: null,
        scene_slug: slug,
        row_index: CUSTOM_ROW,
        output_path: null,
        peaks: null,
        qa_status: "unreviewed",
        error: null,
      });
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : "Generation failed. Is the TTS server running?");
    } finally {
      setGenerating(false);
    }
  };

  if (!char) return null;

  const hue = CHAR_HUE(char.id);
  const charColor = `oklch(0.7 0.12 ${hue})`;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>

      {/* ── Character list ──────────────────────────────────────────────── */}
      <div style={{
        width: 200, flexShrink: 0,
        borderRight: "1px solid var(--line-1)",
        display: "flex", flexDirection: "column",
        background: "var(--bg-1)",
        overflowY: "auto",
      }}>
        <div style={{
          padding: "10px 14px 6px",
          fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
          color: "var(--fg-4)", textTransform: "uppercase",
          borderBottom: "1px solid var(--line-1)",
        }}>
          Cast · {characters.length}
        </div>
        {characters.map((c) => {
          const active = c.id === char.id;
          const ch = CHAR_HUE(c.id);
          return (
            <div
              key={c.id}
              className={`side-item ${active ? "active" : ""}`}
              onClick={() => setSelectedChar(c.id)}
              style={{ paddingTop: 8, paddingBottom: 8, cursor: "pointer" }}
            >
              <span className="ico">
                <span style={{
                  display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                  background: `oklch(0.7 0.12 ${ch})`,
                  border: "1px solid var(--line-2)",
                }} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: active ? 500 : 400 }}>
                  {c.name.split(" ")[0]}
                </span>
              </span>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 8.5,
                color: "var(--fg-4)", letterSpacing: "0.04em",
                textTransform: "uppercase", flexShrink: 0,
              }}>
                {MODEL_LABEL[c.voice_assignment.model]}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Detail panel ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", minWidth: 0 }}>

        {/* Header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{
              width: 14, height: 14, borderRadius: "50%",
              background: charColor,
              display: "inline-block", flexShrink: 0,
            }} />
            <input
              className="input"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={saveCharMeta}
              style={{
                background: "transparent", border: "none", padding: 0,
                fontSize: 20, fontWeight: 600, color: "var(--fg-1)",
                flex: 1,
              }}
            />
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
              color: "var(--tts)", textTransform: "uppercase",
              background: "color-mix(in oklch, var(--tts) 12%, var(--bg-2))",
              padding: "2px 6px", borderRadius: 3,
            }}>
              {char.voice_assignment.model === "CustomVoice" ? "Custom Voice"
                : char.voice_assignment.model === "VoiceDesign" ? "Voice Design"
                : char.voice_assignment.model === "Clone" ? "Clone"
                : "Fine-Tuned"}
            </span>
          </div>
          <textarea
            className="input"
            value={localDesc}
            onChange={(e) => setLocalDesc(e.target.value)}
            onBlur={saveCharMeta}
            rows={2}
            style={{
              background: "transparent", border: "none", padding: 0,
              fontSize: 12, color: "var(--fg-3)", width: "100%",
              resize: "none", lineHeight: 1.5,
            }}
            placeholder="Character description…"
          />
        </div>

        {/* Tab bar */}
        <div style={{
          display: "flex", borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)", flexShrink: 0,
        }}>
          {(["design", "clone", "custom"] as DesignTab[]).map((t) => {
            const labels = { design: "Voice Design", clone: "Clone", custom: "Custom Voice" };
            const active = tab === t;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: "8px 18px",
                  fontFamily: "var(--font-mono)", fontSize: 10,
                  letterSpacing: "0.08em", textTransform: "uppercase",
                  color: active ? "var(--tts)" : "var(--fg-4)",
                  borderBottom: active ? "2px solid var(--tts)" : "2px solid transparent",
                  marginBottom: -1,
                  background: "transparent", border: "none", cursor: "pointer",
                  borderLeft: "none", borderRight: "none", borderTop: "none",
                }}
              >
                {labels[t]}
              </button>
            );
          })}
        </div>

        {/* Tab body */}
        <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>

          {/* ── VOICE DESIGN TAB ─────────────────────────────────────────── */}
          {tab === "design" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.5 }}>
                Describe the voice in plain language. Pharaoh sends this to Qwen3-TTS Voice Design
                to synthesize a reference take. Approve the best take, then set it as the Clone reference.
              </p>

              <div style={{ marginBottom: 14 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Voice description
                </label>
                <textarea
                  className="input"
                  value={voiceDesc}
                  onChange={(e) => setVoiceDesc(e.target.value)}
                  rows={3}
                  style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                  placeholder="e.g. Burnished alto, mid-40s American, slight vocal roughness. Controlled, forensic cadence."
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
                  Characteristics
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {TONE_CHIPS.map((chip) => {
                    const on = toneChips.has(chip);
                    return (
                      <button
                        key={chip}
                        className={`btn btn-sm${on ? " btn-primary" : ""}`}
                        style={on ? { borderColor: "var(--tts)", color: "var(--tts)", background: "color-mix(in oklch, var(--tts) 10%, var(--bg-2))" } : undefined}
                        onClick={() => {
                          setToneChips((prev) => {
                            const next = new Set(prev);
                            if (next.has(chip)) next.delete(chip); else next.add(chip);
                            return next;
                          });
                        }}
                      >
                        {chip}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Test line
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    value={testLine}
                    onChange={(e) => setTestLine(e.target.value)}
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="Line to synthesize…"
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleGenerateDesign}
                    disabled={generating}
                    style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", flexShrink: 0 }}
                  >
                    {generating ? "Generating…" : "Generate reference"}
                  </button>
                </div>
                {genError && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--sfx)" }}>{genError}</div>
                )}
              </div>

              {/* Running indicator */}
              {runningJobs.some((j) => j.row_index === DESIGN_ROW) && (
                <div style={{
                  padding: "8px 12px", marginBottom: 8,
                  background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
                  borderRadius: "var(--r)", fontSize: 11, color: "var(--tts)",
                  fontFamily: "var(--font-mono)",
                }}>
                  ◐ Synthesizing voice…
                </div>
              )}

              {/* Design takes */}
              {designJobs.length > 0 && (
                <div style={{ borderRadius: "var(--r)", border: "1px solid var(--line-1)", overflow: "hidden" }}>
                  <div style={{
                    padding: "6px 12px", background: "var(--bg-2)",
                    fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)",
                    letterSpacing: "0.07em", textTransform: "uppercase",
                  }}>
                    Reference takes · {designJobs.length}
                  </div>
                  {designJobs.map((job, i) => (
                    <TakeRow
                      key={job.id}
                      job={job}
                      index={i}
                      isRef={char.voice_assignment.ref_audio_path === job.output_path}
                      onSetRef={() => {
                        saveVoiceAssignment({
                          ref_audio_path: job.output_path,
                          model: "Clone",
                        });
                        setTab("clone");
                      }}
                      onQa={(status) => setQaStatus(job.id, status)}
                    />
                  ))}
                </div>
              )}

              {designJobs.length === 0 && !runningJobs.some((j) => j.row_index === DESIGN_ROW) && (
                <div style={{
                  padding: "24px", textAlign: "center",
                  border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                  fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6,
                }}>
                  No reference takes yet.<br />
                  Write a description and generate one above.
                </div>
              )}

              <div style={{ marginTop: 20, padding: "12px 14px", background: "var(--bg-2)", borderRadius: "var(--r)" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
                  Workflow tip
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.6 }}>
                  Generate several takes with different descriptions. Approve the closest match,
                  then click <strong>set ref</strong> to promote it to the Clone reference.
                  The Clone tab uses that audio to maintain vocal consistency across all lines.
                </div>
              </div>
            </div>
          )}

          {/* ── CLONE TAB ────────────────────────────────────────────────── */}
          {tab === "clone" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.5 }}>
                Clone uses a reference take as a vocal fingerprint. Every line rendered with
                this character will match that timbre — even across sessions.
              </p>

              {/* Reference audio */}
              <div style={{ marginBottom: 18 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 8 }}>
                  Reference audio
                </label>
                {char.voice_assignment.ref_audio_path ? (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px",
                    background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
                    borderRadius: "var(--r)", border: "1px solid var(--line-2)",
                  }}>
                    <PlayButton path={char.voice_assignment.ref_audio_path} size={12} />
                    <Wave width={120} height={18} seed={char.id.charCodeAt(0)} count={30} color="var(--tts)" opacity={0.7} />
                    <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {char.voice_assignment.ref_audio_path.split("/").pop()}
                    </span>
                    <button
                      className="btn btn-sm"
                      onClick={() => saveVoiceAssignment({ ref_audio_path: null })}
                      title="Clear reference"
                    >
                      clear
                    </button>
                  </div>
                ) : (
                  <div style={{
                    padding: "16px", border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                    fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6,
                  }}>
                    No reference audio set.{" "}
                    <button
                      className="btn btn-sm"
                      onClick={() => setTab("design")}
                      style={{ display: "inline", padding: "1px 6px" }}
                    >
                      Go to Voice Design →
                    </button>
                    {" "}to generate takes and promote one as the reference.
                  </div>
                )}
              </div>

              {/* ref_transcript */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Reference transcript <span style={{ color: "var(--fg-4)", fontWeight: 400, textTransform: "none" }}>(optional — helps ICL mode)</span>
                </label>
                <input
                  className="input"
                  value={refTranscript}
                  onChange={(e) => setRefTranscript(e.target.value)}
                  onBlur={() => saveVoiceAssignment({ ref_transcript: refTranscript })}
                  style={{ width: "100%", fontSize: 12 }}
                  placeholder="What is said in the reference audio…"
                />
              </div>

              {/* instruct_default */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Voice instructions
                </label>
                <textarea
                  className="input"
                  value={instruct}
                  onChange={(e) => setInstruct(e.target.value)}
                  onBlur={() => saveVoiceAssignment({ instruct_default: instruct })}
                  rows={2}
                  style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                  placeholder="Directorial style notes applied to every line for this character…"
                />
                <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 3 }}>
                  These become the default <code>[instruct]</code> in the TTS panel.
                </div>
              </div>

              {/* Test line + generate */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Test clone
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    value={testLine}
                    onChange={(e) => setTestLine(e.target.value)}
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="Line to clone…"
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleGenerateClone}
                    disabled={generating || !char.voice_assignment.ref_audio_path}
                    style={{
                      background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)",
                      opacity: !char.voice_assignment.ref_audio_path ? 0.4 : 1,
                    }}
                  >
                    {generating ? "Generating…" : "Generate clone"}
                  </button>
                </div>
                {genError && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--sfx)" }}>{genError}</div>
                )}
              </div>

              {/* Running indicator */}
              {runningJobs.some((j) => j.row_index === CLONE_ROW) && (
                <div style={{
                  padding: "8px 12px", marginBottom: 8,
                  background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
                  borderRadius: "var(--r)", fontSize: 11, color: "var(--tts)",
                  fontFamily: "var(--font-mono)",
                }}>
                  ◐ Cloning voice…
                </div>
              )}

              {/* Clone takes */}
              {cloneJobs.length > 0 && (
                <div style={{ borderRadius: "var(--r)", border: "1px solid var(--line-1)", overflow: "hidden" }}>
                  <div style={{
                    padding: "6px 12px", background: "var(--bg-2)",
                    fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)",
                    letterSpacing: "0.07em", textTransform: "uppercase",
                  }}>
                    Clone test takes · {cloneJobs.length}
                  </div>
                  {cloneJobs.map((job, i) => (
                    <TakeRow
                      key={job.id}
                      job={job}
                      index={i}
                      isRef={false}
                      onSetRef={() => {}}
                      onQa={(status) => setQaStatus(job.id, status)}
                    />
                  ))}
                </div>
              )}

              <div style={{ marginTop: 20, padding: "12px 14px", background: "var(--bg-2)", borderRadius: "var(--r)" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 4 }}>
                  Production use
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.6 }}>
                  When generating lines in the <strong>Voice / Dialogue</strong> panel, selecting
                  this character will automatically use Clone mode with this reference and
                  voice instructions pre-filled.
                </div>
              </div>
            </div>
          )}

          {/* ── CUSTOM VOICE TAB ─────────────────────────────────────────── */}
          {tab === "custom" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.5 }}>
                Use one of Qwen3-TTS's built-in speaker presets. Consistent but less character-specific
                than Clone. Good for minor roles or radio voices.
              </p>

              <div style={{ marginBottom: 18 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 8 }}>
                  Speaker preset
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  {SPEAKERS.map((sp) => {
                    const active = selectedSpeaker === sp.id;
                    return (
                      <button
                        key={sp.id}
                        onClick={() => {
                          setSelectedSpeaker(sp.id);
                          saveVoiceAssignment({ speaker: sp.id, model: "CustomVoice" });
                        }}
                        style={{
                          padding: "8px 10px", textAlign: "left",
                          background: active ? "color-mix(in oklch, var(--tts) 10%, var(--bg-2))" : "var(--bg-2)",
                          border: active ? "1px solid var(--tts)" : "1px solid var(--line-1)",
                          borderRadius: "var(--r)", cursor: "pointer",
                        }}
                      >
                        <div style={{ fontWeight: 500, fontSize: 12, color: active ? "var(--tts)" : "var(--fg-1)", marginBottom: 2 }}>
                          {sp.id}
                        </div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)" }}>
                          {sp.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Voice instructions
                </label>
                <textarea
                  className="input"
                  value={instruct}
                  onChange={(e) => setInstruct(e.target.value)}
                  onBlur={() => saveVoiceAssignment({ instruct_default: instruct })}
                  rows={2}
                  style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                  placeholder="Style notes applied to every line (optional)…"
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em", color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Test line
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    value={testLine}
                    onChange={(e) => setTestLine(e.target.value)}
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="Line to synthesize…"
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleGenerateCustom}
                    disabled={generating}
                    style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)" }}
                  >
                    {generating ? "Generating…" : "Generate test"}
                  </button>
                </div>
                {genError && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--sfx)" }}>{genError}</div>
                )}
              </div>

              {/* Running indicator */}
              {runningJobs.some((j) => j.row_index === CUSTOM_ROW) && (
                <div style={{
                  padding: "8px 12px", marginBottom: 8,
                  background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
                  borderRadius: "var(--r)", fontSize: 11, color: "var(--tts)",
                  fontFamily: "var(--font-mono)",
                }}>
                  ◐ Synthesizing…
                </div>
              )}

              {/* Custom test takes */}
              {jobs.filter((j) => j.scene_slug === slug && j.row_index === CUSTOM_ROW && j.status === "complete" && j.output_path).length > 0 && (
                <div style={{ borderRadius: "var(--r)", border: "1px solid var(--line-1)", overflow: "hidden" }}>
                  <div style={{
                    padding: "6px 12px", background: "var(--bg-2)",
                    fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)",
                    letterSpacing: "0.07em", textTransform: "uppercase",
                  }}>
                    Test takes
                  </div>
                  {jobs
                    .filter((j) => j.scene_slug === slug && j.row_index === CUSTOM_ROW && j.status === "complete" && j.output_path)
                    .map((job, i) => (
                      <TakeRow
                        key={job.id}
                        job={job}
                        index={i}
                        isRef={false}
                        onSetRef={() => {}}
                        onQa={(status) => setQaStatus(job.id, status)}
                      />
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right meta panel ────────────────────────────────────────────── */}
      <div style={{
        width: 180, flexShrink: 0,
        borderLeft: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "14px 12px",
        overflowY: "auto",
        fontSize: 11,
      }}>
        <div style={{
          fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
          color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 10,
        }}>
          Voice model
        </div>
        <div style={{ color: "var(--tts)", fontWeight: 500, marginBottom: 4 }}>
          {char.voice_assignment.model === "CustomVoice" ? "Custom Voice" :
           char.voice_assignment.model === "VoiceDesign" ? "Voice Design" :
           char.voice_assignment.model === "Clone" ? "Voice Clone" : "Fine-Tuned"}
        </div>
        {char.voice_assignment.speaker && (
          <div style={{ color: "var(--fg-3)", marginBottom: 8 }}>
            Speaker: {char.voice_assignment.speaker}
          </div>
        )}
        {char.voice_assignment.ref_audio_path && (
          <div style={{ color: "var(--st-rendered)", fontSize: 10, marginBottom: 8 }}>
            ✓ Reference set
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 12, marginTop: 4 }}>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 8,
          }}>
            Instruct default
          </div>
          <div style={{ color: "var(--fg-3)", lineHeight: 1.5, fontSize: 10.5 }}>
            {char.voice_assignment.instruct_default || <em style={{ color: "var(--fg-4)" }}>none</em>}
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 12, marginTop: 12 }}>
          <div style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 8,
          }}>
            Design takes
          </div>
          <div style={{ color: "var(--fg-2)", fontSize: 13, fontWeight: 600 }}>
            {designJobs.length}
          </div>
        </div>

        {cloneJobs.length > 0 && (
          <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 12, marginTop: 12 }}>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
              color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 8,
            }}>
              Clone takes
            </div>
            <div style={{ color: "var(--fg-2)", fontSize: 13, fontWeight: 600 }}>
              {cloneJobs.length}
            </div>
          </div>
        )}
      </div>

    </div>
  );
};
