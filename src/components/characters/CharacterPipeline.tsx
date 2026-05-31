/**
 * CharacterPipeline.tsx
 *
 * Horizontal pipeline progress indicator for the character voice design workflow.
 * Replaces the flat tab strip in CharacterDesignerView with a four-stage chip bar
 * that shows completion status and locks downstream stages until their dependencies
 * are met. Each chip is clickable when the stage is accessible; locked chips are
 * visually dimmed and cursor: not-allowed.
 *
 * Stage dependency chain:
 *   Voice (1) → Palette (2) → Corpus (3) → Model (4)
 *
 * Stage 2 requires stage 1 done; stage 3 requires stage 2 done;
 * stage 4 requires corpus to be "ready" (corpusCount >= corpusTarget).
 */

import React from "react";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CharacterPipelineProps {
  stage1Done: boolean;      // has base voice description + at least 1 design take
  stage2Done: boolean;      // has ≥2 approved palette entries
  corpusCount: number;      // WAV files in rvc_corpus/
  corpusTarget: number;     // target (default 50)
  corpusDurationMs: number; // total corpus audio duration
  modelTrained: boolean;    // rvc .pth file exists
  rvcEnabled: boolean;      // whether RVC is toggled on for production
  /**
   * Whether the RVC half of the pipeline (Corpus + Model stages) is opted in
   * for this character — true when `voice_assignment.production_pipeline ===
   * "chatterbox+rvc"`. When false, stages 3 and 4 are hidden entirely and an
   * "+ RVC pipeline" toggle is shown in their place. (Pharaoh-9sx)
   */
  rvcPipelineActive: boolean;
  /** Called when the user toggles RVC opt-in. */
  onToggleRvcPipeline: (active: boolean) => void;
  activeStage: 1 | 2 | 3 | 4;
  onSelectStage: (stage: 1 | 2 | 3 | 4) => void;
}

// ── Stage colours (one per stage, not using css vars so they survive --bg theming) ──

const STAGE_COLORS: Record<1 | 2 | 3 | 4, string> = {
  1: "oklch(0.72 0.12 260)",
  2: "oklch(0.72 0.14 75)",
  3: "oklch(0.72 0.16 25)",
  4: "oklch(0.72 0.12 145)",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

type StageStatus = "done" | "active" | "progress" | "locked";

function stageStatus(
  _stage: 1 | 2 | 3 | 4,
  locked: boolean,
  done: boolean,
  active: boolean,
  hasProgress: boolean,
): StageStatus {
  if (locked) return "locked";
  if (done) return "done";
  if (active && hasProgress) return "progress";
  return active ? "active" : "progress";
}

function formatDurationShort(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// ── StatusDot ────────────────────────────────────────────────────────────────

const StatusDot: React.FC<{ status: StageStatus; color: string }> = ({ status, color }) => {
  const base: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background 0.2s",
  };

  if (status === "done") {
    return <span style={{ ...base, background: "var(--st-rendered)" }} />;
  }
  if (status === "locked") {
    return (
      <span style={{
        ...base,
        border: "1.5px solid var(--line-2)",
        background: "transparent",
      }} />
    );
  }
  if (status === "progress") {
    return (
      <span style={{
        ...base,
        border: `1.5px solid ${color}`,
        background: `color-mix(in oklch, ${color} 30%, transparent)`,
      }} />
    );
  }
  // active (no real progress yet) — pulsing ring
  return (
    <span style={{
      ...base,
      border: `1.5px solid ${color}`,
      background: `color-mix(in oklch, ${color} 20%, transparent)`,
      boxShadow: `0 0 0 2px color-mix(in oklch, ${color} 22%, transparent)`,
    }} />
  );
};

// ── StageChip ────────────────────────────────────────────────────────────────

interface StageChipProps {
  stageNum: 1 | 2 | 3 | 4;
  label: string;
  statusLine: string;
  status: StageStatus;
  isActive: boolean;
  onClick: () => void;
}

const StageChip: React.FC<StageChipProps> = ({
  stageNum, label, statusLine, status, isActive, onClick,
}) => {
  const color = STAGE_COLORS[stageNum];
  const locked = status === "locked";
  const done = status === "done";

  const borderColor = isActive
    ? color
    : done
    ? "var(--st-rendered)"
    : locked
    ? "var(--line-1)"
    : "var(--line-2)";

  const bg = isActive
    ? `color-mix(in oklch, ${color} 10%, var(--bg-2))`
    : "var(--bg-2)";

  return (
    <button
      onClick={locked ? undefined : onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: "8px 12px",
        minWidth: 120,
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--r)",
        cursor: locked ? "not-allowed" : "pointer",
        opacity: locked ? 0.45 : 1,
        transition: "border-color 0.15s, background 0.15s, opacity 0.15s",
        textAlign: "left",
        position: "relative",
      }}
      aria-current={isActive ? "true" : undefined}
      aria-disabled={locked}
    >
      {/* Stage number + name row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <StatusDot status={status} color={color} />
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: 8.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: locked ? "var(--fg-4)" : isActive ? color : done ? "var(--st-rendered)" : "var(--fg-3)",
          fontWeight: 600,
        }}>
          {stageNum} · {label}
        </span>
      </div>

      {/* One-line status */}
      <span style={{
        fontSize: 10,
        color: locked ? "var(--fg-4)" : "var(--fg-3)",
        lineHeight: 1.4,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}>
        {statusLine}
      </span>

      {/* Active stage underline accent */}
      {isActive && (
        <span style={{
          position: "absolute",
          bottom: -1,
          left: 8,
          right: 8,
          height: 2,
          background: color,
          borderRadius: 1,
        }} />
      )}
    </button>
  );
};

// ── Connector arrow ───────────────────────────────────────────────────────────

const Connector: React.FC<{ dim: boolean }> = ({ dim }) => (
  <div style={{
    display: "flex",
    alignItems: "center",
    gap: 0,
    opacity: dim ? 0.25 : 0.7,
    flexShrink: 0,
    color: "var(--fg-4)",
    transition: "opacity 0.2s",
    userSelect: "none",
    fontSize: 14,
    lineHeight: 1,
    paddingBottom: 2,
  }}>
    ──→
  </div>
);

// ── Main component ───────────────────────────────────────────────────────────

export const CharacterPipeline: React.FC<CharacterPipelineProps> = ({
  stage1Done,
  stage2Done,
  corpusCount,
  corpusTarget,
  corpusDurationMs,
  modelTrained,
  rvcEnabled,
  rvcPipelineActive,
  onToggleRvcPipeline,
  activeStage,
  onSelectStage,
}) => {
  // Locking logic — a stage is locked if its upstream dependency isn't done
  const stage2Locked = !stage1Done;
  const stage3Locked = !stage2Done;
  const stage4Locked = corpusCount < corpusTarget;

  // Per-stage status lines
  const s1StatusLine = stage1Done ? "voice locked in" : "write description";
  const s2StatusLine = stage2Done
    ? "palette complete"
    : stage2Locked
    ? "finish voice first"
    : "add emotions";
  const s3StatusLine = stage3Locked
    ? "finish palette first"
    : corpusDurationMs >= 5 * 60 * 1000
    ? `${corpusCount}/${corpusTarget} · ready`
    : corpusCount > 0
    ? `${corpusCount}/${corpusTarget} · ${formatDurationShort(corpusDurationMs)}`
    : "generate training data";
  const s4StatusLine = stage4Locked
    ? "corpus needed"
    : modelTrained
    ? rvcEnabled ? "trained · on" : "trained · off"
    : "not trained yet";

  // StageStatus for each
  const s1Status = stageStatus(1, false, stage1Done, activeStage === 1, false);
  const s2Status = stageStatus(2, stage2Locked, stage2Done, activeStage === 2, false);
  const s3Status: StageStatus = stage3Locked
    ? "locked"
    : corpusCount > 0 && corpusCount < corpusTarget
    ? "progress"
    : corpusCount >= corpusTarget
    ? "done"
    : activeStage === 3
    ? "active"
    : "progress";
  const s4Status: StageStatus = stage4Locked
    ? "locked"
    : modelTrained
    ? "done"
    : activeStage === 4
    ? "active"
    : "progress";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "10px 20px",
      borderBottom: "1px solid var(--line-1)",
      background: "var(--bg-1)",
      flexShrink: 0,
      overflowX: "auto",
    }}>
      <StageChip
        stageNum={1} label="Voice" statusLine={s1StatusLine}
        status={s1Status} isActive={activeStage === 1}
        onClick={() => onSelectStage(1)}
      />
      <Connector dim={stage2Locked} />
      <StageChip
        stageNum={2} label="Palette" statusLine={s2StatusLine}
        status={s2Status} isActive={activeStage === 2}
        onClick={() => onSelectStage(2)}
      />
      {rvcPipelineActive ? (
        <>
          <Connector dim={stage3Locked} />
          <StageChip
            stageNum={3} label="Corpus" statusLine={s3StatusLine}
            status={s3Status} isActive={activeStage === 3}
            onClick={() => onSelectStage(3)}
          />
          <Connector dim={stage4Locked} />
          <StageChip
            stageNum={4} label="Model" statusLine={s4StatusLine}
            status={s4Status} isActive={activeStage === 4}
            onClick={() => onSelectStage(4)}
          />
          <button
            onClick={() => onToggleRvcPipeline(false)}
            title="Remove RVC pipeline (keeps any trained model on disk, just hides the stages)"
            style={{
              marginLeft: 8,
              padding: "4px 8px",
              fontSize: 10, color: "var(--fg-4)",
              background: "transparent", border: "1px dashed var(--line-2)",
              borderRadius: "var(--r)", cursor: "pointer",
            }}
          >
            − RVC
          </button>
        </>
      ) : (
        <button
          onClick={() => onToggleRvcPipeline(true)}
          title="Opt in to the Corpus + Model RVC pipeline for this character"
          style={{
            marginLeft: 8,
            padding: "6px 12px",
            fontSize: 10, color: "var(--fg-3)",
            background: "var(--bg-2)", border: "1px dashed var(--line-2)",
            borderRadius: "var(--r)", cursor: "pointer",
            fontFamily: "var(--font-mono)", letterSpacing: "0.06em", textTransform: "uppercase",
          }}
        >
          + RVC pipeline
        </button>
      )}
    </div>
  );
};
