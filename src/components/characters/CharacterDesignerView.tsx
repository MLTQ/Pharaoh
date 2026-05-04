import React, { useState, useEffect, useMemo, useRef } from "react";
import { Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { TakeRow, TakeList, RunningBadge, EmptyTakes } from "../shared/TakeList";
import { useProjectStore } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import {
  submitTtsVoiceDesign,
  submitTtsVoiceClone,
} from "../../lib/tauriCommands";
import type { Character } from "../../lib/types";

// ── Constants ──────────────────────────────────────────────────────────────

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;
const DEFAULT_TEST_LINE = "And then she said — nothing at all.";

const charSceneSlug = (charId: string) => `__char__${charId}`;
const DESIGN_ROW = 0;
const CLONE_ROW  = 1;

function newCharId() {
  return "CHAR_" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── File picker ────────────────────────────────────────────────────────────

async function pickAudioFile(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "aac", "ogg", "flac"] }],
    });
    return typeof result === "string" ? result : null;
  } catch {
    return null; // browser / no dialog plugin — caller falls back to file input
  }
}

// ── Main component ─────────────────────────────────────────────────────────

type DesignTab = "design" | "clone";

export const CharacterDesignerView: React.FC = () => {
  const {
    characters, selectedCharId,
    setSelectedChar, addCharacter, removeCharacter,
    updateCharacter, updateVoiceAssignment,
    realProjectId, projectsDir,
  } = useProjectStore();
  const { jobs, addJob, setQaStatus } = useJobStore();

  const char = characters.find((c) => c.id === selectedCharId) ?? characters[0];

  const [tab, setTab] = useState<DesignTab>("design");
  const [localName, setLocalName]         = useState(char?.name ?? "");
  const [localDesc, setLocalDesc]         = useState(char?.description ?? "");
  const [voiceDesc, setVoiceDesc]         = useState(char?.voice_assignment.instruct_default ?? "");
  const [testLine, setTestLine]           = useState(DEFAULT_TEST_LINE);
  const [instruct, setInstruct]           = useState(char?.voice_assignment.instruct_default ?? "");
  const [refTranscript, setRefTranscript] = useState(char?.voice_assignment.ref_transcript ?? "");
  const [generating, setGenerating]       = useState(false);
  const [submitting, setSubmitting]       = useState<DesignTab | null>(null);
  const [genError, setGenError]           = useState<string | null>(null);
  const [addingChar, setAddingChar]       = useState(false);
  const [newName, setNewName]             = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!char) return;
    setLocalName(char.name);
    setLocalDesc(char.description);
    setVoiceDesc(char.voice_assignment.instruct_default ?? "");
    setInstruct(char.voice_assignment.instruct_default ?? "");
    setRefTranscript(char.voice_assignment.ref_transcript ?? "");
    setGenError(null);
    setTab(char.voice_assignment.model === "Clone" ? "clone" : "design");
  }, [char?.id]);

  // ── Jobs ──
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

  const runningDesign = submitting === "design" || jobs.some((j) => j.scene_slug === slug && j.row_index === DESIGN_ROW && (j.status === "running" || j.status === "pending"));
  const runningClone  = submitting === "clone"  || jobs.some((j) => j.scene_slug === slug && j.row_index === CLONE_ROW  && (j.status === "running" || j.status === "pending"));

  // ── Helpers ──

  const saveCharMeta = () => {
    if (!char) return;
    updateCharacter(char.id, { name: localName, description: localDesc });
  };

  const saveVoice = (patch: Partial<Character["voice_assignment"]>) => {
    if (!char) return;
    updateVoiceAssignment(char.id, patch);
  };

  const outputPath = (suffix: string) => {
    const ts = Date.now();
    return realProjectId && projectsDir
      ? `${projectsDir}/${realProjectId}/characters/${char!.id}/${suffix}_${ts}.wav`
      : `/tmp/pharaoh_${char!.id}_${suffix}_${ts}.wav`;
  };

  const pushJob = (jobId: string, rowIndex: number, description: string) => {
    addJob({
      id: jobId, model: "tts", description, status: "pending",
      progress: 0, eta: "…", started_at: new Date().toISOString(),
      scene_id: null, scene_slug: slug, row_index: rowIndex,
      output_path: null, peaks: null, qa_status: "unreviewed", error: null,
    });
  };

  // ── Generation ──

  const handleGenerateDesign = async () => {
    if (!char || generating || !voiceDesc.trim()) {
      if (!voiceDesc.trim()) setGenError("Add a voice description first.");
      return;
    }
    setGenerating(true); setSubmitting("design"); setGenError(null);
    try {
      const jobId = await submitTtsVoiceDesign({
        projectId: realProjectId ?? "demo",
        sceneSlug: slug, rowIndex: DESIGN_ROW,
        params: {
          text: testLine || DEFAULT_TEST_LINE,
          voice_description: voiceDesc.trim(),
          language: "en", seed: Math.floor(Math.random() * 9999),
          temperature: 0.7, top_p: 0.9, max_new_tokens: 2048,
          output_path: outputPath("design"),
        },
      });
      pushJob(jobId, DESIGN_ROW, `Voice design · ${char.name}`);
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : "Generation failed — is the TTS server running?");
    } finally {
      setSubmitting(null);
      setGenerating(false);
    }
  };

  const handleGenerateClone = async () => {
    if (!char || generating) return;
    const refPath = char.voice_assignment.ref_audio_path;
    if (!refPath) { setGenError("Set a reference audio first."); return; }
    setGenerating(true); setSubmitting("clone"); setGenError(null);
    try {
      const jobId = await submitTtsVoiceClone({
        projectId: realProjectId ?? "demo",
        sceneSlug: slug, rowIndex: CLONE_ROW,
        params: {
          text: testLine || DEFAULT_TEST_LINE,
          ref_audio_path: refPath,
          ref_transcript: refTranscript,
          language: "en", icl_mode: false,
          seed: Math.floor(Math.random() * 9999),
          temperature: 0.7, top_p: 0.9,
          max_new_tokens: 1024,
          output_path: outputPath("clone"),
        },
      });
      pushJob(jobId, CLONE_ROW, `Clone test · ${char.name}`);
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : "Generation failed — is the TTS server running?");
    } finally {
      setSubmitting(null);
      setGenerating(false);
    }
  };

  // ── File upload ──

  const handlePickFile = async () => {
    const path = await pickAudioFile();
    if (path) {
      saveVoice({ ref_audio_path: path, model: "Clone" });
    } else {
      // Fallback: trigger hidden file input (browser/demo mode)
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // In browser mode we only get a fake path; store the name as a placeholder
    const fakePath = `/uploads/${file.name}`;
    saveVoice({ ref_audio_path: fakePath, model: "Clone" });
    e.target.value = "";
  };

  // ── Character CRUD ──

  const handleAddCharacter = () => {
    if (!newName.trim()) return;
    const id = newCharId();
    addCharacter({
      id,
      name: newName.trim(),
      description: "",
      voice_assignment: {
        model: "VoiceDesign",
        speaker: null,
        instruct_default: "",
        ref_audio_path: null,
        ref_transcript: null,
      },
    });
    setNewName(""); setAddingChar(false);
  };

  const handleRemoveCharacter = (id: string) => {
    if (characters.length <= 1) return;
    if (!confirm(`Remove "${characters.find((c) => c.id === id)?.name}"?`)) return;
    removeCharacter(id);
  };

  const charColor = char ? `oklch(0.7 0.12 ${CHAR_HUE(char.id)})` : "";
  const refPath   = char?.voice_assignment.ref_audio_path ?? null;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>

      {/* hidden file input fallback */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".wav,.mp3,.aac,.ogg,.flac"
        style={{ display: "none" }}
        onChange={handleFileInputChange}
      />

      {/* ── Character list ──────────────────────────────────────────────── */}
      <div style={{
        width: 200, flexShrink: 0,
        borderRight: "1px solid var(--line-1)",
        display: "flex", flexDirection: "column",
        background: "var(--bg-1)", overflowY: "auto",
      }}>
        <div style={{
          padding: "8px 10px 8px 14px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
            color: "var(--fg-4)", textTransform: "uppercase",
          }}>
            Cast · {characters.length}
          </span>
          <button
            className="btn btn-sm"
            style={{ padding: "2px 7px", fontSize: 14, lineHeight: 1 }}
            title="Add character"
            onClick={() => { setAddingChar(true); setNewName(""); }}
          >+</button>
        </div>

        {/* New character inline form */}
        {addingChar && (
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line-1)", display: "flex", gap: 4 }}>
            <input
              className="input"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddCharacter(); if (e.key === "Escape") setAddingChar(false); }}
              placeholder="Character name…"
              style={{ flex: 1, fontSize: 11, padding: "3px 6px" }}
            />
            <button className="btn btn-sm btn-primary" onClick={handleAddCharacter}
              style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", padding: "2px 6px" }}>
              Add
            </button>
          </div>
        )}

        {characters.map((c) => {
          const active = c.id === char.id;
          const hue = CHAR_HUE(c.id);
          const modelLabel = c.voice_assignment.model === "Clone" ? "clone"
            : c.voice_assignment.model === "VoiceDesign" ? "design" : "custom";
          return (
            <div
              key={c.id}
              className={`side-item ${active ? "active" : ""}`}
              onClick={() => setSelectedChar(c.id)}
              style={{ paddingTop: 8, paddingBottom: 8, cursor: "pointer", paddingRight: 6 }}
            >
              <span className="ico">
                <span style={{
                  display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                  background: `oklch(0.7 0.12 ${hue})`,
                  border: "1px solid var(--line-2)",
                }} />
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <span style={{
                  display: "block", fontSize: 12, fontWeight: active ? 500 : 400,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {c.name.split(" ")[0]}
                </span>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 8.5,
                  color: "var(--fg-4)", letterSpacing: "0.04em",
                }}>
                  {modelLabel}
                </span>
              </span>
              {characters.length > 1 && (
                <button
                  className="btn btn-sm"
                  style={{
                    padding: "1px 5px", minWidth: 0, fontSize: 11, opacity: 0.4,
                    color: "var(--sfx)", borderColor: "transparent",
                  }}
                  title="Remove character"
                  onClick={(e) => { e.stopPropagation(); handleRemoveCharacter(c.id); }}
                >×</button>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Detail panel + right meta ──────────────────────────────────── */}
      {!char ? (
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "var(--fg-4)",
        }}>
          <span style={{ fontSize: 28, opacity: 0.25 }}>◎</span>
          <span style={{ fontSize: 12 }}>No characters yet</span>
          <button
            className="btn btn-primary"
            style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", marginTop: 4 }}
            onClick={() => { setAddingChar(true); setNewName(""); }}
          >
            + Add character
          </button>
        </div>
      ) : (
      <div style={{ flex: 1, display: "flex", minWidth: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", minWidth: 0 }}>

        {/* Character header */}
        <div style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{
              width: 14, height: 14, borderRadius: "50%",
              background: charColor, display: "inline-block", flexShrink: 0,
            }} />
            <input
              className="input"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={saveCharMeta}
              style={{
                background: "transparent", border: "none", padding: 0,
                fontSize: 20, fontWeight: 600, color: "var(--fg-1)", flex: 1,
              }}
            />
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.08em",
              color: "var(--tts)", textTransform: "uppercase",
              background: "color-mix(in oklch, var(--tts) 12%, var(--bg-2))",
              padding: "2px 6px", borderRadius: 3, flexShrink: 0,
            }}>
              {char.voice_assignment.model === "Clone" ? "Clone"
                : char.voice_assignment.model === "VoiceDesign" ? "Voice Design"
                : "Custom"}
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
            placeholder="Character notes — age, role, personality, vocal direction…"
          />
        </div>

        {/* Tab bar */}
        <div style={{
          display: "flex", borderBottom: "1px solid var(--line-1)",
          background: "var(--bg-1)", flexShrink: 0,
        }}>
          {(["design", "clone"] as DesignTab[]).map((t) => {
            const label = t === "design" ? "Voice Design" : "Clone";
            const active = tab === t;
            return (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: "8px 18px",
                fontFamily: "var(--font-mono)", fontSize: 10,
                letterSpacing: "0.08em", textTransform: "uppercase",
                color: active ? "var(--tts)" : "var(--fg-4)",
                borderBottom: active ? "2px solid var(--tts)" : "2px solid transparent",
                marginBottom: -1,
                background: "transparent", border: "none", cursor: "pointer",
                borderLeft: "none", borderRight: "none", borderTop: "none",
              }}>
                {label}
              </button>
            );
          })}
        </div>

        {/* Tab body */}
        <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>

          {/* ── VOICE DESIGN ─────────────────────────────────────────────── */}
          {tab === "design" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.6 }}>
                Describe this character's voice in plain language. Qwen3-TTS synthesises a novel
                speaker from the description — no preset selection needed. When you find a take you
                like, save it as the character's reference and switch to Clone for production use.
              </p>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Voice description</label>
                <textarea
                  className="input"
                  value={voiceDesc}
                  onChange={(e) => setVoiceDesc(e.target.value)}
                  rows={3}
                  style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                  placeholder="e.g. Burnished alto, mid-40s American, slight vocal roughness. Controlled, forensic cadence. Understates emotion."
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Test line</label>
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
                    {generating ? "Generating…" : "Generate"}
                  </button>
                </div>
                {genError && <div style={errorStyle}>{genError}</div>}
              </div>

              {runningDesign && <RunningBadge label="Synthesising voice…" />}

              {designJobs.length > 0 && (
                <TakeList label={`Design takes · ${designJobs.length}`}>
                  {designJobs.map((job, i) => (
                    <TakeRow
                      key={job.id} job={job} index={i}
                      saveLabel="Save as character voice"
                      isSaved={refPath === job.output_path}
                      onSave={() => {
                        const transcript = (testLine || DEFAULT_TEST_LINE).trim();
                        saveVoice({
                          ref_audio_path: job.output_path,
                          ref_transcript: transcript,
                          model: "Clone",
                        });
                        setRefTranscript(transcript);
                        setTab("clone");
                      }}
                      onQa={(s) => setQaStatus(job.id, s)}
                    />
                  ))}
                </TakeList>
              )}

              {designJobs.length === 0 && !runningDesign && (
                <EmptyTakes label="No takes yet — write a description and generate above." />
              )}
            </div>
          )}

          {/* ── CLONE ────────────────────────────────────────────────────── */}
          {tab === "clone" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.6 }}>
                Clone uses a reference audio clip as a vocal fingerprint.
                Upload any WAV or generate one from Voice Design — every production line
                for this character will match that timbre.
              </p>

              {/* Reference audio */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>Reference audio</label>
                {refPath ? (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px",
                    background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
                    borderRadius: "var(--r)", border: "1px solid var(--line-2)",
                  }}>
                    <PlayButton path={refPath} size={12} />
                    <Wave width={110} height={18} seed={char.id.charCodeAt(0)} count={28} color="var(--tts)" opacity={0.7} />
                    <span style={{
                      flex: 1, fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--fg-3)", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {refPath.split("/").pop()}
                    </span>
                    <button className="btn btn-sm" onClick={handlePickFile}>replace</button>
                    <button
                      className="btn btn-sm"
                      style={{ color: "var(--sfx)" }}
                      onClick={() => saveVoice({ ref_audio_path: null })}
                    >clear</button>
                  </div>
                ) : (
                  <div style={{
                    padding: "16px 14px",
                    border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                    display: "flex", flexDirection: "column", gap: 8,
                  }}>
                    <div style={{ fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6 }}>
                      No reference audio. Upload a clip or{" "}
                      <button
                        className="btn btn-sm"
                        onClick={() => setTab("design")}
                        style={{ display: "inline", padding: "1px 6px" }}
                      >
                        generate one in Voice Design →
                      </button>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={handlePickFile}
                      style={{ alignSelf: "flex-start" }}
                    >
                      Upload audio file…
                    </button>
                  </div>
                )}
              </div>

              {/* ref_transcript */}
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Reference transcript{" "}
                  <span style={{ color: "var(--fg-4)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                    — optional, helps ICL mode
                  </span>
                </label>
                <input
                  className="input"
                  value={refTranscript}
                  onChange={(e) => setRefTranscript(e.target.value)}
                  onBlur={() => saveVoice({ ref_transcript: refTranscript })}
                  style={{ width: "100%", fontSize: 12 }}
                  placeholder="What is spoken in the reference audio…"
                />
              </div>

              {/* instruct */}
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Voice instructions</label>
                <textarea
                  className="input"
                  value={instruct}
                  onChange={(e) => setInstruct(e.target.value)}
                  onBlur={() => saveVoice({ instruct_default: instruct })}
                  rows={2}
                  style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                  placeholder="Directorial notes pre-filled in the TTS panel for every line…"
                />
              </div>

              {/* Test clone */}
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Test clone</label>
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
                    disabled={generating || !refPath}
                    style={{
                      background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)",
                      opacity: !refPath ? 0.4 : 1, flexShrink: 0,
                    }}
                  >
                    {generating ? "Generating…" : "Generate"}
                  </button>
                </div>
                {genError && <div style={errorStyle}>{genError}</div>}
              </div>

              {runningClone && <RunningBadge label="Cloning voice…" />}

              {cloneJobs.length > 0 && (
                <TakeList label={`Clone takes · ${cloneJobs.length}`}>
                  {cloneJobs.map((job, i) => (
                    <TakeRow
                      key={job.id} job={job} index={i}
                      saveLabel="Save as new reference"
                      isSaved={refPath === job.output_path}
                      onSave={() => saveVoice({ ref_audio_path: job.output_path })}
                      onQa={(s) => setQaStatus(job.id, s)}
                    />
                  ))}
                </TakeList>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right meta panel ────────────────────────────────────────────── */}
      <div style={{
        width: 174, flexShrink: 0,
        borderLeft: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "14px 12px", overflowY: "auto", fontSize: 11,
      }}>
        <MetaSection label="Mode">
          <div style={{ color: "var(--tts)", fontWeight: 500 }}>
            {char.voice_assignment.model === "Clone" ? "Voice Clone"
              : char.voice_assignment.model === "VoiceDesign" ? "Voice Design"
              : "Custom"}
          </div>
          {refPath
            ? <div style={{ color: "var(--st-rendered)", fontSize: 10, marginTop: 4 }}>✓ Reference set</div>
            : <div style={{ color: "var(--fg-4)", fontSize: 10, marginTop: 4 }}>No reference</div>}
        </MetaSection>

        {char.voice_assignment.instruct_default && (
          <MetaSection label="Voice instructions">
            <div style={{ color: "var(--fg-3)", lineHeight: 1.5, fontSize: 10.5 }}>
              {char.voice_assignment.instruct_default}
            </div>
          </MetaSection>
        )}

        <MetaSection label="Takes">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ color: "var(--fg-3)" }}>Design: <strong style={{ color: "var(--fg-1)" }}>{designJobs.length}</strong></span>
            <span style={{ color: "var(--fg-3)" }}>Clone: <strong style={{ color: "var(--fg-1)" }}>{cloneJobs.length}</strong></span>
          </div>
        </MetaSection>
      </div>
      </div>
      )}

    </div>
  );
};

// ── Small shared sub-components ────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.07em",
  color: "var(--fg-4)", textTransform: "uppercase", display: "block", marginBottom: 4,
};

const errorStyle: React.CSSProperties = {
  marginTop: 6, fontSize: 11, color: "var(--sfx)",
};

const MetaSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 12, marginTop: 12 }}>
    <div style={{
      fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.08em",
      color: "var(--fg-4)", textTransform: "uppercase", marginBottom: 6,
    }}>
      {label}
    </div>
    {children}
  </div>
);
