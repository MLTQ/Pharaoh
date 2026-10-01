import React from "react";
import { EmptyState } from "./atoms";
import type { Job } from "../../lib/types";
import { importIdOfJob, useDissectStore } from "../../store/dissectStore";
import { useJobStore } from "../../store/jobStore";

interface JobQueueProps {
  jobs: Job[];
}

export const JobQueue: React.FC<JobQueueProps> = ({ jobs }) => {
  const cancelDissect = useDissectStore((s) => s.cancel);
  const retryDissect = useDissectStore((s) => s.retry);
  const running = jobs.filter((j) => j.status === "running").length;
  const queued  = jobs.filter((j) => j.status === "pending").length;
  const finished = jobs.length - running - queued;
  const clearFinished = useJobStore((s) => s.clearFinished);
  const removeJob = useJobStore((s) => s.removeJob);

  return (
    <div>
      <div className="asset-group-head">
        <span>RUNNING · {running}</span>
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: "var(--fg-4)" }}>{queued} queued</span>
          {finished > 0 && (
            <button
              className="btn btn-sm"
              style={{ padding: "1px 7px" }}
              onClick={() => clearFinished()}
              title="Remove completed, failed and cancelled jobs from this list (nothing on disk is deleted)"
            >Clear {finished}</button>
          )}
        </span>
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
            {j.status !== "running" && j.status !== "pending" && (
              <button
                className="btn btn-sm"
                style={{ padding: "0 5px", marginLeft: 6, lineHeight: 1.3 }}
                onClick={() => removeJob(j.id)}
                title="Remove from the list"
              >×</button>
            )}
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
