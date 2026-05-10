import React from "react";
import { EmptyState } from "./atoms";
import type { Job } from "../../lib/types";

interface JobQueueProps {
  jobs: Job[];
}

export const JobQueue: React.FC<JobQueueProps> = ({ jobs }) => {
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
          </div>
        </div>
      ))}
    </div>
  );
};
