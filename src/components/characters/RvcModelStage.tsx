/**
 * RvcModelStage.tsx
 *
 * Stage 4 of the character voice pipeline. Manages RVC (Retrieval-based Voice
 * Conversion) model training and the production toggle that controls whether
 * all lines for this character run through the Chatterbox → RVC chain.
 *
 * Training takes 10–20 minutes on GPU. The component polls for job completion
 * every 3 seconds and shows a progress bar while the job is running.
 *
 * Key parameters exposed to the operator:
 *   - Pitch shift: transpose the character's voice up/down in semitones
 *   - Index rate: blend strength of the trained voice vs. the source clone;
 *     lower values better preserve paralinguistic tags like [sigh]/[chuckle]
 *   - Protect: fraction of voiced phonemes left unprocessed (preserves breath)
 *
 * The "Enable RVC" toggle writes back to character.voice_assignment.rvc_enabled
 * via the updateCharacter store call (caller's responsibility via onModelTrained).
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Character } from "../../lib/types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RvcModelStageProps {
  projectId: string;
  character: Character;
  projectsDir: string;
  corpusReady: boolean;    // true when corpus has ≥5min of audio
  onModelTrained: () => void;
}

interface RvcModelInfo {
  pth_path: string;
  index_path: string | null;
  pth_size_bytes: number;
  trained_at: string;
  corpus_count: number;
  corpus_duration_ms: number;
}

/** Shape returned by GET /jobs/{id} on the RVC server (via get_rvc_job Tauri cmd). */
interface RvcJobResponse {
  status: "pending" | "running" | "complete" | "failed";
  progress: number;         // 0..1
  output_path: string | null;
  error: string | null;
  message: string | null;   // current stage description, e.g. "Training… 42/100 steps"
}

interface RvcParams {
  pitchShift: number;    // -12 to +12 semitones
  indexRate: number;     // 0 to 1
  protect: number;       // 0 to 0.5
  rvcEnabled: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGE_COLOR = "oklch(0.72 0.12 145)";
const POLL_INTERVAL_MS = 3000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.07em",
  color: "var(--fg-4)",
  textTransform: "uppercase",
  display: "block",
  marginBottom: 4,
};

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontFamily: "var(--font-mono)",
    fontSize: 9.5,
    letterSpacing: "0.08em",
    color: "var(--fg-4)",
    textTransform: "uppercase",
    marginBottom: 10,
    paddingBottom: 5,
    borderBottom: "1px solid var(--line-1)",
  }}>
    {children}
  </div>
);

interface SliderRowProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label, hint, value, min, max, step, format, onChange, disabled,
}) => {
  const [showHint, setShowHint] = useState(false);
  const hintId = `hint-${label.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
        <label style={labelStyle}>{label}</label>
        {hint && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: "1px solid var(--line-2)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              color: "var(--fg-4)",
              cursor: "help",
              flexShrink: 0,
              marginTop: -2,
            }}
            onMouseEnter={() => setShowHint(true)}
            onMouseLeave={() => setShowHint(false)}
            aria-describedby={hintId}
          >?</span>
        )}
      </div>

      {showHint && hint && (
        <div
          id={hintId}
          role="tooltip"
          style={{
            fontSize: 10,
            color: "var(--fg-3)",
            background: "var(--bg-0)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--r)",
            padding: "6px 9px",
            marginBottom: 6,
            lineHeight: 1.55,
          }}
        >
          {hint}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ flex: 1, cursor: disabled ? "not-allowed" : "pointer", accentColor: STAGE_COLOR }}
        />
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--fg-2)",
          width: 52,
          textAlign: "right",
          flexShrink: 0,
        }}>
          {format(value)}
        </span>
      </div>
    </div>
  );
};

interface ProgressBarProps {
  value: number;   // 0..1
  color: string;
  height?: number;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ value, color, height = 6 }) => (
  <div style={{
    width: "100%",
    height,
    borderRadius: height / 2,
    background: "var(--bg-0)",
    border: "1px solid var(--line-1)",
    overflow: "hidden",
  }}>
    <div style={{
      width: `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`,
      height: "100%",
      background: color,
      borderRadius: height / 2,
      transition: "width 0.5s ease",
    }} />
  </div>
);

// ── Main component ───────────────────────────────────────────────────────────

export const RvcModelStage: React.FC<RvcModelStageProps> = ({
  projectId,
  character,
  projectsDir: _projectsDir,
  corpusReady,
  onModelTrained,
}) => {
  const [modelInfo, setModelInfo]           = useState<RvcModelInfo | null>(null);
  const [isTraining, setIsTraining]         = useState(false);
  const [trainProgress, setTrainProgress]   = useState<number>(0);   // 0..1
  const [trainMessage, setTrainMessage]     = useState<string | null>(null);
  const [error, setError]                   = useState<string | null>(null);
  const [confirmRetrain, setConfirmRetrain] = useState(false);
  const [activeJobId, setActiveJobId]       = useState<string | null>(null);
  const [params, setParams]                 = useState<RvcParams>({
    pitchShift: 0,
    indexRate: 0.5,
    protect: 0.33,
    rvcEnabled: false,
  });

  const pollCancelRef = useRef(false);

  // Load existing model info on mount
  const fetchModelInfo = useCallback(async () => {
    try {
      const info = await invoke<RvcModelInfo | null>("get_rvc_model_info", {
        projectId,
        characterId: character.id,
      });
      setModelInfo(info);
    } catch {
      setModelInfo(null);
    }
  }, [projectId, character.id]);

  useEffect(() => {
    fetchModelInfo();
  }, [fetchModelInfo]);

  // Poll training job
  useEffect(() => {
    if (!activeJobId) return;

    pollCancelRef.current = false;

    const poll = async () => {
      while (!pollCancelRef.current) {
        try {
          const resp = await invoke<RvcJobResponse>("get_rvc_job", {
            jobId: activeJobId,
          });

          if (pollCancelRef.current) break;

          setTrainProgress(resp.progress);           // 0..1 from server
          if (resp.message) setTrainMessage(resp.message);

          if (resp.status === "complete" || resp.status === "failed") {
            setIsTraining(false);
            setActiveJobId(null);
            setTrainMessage(null);
            if (resp.error || resp.status === "failed") {
              setError(resp.error ?? "Training failed.");
            } else {
              // Refresh model info from disk
              fetchModelInfo();
              onModelTrained();
            }
            break;
          }
        } catch (e: unknown) {
          if (!pollCancelRef.current) {
            setError(e instanceof Error ? e.message : "Lost contact with training job.");
            setIsTraining(false);
            setActiveJobId(null);
            setTrainMessage(null);
          }
          break;
        }

        await new Promise<void>((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS); });
      }
    };

    poll();
    return () => { pollCancelRef.current = true; };
  }, [activeJobId, onModelTrained]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const startTraining = useCallback(async () => {
    if (isTraining || !corpusReady) return;
    setError(null);
    setIsTraining(true);
    setTrainProgress(0);
    setTrainMessage(null);

    try {
      const jobId = await invoke<string>("submit_rvc_train", {
        projectId,
        characterId: character.id,
        characterName: character.name.toLowerCase().replace(/\s+/g, "_"),
        epochs: 100,
      });
      setActiveJobId(jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start RVC training.");
      setIsTraining(false);
    }
  }, [isTraining, corpusReady, projectId, character.id]);

  const handleRetrain = useCallback(async () => {
    setConfirmRetrain(false);
    setModelInfo(null);
    await startTraining();
  }, [startTraining]);

  const setParam = useCallback(<K extends keyof RvcParams>(key: K, value: RvcParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>

      {/* ── Not trained ── */}
      {!modelInfo && !isTraining && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.7, marginBottom: 16 }}>
            RVC (Retrieval-based Voice Conversion) trains a lightweight neural adapter
            on the character's corpus, producing a .pth model file that acts as a
            permanent vocal fingerprint. Once trained, every Chatterbox take for this
            character is passed through RVC for consistent identity across episodes.
          </p>

          {!corpusReady && (
            <div style={{
              padding: "10px 14px",
              background: "color-mix(in oklch, var(--sfx) 8%, var(--bg-2))",
              border: "1px solid color-mix(in oklch, var(--sfx) 30%, var(--line-1))",
              borderRadius: "var(--r)",
              fontSize: 11,
              color: "var(--sfx)",
              fontFamily: "var(--font-mono)",
              marginBottom: 14,
            }}>
              Corpus not ready — generate at least 5 minutes of training audio in Stage 3 first.
            </div>
          )}

          {error && (
            <div style={{
              padding: "8px 12px",
              background: "color-mix(in oklch, var(--sfx) 8%, var(--bg-2))",
              border: "1px solid color-mix(in oklch, var(--sfx) 35%, var(--line-1))",
              borderRadius: "var(--r)",
              fontSize: 11,
              color: "var(--sfx)",
              marginBottom: 14,
            }}>
              {error}
            </div>
          )}

          <button
            className="btn btn-primary"
            disabled={!corpusReady}
            onClick={startTraining}
            style={{
              background: STAGE_COLOR,
              borderColor: STAGE_COLOR,
              color: "var(--bg-0)",
              opacity: !corpusReady ? 0.4 : 1,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.04em",
            }}
          >
            Train Model
          </button>
        </div>
      )}

      {/* ── Training in progress ── */}
      {isTraining && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            padding: "12px 16px",
            background: `color-mix(in oklch, ${STAGE_COLOR} 8%, var(--bg-2))`,
            border: `1px solid color-mix(in oklch, ${STAGE_COLOR} 25%, var(--line-1))`,
            borderRadius: "var(--r)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: STAGE_COLOR, fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                Training {character.name}…
              </span>
              <span style={{ fontSize: 10, color: "var(--fg-4)", fontFamily: "var(--font-mono)" }}>
                {(trainProgress * 100).toFixed(0)}%
              </span>
            </div>
            <ProgressBar value={trainProgress} color={STAGE_COLOR} height={7} />
            {trainMessage && (
              <div style={{
                marginTop: 7,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: STAGE_COLOR,
                opacity: 0.85,
                letterSpacing: "0.02em",
              }}>
                {trainMessage}
              </div>
            )}
            <p style={{ fontSize: 10, color: "var(--fg-4)", marginTop: 8, lineHeight: 1.5 }}>
              Training takes 20–40 min on Apple Silicon. You can close this panel —
              training continues in the background.
            </p>
          </div>
        </div>
      )}

      {/* ── Model trained (success state) ── */}
      {modelInfo && !isTraining && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            padding: "12px 16px",
            background: "color-mix(in oklch, var(--st-rendered) 8%, var(--bg-2))",
            border: "1px solid color-mix(in oklch, var(--st-rendered) 30%, var(--line-1))",
            borderRadius: "var(--r)",
            marginBottom: 12,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ color: "var(--st-rendered)", fontSize: 14 }}>✓</span>
              <span style={{ fontSize: 12, color: "var(--fg-1)", fontWeight: 500 }}>
                Model trained
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
              <span style={metaRowStyle}>
                <span style={metaLabelStyle}>Model file</span>
                <span style={metaValueStyle}>{basename(modelInfo.pth_path)}</span>
              </span>
              <span style={metaRowStyle}>
                <span style={metaLabelStyle}>Size</span>
                <span style={metaValueStyle}>{formatBytes(modelInfo.pth_size_bytes)}</span>
              </span>
              <span style={metaRowStyle}>
                <span style={metaLabelStyle}>Trained on</span>
                <span style={metaValueStyle}>{modelInfo.corpus_count} takes</span>
              </span>
              <span style={metaRowStyle}>
                <span style={metaLabelStyle}>Audio</span>
                <span style={metaValueStyle}>{formatDuration(modelInfo.corpus_duration_ms)}</span>
              </span>
            </div>
          </div>

          {/* A/B preview */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                // TODO: implement A/B preview — play a reference line through
                // Chatterbox only vs. Chatterbox → RVC so operator can hear the delta
              }}
              style={{
                borderColor: STAGE_COLOR,
                color: STAGE_COLOR,
                background: `color-mix(in oklch, ${STAGE_COLOR} 8%, transparent)`,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            >
              A/B Preview
            </button>
            <span style={{ fontSize: 10, color: "var(--fg-4)" }}>
              Compare Chatterbox vs. Chatterbox → RVC on a test line
            </span>
          </div>
        </div>
      )}

      {/* ── RVC parameters ── */}
      <div style={{ marginBottom: 20 }}>
        <SectionTitle>Voice conversion parameters</SectionTitle>

        <SliderRow
          label="Pitch shift"
          value={params.pitchShift}
          min={-12}
          max={12}
          step={1}
          format={(v) => `${v > 0 ? "+" : ""}${v} st`}
          onChange={(v) => setParam("pitchShift", v)}
          disabled={!modelInfo}
        />

        <SliderRow
          label="Index rate"
          hint={'Lower values preserve [sigh] [chuckle] tags and natural inflection; higher values enforce stronger voice identity but may flatten paralinguistic cues.'}
          value={params.indexRate}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => setParam("indexRate", v)}
          disabled={!modelInfo}
        />

        <SliderRow
          label="Protect"
          value={params.protect}
          min={0}
          max={0.5}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => setParam("protect", v)}
          disabled={!modelInfo}
        />
      </div>

      {/* ── Production toggle ── */}
      <div style={{
        marginBottom: 20,
        padding: "12px 14px",
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--r)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--fg-1)", fontWeight: 500, marginBottom: 3 }}>
              Enable RVC on production lines
            </div>
            <div style={{ fontSize: 10.5, color: "var(--fg-4)", lineHeight: 1.55 }}>
              When on, all Chatterbox takes for {character.name} are passed through RVC.
              When off, lines use Chatterbox only — faster, but no voice fingerprint.
            </div>
          </div>
          <label style={{
            display: "flex",
            alignItems: "center",
            cursor: modelInfo ? "pointer" : "not-allowed",
            opacity: modelInfo ? 1 : 0.4,
            flexShrink: 0,
          }}>
            <input
              type="checkbox"
              checked={params.rvcEnabled}
              disabled={!modelInfo}
              onChange={(e) => setParam("rvcEnabled", e.target.checked)}
              style={{ accentColor: STAGE_COLOR, width: 16, height: 16 }}
            />
          </label>
        </div>
      </div>

      {/* ── Error display (post-load) ── */}
      {error && !isTraining && (
        <div style={{
          marginBottom: 14,
          padding: "8px 12px",
          background: "color-mix(in oklch, var(--sfx) 8%, var(--bg-2))",
          border: "1px solid color-mix(in oklch, var(--sfx) 35%, var(--line-1))",
          borderRadius: "var(--r)",
          fontSize: 11,
          color: "var(--sfx)",
        }}>
          {error}
        </div>
      )}

      {/* ── Retrain (destructive) ── */}
      {modelInfo && !isTraining && (
        <div style={{ borderTop: "1px solid var(--line-1)", paddingTop: 14 }}>
          {!confirmRetrain ? (
            <button
              className="btn btn-sm"
              onClick={() => setConfirmRetrain(true)}
              style={{
                color: "var(--sfx)",
                borderColor: "color-mix(in oklch, var(--sfx) 40%, var(--line-1))",
                background: "color-mix(in oklch, var(--sfx) 6%, transparent)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            >
              Retrain Model
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--sfx)", fontFamily: "var(--font-mono)" }}>
                This discards the current model. Continue?
              </span>
              <button
                className="btn btn-sm"
                onClick={handleRetrain}
                style={{
                  background: "color-mix(in oklch, var(--sfx) 18%, transparent)",
                  borderColor: "var(--sfx)",
                  color: "var(--sfx)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                }}
              >
                Yes, retrain
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setConfirmRetrain(false)}
                style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── Meta row helpers ─────────────────────────────────────────────────────────

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const metaLabelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  letterSpacing: "0.07em",
  color: "var(--fg-4)",
  textTransform: "uppercase",
};

const metaValueStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--fg-2)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
