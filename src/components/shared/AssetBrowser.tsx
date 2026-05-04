import React from "react";
import { Icon, Wave, PeaksWave } from "./atoms";
import { PlayButton } from "./PlayButton";
import { useJobStore, takeKey } from "../../store/jobStore";
import { useProjectStore } from "../../store/projectStore";
import { updateScriptRow, updateSidecarQa } from "../../lib/tauriCommands";
import type { Job, MockAssets, QaJobStatus } from "../../lib/types";

interface AssetBrowserProps {
  assets: MockAssets;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const KIND_COLOR: Record<string, string> = {
  tts:   "var(--tts)",
  sfx:   "var(--sfx)",
  music: "var(--music)",
};

// ── Take group ─────────────────────────────────────────────────────────────

const QA_COLORS: Record<QaJobStatus, string> = {
  unreviewed: "var(--fg-4)",
  approved:   "var(--st-rendered)",
  rejected:   "var(--sfx)",
};

interface TakeGroupProps {
  jobs: Job[];            // all completed takes for one row, oldest-first
  activeJobId: string | null;
  onUse: (job: Job) => void;
  onQa: (job: Job, status: QaJobStatus) => void;
}

const TakeGroup: React.FC<TakeGroupProps> = ({ jobs, activeJobId, onUse, onQa }) => {
  const color = KIND_COLOR[jobs[0].model] ?? "currentColor";
  return (
    <div style={{ borderBottom: "1px solid var(--line-1)" }}>
      {jobs.map((job, ti) => {
        const isActive = job.id === activeJobId;
        const qaColor = QA_COLORS[job.qa_status];
        return (
          <div
            key={job.id}
            className={`asset-row ${job.model}`}
            style={{
              background: isActive ? `color-mix(in oklch, ${color} 8%, var(--bg-1))` : undefined,
              borderLeft: isActive ? `2px solid ${color}` : "2px solid transparent",
            }}
          >
            <div className="swatch" />
            <div className="wave">
              {job.peaks ? (
                <PeaksWave peaks={job.peaks} width={120} height={24} color={color} opacity={0.85} />
              ) : (
                <Wave width={120} height={24} seed={job.id.charCodeAt(0) + job.id.charCodeAt(1)} count={28} color={color} opacity={0.7} />
              )}
            </div>
            <div className="meta">
              <span className="name" title={job.output_path ?? undefined}>
                take {ti + 1} · {basename(job.output_path!)}
              </span>
              <span className="sub">{job.description}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <PlayButton path={job.output_path} size={12} />
              {/* QA approve/reject */}
              <button
                className="btn btn-sm"
                style={{
                  padding: "2px 4px", minWidth: 0,
                  color: job.qa_status === "approved" ? "var(--st-rendered)" : "var(--fg-4)",
                  borderColor: job.qa_status === "approved" ? "var(--st-rendered)" : undefined,
                }}
                title="Approve take"
                onClick={() => onQa(job, job.qa_status === "approved" ? "unreviewed" : "approved")}
              >✓</button>
              <button
                className="btn btn-sm"
                style={{
                  padding: "2px 4px", minWidth: 0,
                  color: job.qa_status === "rejected" ? "var(--sfx)" : "var(--fg-4)",
                  borderColor: job.qa_status === "rejected" ? "var(--sfx)" : undefined,
                }}
                title="Reject take"
                onClick={() => onQa(job, job.qa_status === "rejected" ? "unreviewed" : "rejected")}
              >✕</button>
              {/* QA badge */}
              {job.qa_status !== "unreviewed" && (
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.06em",
                  color: qaColor, textTransform: "uppercase",
                }}>{job.qa_status}</span>
              )}
              {/* Use / using button */}
              <button
                className={`btn btn-sm${isActive ? " btn-primary" : ""}`}
                style={isActive ? { borderColor: color, color } : undefined}
                onClick={() => !isActive && onUse(job)}
                disabled={isActive}
              >
                {isActive ? "using" : "use"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ── Asset browser ─────────────────────────────────────────────────────────

export const AssetBrowser: React.FC<AssetBrowserProps> = ({ assets }) => {
  const { jobs, activeTakes, setActiveTake, setQaStatus } = useJobStore();
  const { realProjectId } = useProjectStore();

  const completedByModel = (model: "tts" | "sfx" | "music") =>
    jobs.filter(j => j.model === model && j.status === "complete" && j.output_path);

  // Group completed jobs by "{scene_slug}:{row_index}", sort each group oldest-first
  function groupByRow(completed: Job[]): Map<string, Job[]> {
    const map = new Map<string, Job[]>();
    // Jobs are newest-first in the store; reverse so takes are oldest-first
    [...completed].reverse().forEach((j) => {
      if (j.scene_slug == null || j.row_index == null) return;
      const k = takeKey(j.scene_slug, j.row_index);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(j);
    });
    return map;
  }

  const handleQa = (job: Job, status: QaJobStatus) => {
    setQaStatus(job.id, status);
    if (job.output_path) {
      updateSidecarQa({
        audioPath: job.output_path,
        qaStatus: status,
        qaNotes: "",
      }).catch(console.error);
    }
  };

  const handleUse = (job: Job) => {
    if (!job.output_path || job.scene_slug == null || job.row_index == null) return;
    setActiveTake(job.scene_slug, job.row_index, job.id);
    if (realProjectId) {
      updateScriptRow({
        projectId: realProjectId,
        sceneSlug: job.scene_slug,
        rowIndex: job.row_index,
        fields: { file: job.output_path },
      }).catch(console.error);
    }
  };

  function renderSection(
    label: string,
    eyebrow: string,
    model: "tts" | "sfx" | "music",
    color: string,
    mockItems: typeof assets.dialogue,
    seed0: number,
    barCount: number,
  ) {
    const completed = completedByModel(model);
    const groups = groupByRow(completed);
    const total = mockItems.length + completed.length;

    return (
      <>
        <div className="asset-group-head">
          <span>{label} · {total}</span>
          <span style={{ color: "var(--fg-4)" }}>{eyebrow}</span>
        </div>
        {Array.from(groups.entries()).map(([key, groupJobs]) => (
          <TakeGroup
            key={key}
            jobs={groupJobs}
            activeJobId={activeTakes[key] ?? null}
            onUse={handleUse}
            onQa={handleQa}
          />
        ))}
        {mockItems.map((a, i) => (
          <div key={a.id} className={`asset-row ${a.kind}`}>
            <div className="swatch" />
            <div className="wave">
              {a.peaks ? (
                <PeaksWave peaks={a.peaks} width={120} height={24} color={color} opacity={0.85} />
              ) : (
                <Wave width={120} height={24} seed={i + seed0} count={barCount} color={color} opacity={0.7} />
              )}
            </div>
            <div className="meta">
              <span className="name">{a.name}</span>
              <span className="sub">{a.sub}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <PlayButton path={a.file_path} size={12} />
              <span className={`badge ${a.state}`}>{a.state}</span>
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--line-1)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <Icon name="search" style={{ width: 14, height: 14, color: "var(--fg-3)" }} />
        <input
          className="input"
          style={{ background: "transparent", border: "none", padding: 0, fontSize: 12 }}
          placeholder="Search assets…"
        />
      </div>

      {renderSection("DIALOGUE", "elv·*",    "tts",   "var(--tts)",   assets.dialogue, 30, 28)}
      {renderSection("SFX",      "sfx-v3",   "sfx",   "var(--sfx)",   assets.sfx,      60, 32)}
      {renderSection("MUSIC",    "score-v2", "music", "var(--music)", assets.music,    90, 36)}
    </div>
  );
};
