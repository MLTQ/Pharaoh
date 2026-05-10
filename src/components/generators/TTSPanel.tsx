import React, { useEffect, useMemo, useState } from "react";
import { Icon, PeaksWave, Wave } from "../shared/atoms";
import { TakeRow, TakeList, EmptyTakes } from "../shared/TakeList";
import { PlayButton } from "../shared/PlayButton";
import { SceneRouter } from "./RichDirector";
import { useGenerateJob } from "../../hooks/useGenerateJob";
import { useProjectStore, deriveSlug } from "../../store/projectStore";
import { useJobStore } from "../../store/jobStore";
import { listGeneratedAudioAssets } from "../../lib/tauriCommands";
import { routeAudioToScene } from "../../lib/assetRouting";
import { usePeaksStore } from "../../store/peaksStore";
import { useRegenerateStore } from "../../store/regenerateStore";
import type { GeneratedAudioAsset, MockScene } from "../../lib/types";

const CHAR_HUE = (id: string) => (id.charCodeAt(0) * 13) % 360;

interface TTSPanelProps {
  scenes: MockScene[];
  defaultScene: string;
}

interface SelectableTake {
  audioPath: string;
  label: string;
  prompt: string;
  durationMs: number | null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export const TTSPanel: React.FC<TTSPanelProps> = ({ scenes, defaultScene }) => {
  const { characters, realProjectId, setActiveScene } = useProjectStore();
  const { jobs, setQaStatus } = useJobStore();
  const [scene, setScene]         = useState(defaultScene);
  const [speakerId, setSpeakerId] = useState(characters[0]?.id ?? "");
  const [line, setLine]           = useState("");
  const [direction, setDirection] = useState(characters[0]?.voice_assignment.instruct_default ?? "");
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.9);
  const [maxNewTokens, setMaxNewTokens] = useState(2048);
  const [seed, setSeed] = useState(Math.floor(Math.random() * 99999));
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAudioAsset[]>([]);
  const [assetPeaks, setAssetPeaks] = useState<Record<string, number[]>>({});
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]   = useState<string | null>(null);
  const [selectedTakePath, setSelectedTakePath] = useState<string | null>(null);
  const [routeMessage, setRouteMessage] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);
  const { submitTts } = useGenerateJob();

  const selectedScene = scenes.find((s) => s.no === scene) ?? scenes[0];
  const sceneSlug = selectedScene ? (selectedScene.slug ?? deriveSlug(selectedScene.no, selectedScene.title)) : "";

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
  const completedJobPaths = new Set(takes.map((j) => j.output_path).filter(Boolean));
  const persistedOnly = generatedAssets.filter((asset) => !completedJobPaths.has(asset.audio_path));
  const selectableTakes = useMemo<SelectableTake[]>(() => {
    const jobTakes = takes
      .filter((job): job is Job & { output_path: string } => job.status === "complete" && !!job.output_path)
      .map((job, index) => ({
        audioPath: job.output_path,
        label: `take ${takes.length - index}`,
        prompt: job.description,
        durationMs: null,
      }));
    const persistedTakes = persistedOnly.map((asset) => ({
      audioPath: asset.audio_path,
      label: basename(asset.audio_path),
      prompt: asset.prompt || asset.name,
      durationMs: asset.duration_ms,
    }));
    return [...jobTakes, ...persistedTakes];
  }, [takes, persistedOnly]);
  const selectedTake = selectableTakes.find((take) => take.audioPath === selectedTakePath) ?? null;

  const selectedChar = characters.find((c) => c.id === speakerId) ?? characters[0];
  const selectedVoice = selectedChar?.voice_assignment;
  const customSpeaker = selectedVoice?.speaker || "Vivian";

  useEffect(() => {
    if (speakerId || !characters[0]) return;
    setSpeakerId(characters[0].id);
    setDirection(characters[0].voice_assignment.instruct_default ?? "");
  }, [characters, speakerId]);

  useEffect(() => {
    setScene(defaultScene);
  }, [defaultScene]);

  // Pickup point for "regenerate with same params" — AssetBrowser stashes a
  // sidecar in the regenerateStore and routes here. We hydrate the inputs
  // from the meta and clear the request so the next mount doesn't re-fire.
  const regenerateRequest = useRegenerateStore((s) => s.pending);
  const clearRegenerate = useRegenerateStore((s) => s.clearPending);
  useEffect(() => {
    if (!regenerateRequest || regenerateRequest.model !== "tts") return;
    const meta = regenerateRequest.meta;
    if (meta.prompt) setLine(meta.prompt);
    if (meta.instruct) setDirection(meta.instruct);
    if (meta.temperature != null) setTemperature(meta.temperature);
    if (meta.top_p != null) setTopP(meta.top_p);
    if (meta.seed != null) setSeed(meta.seed);
    // Speaker hint: try to match a character whose voice assignment uses
    // this preset speaker. Falls back to leaving the existing selection.
    if (meta.speaker) {
      const match = characters.find((c) => c.voice_assignment.speaker === meta.speaker);
      if (match) setSpeakerId(match.id);
    }
    clearRegenerate();
  }, [regenerateRequest, characters, clearRegenerate]);

  // Only re-fetch when a relevant job *settles* (complete/failed) — not on every
  // progress tick. The jobs array updates ~2x/sec during generation; depending
  // on the entire array burns Tauri IPC cycles for nothing.
  const completedJobsKey = useMemo(
    () => jobs
      .filter((j) => j.scene_slug === sceneSlug && j.model === "tts" && (j.status === "complete" || j.status === "failed"))
      .map((j) => `${j.id}:${j.status}`)
      .join("|"),
    [jobs, sceneSlug],
  );

  useEffect(() => {
    if (!realProjectId || !sceneSlug) return;
    listGeneratedAudioAssets(realProjectId)
      .then((assets) => {
        setGeneratedAssets(assets.filter((asset) =>
          asset.kind === "tts"
          && asset.scene_slug === sceneSlug
          && asset.model.toLowerCase().startsWith("qwen3-tts")
        ));
      })
      .catch(() => {});
  }, [realProjectId, sceneSlug, completedJobsKey]);

  // Pull peaks through the session-scoped store. First call per session +
  // resolution hits Rust, which itself reads/writes the on-disk cache; every
  // subsequent call is an in-memory map lookup.
  const fetchPeaks = usePeaksStore((s) => s.fetchPeaks);
  useEffect(() => {
    for (const asset of generatedAssets) {
      if (assetPeaks[asset.audio_path]) continue;
      fetchPeaks(asset.audio_path, 120)
        .then((peaks) => setAssetPeaks((prev) => ({ ...prev, [asset.audio_path]: peaks })))
        .catch(() => {});
    }
  }, [generatedAssets, assetPeaks, fetchPeaks]);

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
    setActiveScene(scene);
    try {
      await submitTts({
        text: line.trim(),
        speaker: customSpeaker,
        character: selectedChar,
        instruct: direction.trim(),
        seed,
        temperature,
        topP,
        maxNewTokens,
      });
      setSeed(Math.floor(Math.random() * 99999));
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleSendToScene = async () => {
    if (!selectedTake) {
      setRouteMessage("Select a completed take first.");
      return;
    }
    if (!realProjectId || !sceneSlug) {
      setRouteMessage("Open a project and scene before routing audio.");
      return;
    }

    setRouting(true);
    setRouteMessage(null);
    setActiveScene(scene);
    try {
      const result = await routeAudioToScene({
        projectId: realProjectId,
        sceneSlug,
        kind: "tts",
        audioPath: selectedTake.audioPath,
        durationMs: selectedTake.durationMs,
      });
      setRouteMessage(`Sent ${selectedTake.label} to dialogue row ${result.rowIndex + 1}${result.replaced ? " (replaced)" : ""}.`);
    } catch (e) {
      setRouteMessage(`Send failed: ${String(e)}`);
    } finally {
      setRouting(false);
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

        <SceneRouter scenes={scenes} scene={scene} setScene={(next) => { setScene(next); setActiveScene(next); }} accent="var(--tts)" onSend={handleSendToScene} />
        {routeMessage && (
          <div style={{
            marginTop: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: routeMessage.startsWith("Sent ") ? "var(--st-rendered)" : "var(--sfx)",
            letterSpacing: "0.04em",
          }}>
            {routeMessage}
          </div>
        )}

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
              <span>Temperature</span>
              <span className="hint">{temperature.toFixed(2)}</span>
            </div>
            <div className="slider-row">
              <input
                type="range" className="slider tts"
                min="0.1" max="1.5" step="0.01"
                value={temperature} onChange={(e) => setTemperature(Number(e.target.value))}
              />
              <span className="slider-val">{temperature.toFixed(2)}</span>
            </div>
          </div>
          <div className="field">
            <div className="field-label">
              <span>Top-p</span>
              <span className="hint">{topP.toFixed(2)}</span>
            </div>
            <input type="range" className="slider tts" min="0.1" max="1" step="0.01" value={topP} onChange={(e) => setTopP(Number(e.target.value))} />
          </div>
        </div>

        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="field">
            <div className="field-label"><span>Max tokens</span><span className="hint">generation cap</span></div>
            <input className="input" type="number" min={128} max={4096} step={128} value={maxNewTokens} onChange={(e) => setMaxNewTokens(Number(e.target.value) || 2048)} />
          </div>
          <div className="field">
            <div className="field-label"><span>Seed</span><span className="hint">deterministic</span></div>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} />
              <button className="btn btn-sm" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>roll</button>
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
          {takes.length === 0 && persistedOnly.length === 0 ? (
            <EmptyTakes label="No takes yet — generate a line above." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {takes.length > 0 && (
                <TakeList label={`${takes.length} active take${takes.length === 1 ? "" : "s"}`}>
                  {takes.map((job, i) => {
                    const selectable = job.status === "complete" && !!job.output_path;
                    const active = selectable && selectedTakePath === job.output_path;
                    return (
                      <div
                        key={job.id}
                        role={selectable ? "button" : undefined}
                        tabIndex={selectable ? 0 : undefined}
                        onClick={() => selectable && setSelectedTakePath(job.output_path)}
                        onKeyDown={(event) => {
                          if (!selectable || (event.key !== "Enter" && event.key !== " ")) return;
                          event.preventDefault();
                          setSelectedTakePath(job.output_path);
                        }}
                        style={{
                          cursor: selectable ? "pointer" : "default",
                          borderLeft: active ? "2px solid var(--tts)" : "2px solid transparent",
                          background: active ? "color-mix(in oklch, var(--tts) 10%, var(--bg-1))" : undefined,
                        }}
                      >
                        <TakeRow
                          job={job}
                          index={takes.length - 1 - i}
                          caption={job.description}
                          onQa={(s) => setQaStatus(job.id, s)}
                        />
                      </div>
                    );
                  })}
                </TakeList>
              )}
              {persistedOnly.map((asset) => (
                <div
                  key={asset.audio_path}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedTakePath(asset.audio_path)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelectedTakePath(asset.audio_path);
                  }}
                  style={{
                    border: `1px solid ${selectedTakePath === asset.audio_path ? "var(--tts)" : "var(--line-1)"}`,
                    borderLeft: `2px solid ${selectedTakePath === asset.audio_path ? "var(--tts)" : "transparent"}`,
                    background: selectedTakePath === asset.audio_path ? "color-mix(in oklch, var(--tts) 10%, var(--bg-1))" : "transparent",
                    borderRadius: "var(--r)",
                    padding: 8,
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 8,
                    alignItems: "center",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    {assetPeaks[asset.audio_path] ? (
                      <PeaksWave peaks={assetPeaks[asset.audio_path]} width={180} height={20} color="var(--tts)" opacity={0.8} />
                    ) : (
                      <Wave width={180} height={20} seed={asset.name.charCodeAt(0)} count={36} color="var(--tts)" opacity={0.6} />
                    )}
                    <div style={{ marginTop: 4, fontSize: 10, color: "var(--fg-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={asset.prompt}>
                      {asset.prompt || asset.name}
                    </div>
                  </div>
                  <PlayButton path={asset.audio_path} size={11} />
                </div>
              ))}
              {selectableTakes.length > 0 && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: selectedTake ? "var(--tts)" : "var(--fg-4)", letterSpacing: "0.05em" }}>
                  {selectedTake ? `selected · ${selectedTake.label}` : "select a completed take to route it"}
                  {routing ? " · sending..." : ""}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
