import React from "react";
import { EmptyState } from "./atoms";
import type { Job } from "../../lib/types";
import { importIdOfJob, useDissectStore } from "../../store/dissectStore";

interface JobQueueProps {
  jobs: Job[];
}

export const JobQueue: React.FC<JobQueueProps> = ({ jobs }) => {
  const cancelDissect = useDissectStore((s) => s.cancel);
  const retryDissect = useDissectStore((s) => s.retry);
  const running = jobs.filter((j) => j.status === "running").length;
  const queued  = jobs.filter((j) => j.status === "pending").length;

  return (
    <div>
      <div className="asset-group-head">
        <span>RUNNING · {running}</span>
        <span style={{ color: "var(--fg-4)" }}>{queued} queued</span>
      </div>
      {jobs.length === 0 && (
        <EmptyState
          icon="waves"
          title="No jobs running"
          body="Generations from Voice / Sound / Score show up here with live progress and the resulting take."
          compact
        />
      )}
      {jobs.map((j) => (
        <div key={j.id} className="job-row">
          <div className="top">
            <span className={`model ${j.model}`}>{j.model}</span>
            <span style={{ color: "var(--fg-3)", fontSize: 10, marginLeft: "auto" }}>{j.started_at}</span>
          </div>
          <div className="desc">{j.description}</div>
          <div className="bar">
            <div
              className={`bar-fill ${j.status === "complete" ? "done" : ""}`}
              style={{ width: `${j.progress}%` }}
            />
          </div>
          <div className="meta">
            <span>{j.progress}%</span>
            <span>·</span>
            <span>{j.eta}</span>
            {(() => {
              // Dissect runs can be stopped and re-run from here; other job
              // kinds have no server-side cancel yet.
              const importId = importIdOfJob(j.id);
              if (!importId) return null;
              const active = j.status === "running" || j.status === "pending";
              const ended = j.status === "failed" || j.status === "cancelled";
              if (!active && !ended) return null;
              return (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: "auto", padding: "1px 7px" }}
                  disabled={active && j.eta === "cancelling…"}
                  onClick={() => (active ? cancelDissect(importId) : retryDissect(importId))}
                  title={active ? "Stop this import at its next checkpoint" : "Run this import again with the same settings"}
                >
                  {active ? "Cancel" : "Retry"}
                </button>
              );
            })()}
          </div>
          {j.status === "failed" && j.error && (
            <div className="job-error" title={j.error}>{j.error.split("\n")[0]}</div>
          )}
        </div>
      ))}
    </div>
  );
};
