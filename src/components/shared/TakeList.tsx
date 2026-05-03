import React from "react";
import { Wave, PeaksWave } from "./atoms";
import { PlayButton } from "./PlayButton";
import type { Job, QaJobStatus } from "../../lib/types";

interface TakeRowProps {
  job: Job;
  index: number;
  // If onSave is provided a save button renders; otherwise it's omitted
  saveLabel?: string;
  isSaved?: boolean;
  onSave?: () => void;
  onQa?: (status: QaJobStatus) => void;
  // Optional secondary text under the waveform (e.g. the dialogue)
  caption?: string;
  // Color accent for the wave
  accent?: string;
}

export const TakeRow: React.FC<TakeRowProps> = ({
  job, index, saveLabel, isSaved, onSave, onQa, caption, accent = "var(--tts)",
}) => {
  const running = job.status === "running" || job.status === "pending";
  const failed  = job.status === "failed";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 12px",
      background: isSaved ? "color-mix(in oklch, var(--tts) 8%, var(--bg-1))" : undefined,
      borderLeft: isSaved ? "2px solid var(--tts)" : "2px solid transparent",
      borderBottom: "1px solid var(--line-1)",
      opacity: failed ? 0.7 : 1,
    }}>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-4)",
        letterSpacing: "0.06em", minWidth: 40,
      }}>
        take {index + 1}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {failed ? (
          <span style={{ fontSize: 10, color: "var(--sfx)" }} title={job.error ?? "failed"}>
            failed — {job.error?.slice(0, 60) ?? "unknown error"}
          </span>
        ) : running ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: accent, fontFamily: "var(--font-mono)" }}>
              ◐ {Math.round(job.progress)}%
            </span>
            <Wave width={100} height={14} seed={job.id.charCodeAt(0)} count={20} color={accent} opacity={0.4} />
          </div>
        ) : job.peaks ? (
          <PeaksWave peaks={job.peaks} width={140} height={18} color={accent} opacity={0.8} />
        ) : (
          <Wave width={140} height={18} seed={job.id.charCodeAt(0)} count={28} color={accent} opacity={0.6} />
        )}
        {caption && !running && !failed && (
          <div style={{
            fontSize: 10, color: "var(--fg-4)", marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }} title={caption}>
            {caption}
          </div>
        )}
      </div>
      {!running && !failed && <PlayButton path={job.output_path} size={11} />}
      {onQa && !running && !failed && (
        <>
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
        </>
      )}
      {onSave && !running && !failed && (
        <button
          className={`btn btn-sm${isSaved ? " btn-primary" : ""}`}
          style={isSaved ? { borderColor: "var(--tts)", color: "var(--tts)" } : undefined}
          onClick={() => !isSaved && onSave()}
          disabled={isSaved}
        >
          {isSaved ? "saved ✓" : (saveLabel ?? "save")}
        </button>
      )}
    </div>
  );
};

export const TakeList: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ borderRadius: "var(--r)", border: "1px solid var(--line-1)", overflow: "hidden" }}>
    <div style={{
      padding: "6px 12px", background: "var(--bg-2)",
      fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-4)",
      letterSpacing: "0.07em", textTransform: "uppercase",
    }}>
      {label}
    </div>
    {children}
  </div>
);

export const RunningBadge: React.FC<{ label: string }> = ({ label }) => (
  <div style={{
    padding: "8px 12px", marginBottom: 10,
    background: "color-mix(in oklch, var(--tts) 8%, var(--bg-2))",
    borderRadius: "var(--r)", fontSize: 11, color: "var(--tts)",
    fontFamily: "var(--font-mono)",
  }}>
    ◐ {label}
  </div>
);

export const EmptyTakes: React.FC<{ label: string }> = ({ label }) => (
  <div style={{
    padding: "24px", textAlign: "center",
    border: "1px dashed var(--line-2)", borderRadius: "var(--r)",
    fontSize: 11, color: "var(--fg-4)", lineHeight: 1.6,
  }}>
    {label}
  </div>
);

// Job filter helper that accepts both production-panel takes (current scene + row 0)
// and character-designer takes (synthetic char-scene slug + design/clone rows).
export function selectTakes(
  jobs: Job[],
  predicate: (j: Job) => boolean,
): Job[] {
  return [...jobs]
    .filter((j) => j.model === "tts" && predicate(j) && (j.status === "complete" || j.status === "running" || j.status === "failed" || j.status === "pending"))
    .reverse();
}
