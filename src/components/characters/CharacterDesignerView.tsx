import React, { useState, useEffect, useMemo, useRef } from "react";
import { PeaksWave, Wave } from "../shared/atoms";
import { PlayButton } from "../shared/PlayButton";
import { TakeRow, TakeList, RunningBadge, EmptyTakes } from "../shared/TakeList";
import { RecordTakePanel } from "./RecordTakePanel";
import { CharacterPipeline } from "./CharacterPipeline";
import { CorpusBuilder } from "./CorpusBuilder";
import { RvcModelStage } from "./RvcModelStage";
import { useProjectStore } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import {
  listGeneratedAudioAssets,
  listPaletteTakes,
  submitTtsVoiceDesign,
  submitTtsVoiceClone,
} from "../../lib/tauriCommands";
import type { PaletteTakeFile } from "../../lib/tauriCommands";
import { usePeaksStore } from "../../store/peaksStore";
import type { Character, GeneratedAudioAsset, PaletteEntry, VoicePipelineStage } from "../../lib/types";

// ── Constants ──────────────────────────────────────────────────────────────

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;
const DEFAULT_TEST_LINE = "And then she said — nothing at all.";

const charSceneSlug    = (charId: string) => `__char__${charId}`;
const paletteSceneSlug = (charId: string, emotion: string) => `__palette__${charId}__${emotion}`;
const DESIGN_ROW = 0;
const CLONE_ROW  = 1;
const PALETTE_ROW = 0; // one row per palette scene slug

function newCharId() {
  return "CHAR_" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatDuration(ms: number | null): string {
  if (!ms) return "--:--";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
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

// "corpus" and "model" map to pipeline stages 3 and 4
type DesignTab = "design" | "palette" | "clone" | "corpus" | "model";

function tabToStage(t: DesignTab): VoicePipelineStage {
  if (t === "palette") return 2;
  if (t === "corpus")  return 3;
  if (t === "model")   return 4;
  return 1;  // "design" | "clone"
}

function stageToTab(s: VoicePipelineStage): DesignTab {
  if (s === 2) return "palette";
  if (s === 3) return "corpus";
  if (s === 4) return "model";
  return "design";
}

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
  // base_voice_description: the full VoiceDesign identity prompt, shared across all palette takes
  const [voiceDesc, setVoiceDesc]         = useState(char?.voice_assignment.base_voice_description ?? "");
  const [testLine, setTestLine]           = useState(DEFAULT_TEST_LINE);
  const [instruct, setInstruct]           = useState(char?.voice_assignment.instruct_default ?? "");
  const [refTranscript, setRefTranscript] = useState(char?.voice_assignment.ref_transcript ?? "");
  const [generating, setGenerating]       = useState(false);
  const [submitting, setSubmitting]       = useState<DesignTab | null>(null);
  const [genError, setGenError]           = useState<string | null>(null);
  const [addingChar, setAddingChar]       = useState(false);
  const [newName, setNewName]             = useState("");
  const [referenceAssets, setReferenceAssets] = useState<GeneratedAudioAsset[]>([]);
  const [referencePeaks, setReferencePeaks] = useState<Record<string, number[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Palette state ──
  const [paletteEntries, setPaletteEntries] = useState<PaletteEntry[]>(
    char?.voice_assignment.emotional_palette ?? []
  );
  const [addingEmotion, setAddingEmotion]         = useState(false);
  const [newEmotionKey, setNewEmotionKey]         = useState("");
  const [newEmotionLabel, setNewEmotionLabel]     = useState("");
  const [newEmotionDirection, setNewEmotionDirection] = useState("");
  const [paletteTestLine, setPaletteTestLine]     = useState(DEFAULT_TEST_LINE);
  const [expandedEmotion, setExpandedEmotion]     = useState<string | null>(null);
  const [paletteGenError, setPaletteGenError]     = useState<string | null>(null);
  // Which emotion slot (if any) has the RecordTakePanel open
  const [recordingForEmotion, setRecordingForEmotion] = useState<string | null>(null);
  // Disk-scanned palette takes (generated by MCP or other tools outside the job store)
  const [paletteDiskTakes, setPaletteDiskTakes]   = useState<Record<string, PaletteTakeFile[]>>({});

  useEffect(() => {
    if (!char) return;
    setLocalName(char.name);
    setLocalDesc(char.description);
    setVoiceDesc(char.voice_assignment.base_voice_description ?? "");
    setInstruct(char.voice_assignment.instruct_default ?? "");
    setRefTranscript(char.voice_assignment.ref_transcript ?? "");
    setPaletteEntries(char.voice_assignment.emotional_palette ?? []);
    setGenError(null);
    setPaletteGenError(null);
    setAddingEmotion(false);
    const model = char.voice_assignment.model;
    setTab(model === "Clone" ? "clone" : model === "Chatterbox" ? "palette" : "design");
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

  useEffect(() => {
    if (!realProjectId) {
      setReferenceAssets([]);
      return;
    }
    listGeneratedAudioAssets(realProjectId)
      .then((assets) => setReferenceAssets(assets.filter((asset) => {
        const model = asset.model.toLowerCase();
        return asset.kind === "tts" || model.includes("reference");
      })))
      .catch(() => setReferenceAssets([]));
  }, [realProjectId, jobs]);

  const fetchPeaks = usePeaksStore((s) => s.fetchPeaks);
  useEffect(() => {
    for (const asset of referenceAssets.slice(0, 12)) {
      if (referencePeaks[asset.audio_path]) continue;
      fetchPeaks(asset.audio_path, 80)
        .then((peaks) => setReferencePeaks((prev) => ({ ...prev, [asset.audio_path]: peaks })))
        .catch(() => {});
    }
  }, [referenceAssets, referencePeaks, fetchPeaks]);

  // Refresh disk-scanned takes for all palette entries whenever the palette tab is
  // visible or when a new emotion is expanded. Catches MCP-generated takes that
  // bypass the in-memory job store.
  useEffect(() => {
    if (tab !== "palette" || !char || !realProjectId) return;
    const entries = char.voice_assignment.emotional_palette ?? [];
    Promise.all(
      entries.map((e) =>
        listPaletteTakes({ projectId: realProjectId, characterId: char.id, emotion: e.emotion })
          .then((files) => ({ emotion: e.emotion, files }))
          .catch(() => ({ emotion: e.emotion, files: [] as PaletteTakeFile[] }))
      )
    ).then((results) => {
      const map: Record<string, PaletteTakeFile[]> = {};
      for (const { emotion, files } of results) map[emotion] = files;
      setPaletteDiskTakes(map);
    });
  }, [tab, char?.id, realProjectId, paletteEntries.length]);

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

  // ── Palette helpers ──

  const savePalette = (entries: PaletteEntry[]) => {
    setPaletteEntries(entries);
    saveVoice({ emotional_palette: entries });
  };

  const handleAddEmotion = () => {
    const key = newEmotionKey.trim().toLowerCase().replace(/\s+/g, "_");
    if (!key) return;
    if (paletteEntries.some((e) => e.emotion === key)) {
      setPaletteGenError(`Emotion "${key}" already exists.`);
      return;
    }
    const entry: PaletteEntry = {
      emotion: key,
      label: newEmotionLabel.trim() || key.charAt(0).toUpperCase() + key.slice(1),
      direction: newEmotionDirection.trim(),
      ref_audio_path: null,
      ref_transcript: null,
      qa_status: "unreviewed",
    };
    const next = [...paletteEntries, entry];
    savePalette(next);
    setNewEmotionKey(""); setNewEmotionLabel(""); setNewEmotionDirection("");
    setAddingEmotion(false);
    setExpandedEmotion(key);
    setPaletteGenError(null);
  };

  const handleRemoveEmotion = (emotion: string) => {
    if (!window.confirm(`Remove "${emotion}" from the palette?`)) return;
    savePalette(paletteEntries.filter((e) => e.emotion !== emotion));
  };

  const handleGeneratePaletteTake = async (entry: PaletteEntry) => {
    if (!char) return;
    const baseDesc = (char.voice_assignment.base_voice_description ?? "").trim();
    if (!baseDesc) {
      setPaletteGenError("Set the character's base voice description in the Voice Design tab first.");
      return;
    }
    // Combine base identity + emotional direction into one VoiceDesign instruct
    const fullInstruct = entry.direction.trim()
      ? `${baseDesc} ${entry.direction.trim()}`
      : baseDesc;
    setPaletteGenError(null);
    const emotionSlug = paletteSceneSlug(char.id, entry.emotion);
    const seed = Math.floor(Math.random() * 9999);
    const ts = Date.now();
    const palDir = realProjectId && projectsDir
      ? `${projectsDir}/${realProjectId}/characters/${char.id}/palette`
      : "/tmp";
    const out = `${palDir}/${entry.emotion}_${seed}_${ts}.wav`;
    try {
      const jobId = await submitTtsVoiceDesign({
        projectId: realProjectId ?? "demo",
        sceneSlug: emotionSlug,
        rowIndex: PALETTE_ROW,
        params: {
          text: paletteTestLine || DEFAULT_TEST_LINE,
          voice_description: fullInstruct,
          language: "en", seed,
          temperature: 0.7, top_p: 0.9, max_new_tokens: 2048,
          output_path: out,
        },
      });
      addJob({
        id: jobId, model: "tts",
        description: `Palette · ${char.name} · ${entry.label}`,
        status: "pending", progress: 0, eta: "…",
        started_at: new Date().toISOString(),
        scene_id: null, scene_slug: emotionSlug, row_index: PALETTE_ROW,
        output_path: null, peaks: null, qa_status: "unreviewed", error: null,
      });
    } catch (e: unknown) {
      setPaletteGenError(e instanceof Error ? e.message : "Generation failed");
    }
  };

  // Called when RecordTakePanel finishes recording.  The WAV is already at
  // outputPath; trigger a disk-take rescan so it appears in the TakeList.
  const handleRecordDone = (emotion: string, _outputPath: string, _durationMs: number) => {
    setRecordingForEmotion(null);
    // Force a rescan of disk takes for this emotion
    if (!char || !realProjectId) return;
    listPaletteTakes({ projectId: realProjectId, characterId: char.id, emotion })
      .then((files) => setPaletteDiskTakes((prev) => ({ ...prev, [emotion]: files })))
      .catch(() => {});
  };

  const handlePromotePaletteTake = (emotion: string, audioPath: string) => {
    const next = paletteEntries.map((e) =>
      e.emotion === emotion
        ? { ...e, ref_audio_path: audioPath, qa_status: "approved" as const }
        : e
    );
    savePalette(next);
    // Promote model to Chatterbox once first reference is approved
    saveVoice({ model: "Chatterbox", emotional_palette: next });
  };

  // ── Generation ──

  const handleGenerateDesign = async () => {
    if (!char || generating || !voiceDesc.trim()) {
      if (!voiceDesc.trim()) setGenError("Add a base voice description first.");
      return;
    }
    // Persist the description before generating so it's available for palette takes
    saveVoice({ base_voice_description: voiceDesc });
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
        base_voice_description: "",
        emotional_palette: [],
        production_pipeline: "chatterbox",
      },
      schema_version: 2,
    });
    setNewName(""); setAddingChar(false);
  };

  const handleRemoveCharacter = (id: string) => {
    const name = characters.find((c) => c.id === id)?.name ?? "this character";
    if (!window.confirm(`Delete "${name}" from the cast? This keeps existing generated audio files but removes the character from project.json.`)) return;
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
            : c.voice_assignment.model === "VoiceDesign" ? "design"
            : c.voice_assignment.model === "Chatterbox" ? "chatterbox"
            : "custom";
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
              <button
                className="btn btn-sm"
                style={{
                  padding: "1px 6px", minWidth: 0, fontSize: 11,
                  color: "var(--sfx)", borderColor: "transparent",
                }}
                title={`Delete ${c.name}`}
                aria-label={`Delete ${c.name}`}
                onClick={(e) => { e.stopPropagation(); handleRemoveCharacter(c.id); }}
              >×</button>
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
                : char.voice_assignment.model === "Chatterbox" ? "Chatterbox"
                : "Custom"}
            </span>
            <button
              className="btn btn-sm"
              style={{
                color: "var(--sfx)",
                borderColor: "color-mix(in oklch, var(--sfx) 45%, var(--line-1))",
                background: "color-mix(in oklch, var(--sfx) 8%, transparent)",
                flexShrink: 0,
              }}
              onClick={() => handleRemoveCharacter(char.id)}
            >
              Delete
            </button>
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

        {/* Pipeline stage header — replaces flat tab bar */}
        {(() => {
          const approvedPalette = paletteEntries.filter((e) => e.qa_status === "approved");
          const stage1Done = (char.voice_assignment.base_voice_description ?? "").trim().length > 0;
          const stage2Done = approvedPalette.length >= 2;
          const corpusCount = char.voice_assignment.rvc?.corpus_count ?? 0;
          const corpusDurationMs = char.voice_assignment.rvc?.corpus_duration_ms ?? 0;
          const corpusTarget = 50;
          const modelTrained = (char.voice_assignment.rvc?.model_path ?? null) !== null;
          const rvcEnabled = char.voice_assignment.rvc?.enabled ?? false;
          return (
            <CharacterPipeline
              stage1Done={stage1Done}
              stage2Done={stage2Done}
              corpusCount={corpusCount}
              corpusTarget={corpusTarget}
              corpusDurationMs={corpusDurationMs}
              modelTrained={modelTrained}
              rvcEnabled={rvcEnabled}
              activeStage={tabToStage(tab)}
              onSelectStage={(s) => setTab(stageToTab(s))}
            />
          );
        })()}

        {/* Stage 1 sub-tabs: Voice Design | Clone (legacy) */}
        {(tab === "design" || tab === "clone") && (
          <div style={{
            display: "flex", gap: 0,
            borderBottom: "1px solid var(--line-1)",
            background: "var(--bg-1)", flexShrink: 0,
            paddingLeft: 20,
          }}>
            {(["design", "clone"] as DesignTab[]).map((t) => {
              const label = t === "design" ? "Voice Design" : "Clone (legacy)";
              const active = tab === t;
              return (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: "6px 14px",
                  fontFamily: "var(--font-mono)", fontSize: 9.5,
                  letterSpacing: "0.07em", textTransform: "uppercase",
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
        )}

        {/* Tab body */}
        <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>

          {/* ── VOICE DESIGN ─────────────────────────────────────────────── */}
          {tab === "design" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.6 }}>
                Describe this character's core vocal identity — timbre, age, accent, pacing. This
                is saved as the character's foundation and prepended to each emotional direction
                when generating Emotional Palette takes.
              </p>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Base voice description
                  {paletteEntries.length > 0 && (
                    <span style={{
                      color: "var(--tts)", fontWeight: 400,
                      textTransform: "none", letterSpacing: 0, marginLeft: 6,
                    }}>
                      — shared with palette
                    </span>
                  )}
                </label>
                <textarea
                  className="input"
                  value={voiceDesc}
                  onChange={(e) => setVoiceDesc(e.target.value)}
                  onBlur={() => saveVoice({ base_voice_description: voiceDesc })}
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
                          base_voice_description: voiceDesc,
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

          {/* ── EMOTIONAL PALETTE ────────────────────────────────────────── */}
          {tab === "palette" && (
            <div>
              <p style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 16, lineHeight: 1.6 }}>
                Define named emotional states for this character. Each state gets a Qwen3 VoiceDesign
                reference clip — Chatterbox Turbo then 0-shot clones from the matching reference for
                every production line. Assign emotions in the script's <em>emotion</em> column.
              </p>

              {/* Add emotion / test line row */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Test line for takes</label>
                  <input
                    className="input"
                    value={paletteTestLine}
                    onChange={(e) => setPaletteTestLine(e.target.value)}
                    style={{ width: "100%", fontSize: 12 }}
                    placeholder="Line to synthesise for audition…"
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => { setAddingEmotion(true); setNewEmotionKey(""); setNewEmotionLabel(""); setNewEmotionDirection(""); setPaletteGenError(null); }}
                  style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)", flexShrink: 0 }}
                >
                  + Add Emotion
                </button>
              </div>

              {/* Add emotion inline form */}
              {addingEmotion && (
                <div style={{
                  padding: "12px 14px", marginBottom: 14,
                  border: "1px solid var(--tts)", borderRadius: "var(--r)",
                  background: "color-mix(in oklch, var(--tts) 6%, var(--bg-1))",
                  display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Emotion key (slug)</label>
                      <input
                        className="input" autoFocus
                        value={newEmotionKey}
                        onChange={(e) => setNewEmotionKey(e.target.value)}
                        style={{ width: "100%", fontSize: 12 }}
                        placeholder="neutral, sardonic, tense…"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Display label</label>
                      <input
                        className="input"
                        value={newEmotionLabel}
                        onChange={(e) => setNewEmotionLabel(e.target.value)}
                        style={{ width: "100%", fontSize: 12 }}
                        placeholder="Neutral (defaults to key)"
                      />
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>Emotional direction</label>
                    <textarea
                      className="input"
                      value={newEmotionDirection}
                      onChange={(e) => setNewEmotionDirection(e.target.value)}
                      rows={2}
                      style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                      placeholder="e.g. Slower and more deliberate, each word chosen carefully. Controlled dread just beneath the surface."
                    />
                    <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 4 }}>
                      Appended to the base voice description when generating takes.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="btn btn-sm" onClick={() => setAddingEmotion(false)}>Cancel</button>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={handleAddEmotion}
                      disabled={!newEmotionKey.trim()}
                      style={{ background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)" }}
                    >
                      Create
                    </button>
                  </div>
                </div>
              )}

              {paletteGenError && <div style={errorStyle}>{paletteGenError}</div>}

              {/* Palette entry cards */}
              {paletteEntries.length === 0 && !addingEmotion && (
                <div style={{
                  padding: "24px 16px", textAlign: "center",
                  border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
                  color: "var(--fg-4)", fontSize: 12,
                }}>
                  No emotions yet. Add one above — start with "neutral".
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {paletteEntries.map((entry) => {
                  const emotionSlug = char ? paletteSceneSlug(char.id, entry.emotion) : "";
                  const entryJobs = [...jobs]
                    .filter((j) => j.scene_slug === emotionSlug && j.row_index === PALETTE_ROW && j.status === "complete" && j.output_path)
                    .reverse();
                  const runningEntry = jobs.some((j) => j.scene_slug === emotionSlug && (j.status === "running" || j.status === "pending"));
                  const isExpanded = expandedEmotion === entry.emotion;

                  // Disk takes from MCP / external tools, deduped against job-tracked takes
                  const jobPaths = new Set(entryJobs.map((j) => j.output_path));
                  const diskTakes = (paletteDiskTakes[entry.emotion] ?? []).filter(
                    (f) => !jobPaths.has(f.path)
                  );
                  // Synthesize Job-like objects so TakeRow can render them
                  const diskJobs = diskTakes.map((f) => ({
                    id: `disk::${f.path}`,
                    model: "tts" as const,
                    description: f.path.split("/").pop() ?? "",
                    status: "complete" as const,
                    progress: 100,
                    eta: "",
                    started_at: f.sidecar?.generated_at ?? "",
                    scene_id: null,
                    scene_slug: emotionSlug,
                    row_index: PALETTE_ROW,
                    output_path: f.path,
                    peaks: null,
                    qa_status: (f.sidecar?.qa_status ?? "unreviewed") as import("../../lib/types").QaJobStatus,
                    error: null,
                  }));
                  const allTakes = [...entryJobs, ...diskJobs];

                  return (
                    <div key={entry.emotion} style={{
                      border: `1px solid ${entry.qa_status === "approved" ? "var(--st-rendered)" : "var(--line-1)"}`,
                      borderRadius: "var(--r)",
                      background: "var(--bg-1)",
                      overflow: "hidden",
                    }}>
                      {/* Card header */}
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "8px 12px", cursor: "pointer",
                          background: isExpanded ? "color-mix(in oklch, var(--bg-2) 60%, transparent)" : "transparent",
                        }}
                        onClick={() => setExpandedEmotion(isExpanded ? null : entry.emotion)}
                      >
                        <span style={{
                          fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em",
                          color: isExpanded ? "var(--fg-1)" : "var(--fg-3)", userSelect: "none",
                        }}>
                          {isExpanded ? "▾" : "▸"}
                        </span>
                        <span style={{ fontWeight: 500, fontSize: 12, color: "var(--fg-1)", flex: 1 }}>
                          {entry.label}
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)", marginLeft: 6 }}>
                            {entry.emotion}
                          </span>
                        </span>
                        {entry.qa_status === "approved" ? (
                          <span style={{ fontSize: 9.5, color: "var(--st-rendered)", fontFamily: "var(--font-mono)" }}>✓ approved</span>
                        ) : entry.ref_audio_path ? (
                          <span style={{ fontSize: 9.5, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>○ unreviewed</span>
                        ) : null}
                        <button
                          className="btn btn-sm"
                          style={{ color: "var(--sfx)", borderColor: "transparent", padding: "1px 5px", fontSize: 11 }}
                          onClick={(e) => { e.stopPropagation(); handleRemoveEmotion(entry.emotion); }}
                          title="Remove emotion"
                        >×</button>
                      </div>

                      {/* Expanded body */}
                      {isExpanded && (
                        <div style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--line-1)" }}>
                          <div style={{ marginBottom: 10 }}>
                            <label style={labelStyle}>Emotional direction</label>
                            <textarea
                              className="input"
                              value={entry.direction}
                              onChange={(e) => {
                                const next = paletteEntries.map((pe) =>
                                  pe.emotion === entry.emotion ? { ...pe, direction: e.target.value } : pe
                                );
                                savePalette(next);
                              }}
                              rows={2}
                              style={{ width: "100%", resize: "vertical", fontSize: 12 }}
                              placeholder="e.g. Slower, more deliberate. Controlled dread just beneath the surface."
                            />
                            <div style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 3 }}>
                              Appended to the base voice description · leave blank to use base voice only
                            </div>
                          </div>

                          {/* Reference status */}
                          {entry.ref_audio_path && (
                            <div style={{
                              display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                              padding: "7px 10px",
                              background: "color-mix(in oklch, var(--st-rendered) 8%, var(--bg-2))",
                              borderRadius: "var(--r)",
                              border: "1px solid color-mix(in oklch, var(--st-rendered) 30%, var(--line-1))",
                            }}>
                              <PlayButton path={entry.ref_audio_path} size={11} />
                              <span style={{
                                flex: 1, fontFamily: "var(--font-mono)", fontSize: 9.5,
                                color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }}>
                                {entry.ref_audio_path.split("/").pop()}
                              </span>
                              <span style={{ fontSize: 9.5, color: "var(--st-rendered)", flexShrink: 0 }}>reference</span>
                            </div>
                          )}

                          {/* Generate + Record buttons */}
                          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                            <button
                              className="btn btn-primary"
                              onClick={() => handleGeneratePaletteTake(entry)}
                              disabled={runningEntry || !voiceDesc.trim() || recordingForEmotion === entry.emotion}
                              style={{
                                background: "var(--tts)", borderColor: "var(--tts)", color: "var(--bg-1)",
                                opacity: !voiceDesc.trim() ? 0.4 : 1,
                              }}
                            >
                              {runningEntry ? "Generating…" : "Generate Take"}
                            </button>
                            {recordingForEmotion !== entry.emotion && (
                              <button
                                className="btn"
                                onClick={() => setRecordingForEmotion(entry.emotion)}
                                disabled={runningEntry || recordingForEmotion !== null}
                                style={{ display: "flex", alignItems: "center", gap: 5 }}
                                title="Record a take directly from your audio interface"
                              >
                                <span style={{
                                  width: 7, height: 7, borderRadius: "50%",
                                  background: "color-mix(in oklch, var(--sfx) 70%, var(--fg-3))",
                                  display: "inline-block", flexShrink: 0,
                                }} />
                                Record Take
                              </button>
                            )}
                            {runningEntry && <RunningBadge label="Synthesising…" />}
                          </div>

                          {/* Inline recorder */}
                          {recordingForEmotion === entry.emotion && char && realProjectId && projectsDir && (
                            <div style={{ marginBottom: 10 }}>
                              <RecordTakePanel
                                outputPath={(() => {
                                  const ts = Date.now();
                                  const palDir = `${projectsDir}/${realProjectId}/characters/${char.id}/palette`;
                                  return `${palDir}/${entry.emotion}_rec_${ts}.wav`;
                                })()}
                                onDone={(path, dur) => handleRecordDone(entry.emotion, path, dur)}
                                onCancel={() => setRecordingForEmotion(null)}
                              />
                            </div>
                          )}

                          {/* Takes list — job-store takes + disk-scanned MCP takes */}
                          {allTakes.length > 0 && (
                            <TakeList label={`Takes · ${allTakes.length}`}>
                              {allTakes.map((job, i) => (
                                <TakeRow
                                  key={job.id} job={job} index={i}
                                  saveLabel="Approve as reference"
                                  isSaved={entry.ref_audio_path === job.output_path && entry.qa_status === "approved"}
                                  onSave={() => handlePromotePaletteTake(entry.emotion, job.output_path!)}
                                  onQa={(s) => {
                                    // Disk-synthesized jobs use a fake id; skip job store update
                                    if (!job.id.startsWith("disk::")) setQaStatus(job.id, s);
                                  }}
                                />
                              ))}
                            </TakeList>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
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

              {referenceAssets.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <label style={labelStyle}>Clip Studio references</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 190, overflowY: "auto" }}>
                    {referenceAssets.slice(0, 24).map((asset) => {
                      const active = refPath === asset.audio_path;
                      return (
                        <button
                          key={asset.audio_path}
                          onClick={() => saveVoice({ ref_audio_path: asset.audio_path, model: "Clone" })}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "74px 1fr auto",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            textAlign: "left",
                            padding: "7px 8px",
                            border: `1px solid ${active ? "var(--tts)" : "var(--line-1)"}`,
                            borderRadius: "var(--r)",
                            background: active ? "color-mix(in oklch, var(--tts) 12%, var(--bg-1))" : "var(--bg-1)",
                            color: "var(--fg-1)",
                            cursor: "pointer",
                          }}
                        >
                          {referencePeaks[asset.audio_path] ? (
                            <PeaksWave peaks={referencePeaks[asset.audio_path]} width={74} height={18} color="var(--tts)" opacity={0.75} />
                          ) : (
                            <Wave width={74} height={18} seed={asset.name.charCodeAt(0)} count={22} color="var(--tts)" opacity={0.55} />
                          )}
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: "block", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {basename(asset.audio_path)}
                            </span>
                            <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)", marginTop: 2 }}>
                              {asset.scene_slug} · {asset.model} · {formatDuration(asset.duration_ms)}
                            </span>
                          </span>
                          <PlayButton path={asset.audio_path} size={10} />
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-4)", lineHeight: 1.5, marginTop: 7 }}>
                    Long recordings imported and cropped in Clip Studio appear here as clone-ready references.
                  </div>
                </div>
              )}

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

          {/* ── CORPUS BUILDER (Stage 3) ──────────────────────────────────── */}
          {tab === "corpus" && (
            <CorpusBuilder
              projectId={realProjectId ?? "demo"}
              character={char}
              projectsDir={projectsDir ?? ""}
              corpusCount={char.voice_assignment.rvc?.corpus_count ?? 0}
              corpusDurationMs={char.voice_assignment.rvc?.corpus_duration_ms ?? 0}
              corpusTarget={50}
              onCorpusUpdated={() => {
                // Re-read character from disk (project store handles this via get_project)
                // For now, a no-op — CorpusBuilder polls internally and updates its own UI.
                // A full refresh would call loadProject() here.
              }}
            />
          )}

          {/* ── RVC MODEL (Stage 4) ───────────────────────────────────────── */}
          {tab === "model" && (
            <RvcModelStage
              projectId={realProjectId ?? "demo"}
              character={char}
              projectsDir={projectsDir ?? ""}
              corpusReady={(char.voice_assignment.rvc?.corpus_duration_ms ?? 0) >= 5 * 60 * 1000}
              onModelTrained={() => {
                // A full model refresh would re-read character; no-op until store exposes refresh.
              }}
            />
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
              : char.voice_assignment.model === "Chatterbox" ? "Chatterbox"
              : "Custom"}
          </div>
          {refPath
            ? <div style={{ color: "var(--st-rendered)", fontSize: 10, marginTop: 4 }}>✓ Reference set</div>
            : <div style={{ color: "var(--fg-4)", fontSize: 10, marginTop: 4 }}>No reference</div>}
        </MetaSection>

        {paletteEntries.length > 0 && (
          <MetaSection label="Palette">
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {paletteEntries.map((e) => (
                <div key={e.emotion} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                    background: e.qa_status === "approved" ? "var(--st-rendered)" : "var(--fg-4)",
                  }} />
                  <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{e.label}</span>
                </div>
              ))}
            </div>
          </MetaSection>
        )}

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
