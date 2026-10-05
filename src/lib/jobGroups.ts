/**
 * A line's jobs as one group: the take (Breeze, Qwen3-TTS, …) plus the
 * follow-ups chained after it (voice lock, AudioSR). The queue shows one row
 * per group with a stage strip and a single progress bar.
 */

import type { Job, JobStatus } from "./types";

export interface Stage {
  label: string;
  /** null for a stage still expected but not started. */
  job: Job | null;
}

export interface JobGroup {
  root: Job;
  stages: Stage[];
  status: JobStatus;
  /** 0–100 across all stages. */
  progress: number;
  /** The stage currently running (or the last one). */
  current: Stage;
}

const active = (s: JobStatus) => s === "running" || s === "pending";

/** Groups in list order; a follow-up whose first job is gone stands alone. */
export function groupJobs(jobs: Job[]): JobGroup[] {
  const ids = new Set(jobs.map((j) => j.id));
  const children = new Map<string, Job[]>();
  for (const j of jobs) {
    if (j.parent_id && ids.has(j.parent_id)) {
      children.set(j.parent_id, [...(children.get(j.parent_id) ?? []), j]);
    }
  }
  return jobs
    .filter((j) => !(j.parent_id && ids.has(j.parent_id)))
    .map((root) => {
      const kids = children.get(root.id) ?? [];
      const stages: Stage[] = [
        { label: root.stage ?? "take", job: root },
        ...kids.map((k) => ({ label: k.stage ?? k.model, job: k })),
        ...(root.followups ?? []).map((label) => ({ label, job: null })),
      ];
      const started = stages.filter((s) => s.job);
      const failed = started.find((s) => s.job!.status === "failed" || s.job!.status === "cancelled");
      const running = started.find((s) => active(s.job!.status));
      const waiting = stages.some((s) => !s.job);
      const status: JobStatus = failed
        ? failed.job!.status
        : running || waiting ? "running" : "complete";
      const done = started.filter((s) => s.job!.status === "complete").length;
      const partial = running ? running.job!.progress / 100 : 0;
      const progress = status === "complete" ? 100 : Math.round(((done + partial) / stages.length) * 100);
      const current = failed ?? running ?? stages.find((s) => !s.job) ?? stages[stages.length - 1];
      return { root, stages, status, progress, current };
    });
}

/** Every job id in a group (for removing it). */
export function groupIds(g: JobGroup): string[] {
  return g.stages.flatMap((s) => (s.job ? [s.job.id] : []));
}
