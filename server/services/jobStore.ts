import { randomUUID } from "crypto";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  result?: unknown;
  error?: string;
  progress?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, Job>();

// Purge jobs older than 30 minutes every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

export function createJob(): Job {
  const job: Job = {
    id: randomUUID(),
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<Omit<Job, "id" | "createdAt">>): void {
  const job = jobs.get(id);
  if (!job) return;
  jobs.set(id, { ...job, ...patch, updatedAt: Date.now() });
}
