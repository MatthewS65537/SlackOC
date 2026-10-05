import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nextOccurrence, validateSchedule, type ScheduleSpec } from "./recurrence.js";

export interface ScheduleJob {
  id: string;
  name: string;
  projectDir: string;
  prompt: string;
  schedule: ScheduleSpec;
  destination: { kind: "dm" } | { kind: "channel"; channelId: string };
  timeoutMs: number;
  agent?: string;
  model?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
}

export type NewScheduleJob = Omit<ScheduleJob, "id" | "enabled" | "createdAt" | "updatedAt" | "nextRunAt">;

export interface ScheduleRun {
  id: string;
  jobId: string;
  scheduledAt: number;
  startedAt: number;
  deadlineAt: number;
  manual: boolean;
  snapshot: ScheduleJob;
  status: "claimed" | "creating" | "submitting" | "running" | "waiting" | "ready" | "delivering" | "delivered" | "failed" | "uncertain" | "canceled" | "skipped";
  sessionId?: string;
  messageId?: string;
  output?: string;
  error?: string;
  context?: { channel: string; ts: string };
  contextAttemptedAt?: number;
  delivery?: { channel: string; ts?: string };
  /** Delivery is confirmed; only the idempotent continuation hook remains. */
  deliveryBindingPending?: boolean;
  notified?: boolean;
}

export const MAX_SCHEDULE_JOBS = 100;
export const MAX_SCHEDULE_RUNS = 500;
export const MAX_SCHEDULE_OUTPUT_BYTES = 64 * 1024;
export const SCHEDULE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set<ScheduleRun["status"]>(["delivered", "failed", "canceled", "skipped"]);
const GENERATING = new Set<ScheduleRun["status"]>(["claimed", "creating", "submitting", "running", "waiting", "uncertain"]);
const STATUSES = new Set<ScheduleRun["status"]>([...TERMINAL, ...GENERATING, "ready", "delivering"]);
const JOB_FIELDS = ["id", "name", "projectDir", "prompt", "schedule", "destination", "timeoutMs", "agent", "model", "enabled", "createdAt", "updatedAt", "nextRunAt"];
const RUN_FIELDS = ["id", "jobId", "scheduledAt", "startedAt", "deadlineAt", "manual", "snapshot", "status", "sessionId", "messageId", "output", "error", "context", "contextAttemptedAt", "delivery", "deliveryBindingPending", "notified"];
const NEW_JOB_FIELDS = JOB_FIELDS.filter(key => !["id", "enabled", "createdAt", "updatedAt", "nextRunAt"].includes(key));

export function isTerminalRun(run: ScheduleRun): boolean {
  if (run.status === "delivered" && run.deliveryBindingPending) return false;
  if (run.status === "failed" && run.error && !run.notified) return false;
  return TERMINAL.has(run.status);
}
export function isGenerationActive(run: ScheduleRun): boolean {
  // Saved output proves generation ended; uncertain delivery must not block
  // unrelated future reports, though its own post still requires reconciliation.
  return GENERATING.has(run.status) && !(run.status === "uncertain" && run.output !== undefined);
}

export function automaticRunId(jobId: string, scheduledAt: number): string {
  return `auto_${createHash("sha256").update(JSON.stringify([jobId, scheduledAt])).digest("hex")}`;
}

function object(value: unknown, fields: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error(`Invalid ${label}`);
}

function text(value: unknown, limit: number, label: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0") || Buffer.byteLength(value) > limit) {
    throw new Error(`Invalid ${label}; maximum ${limit} bytes`);
  }
}

function timestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new Error(`Invalid ${label}`);
  }
}

function validateDefinition(job: NewScheduleJob): void {
  text(job.name, 256, "schedule name");
  text(job.projectDir, 4096, "schedule project directory");
  if (!isAbsolute(job.projectDir)) throw new Error("Schedule project directory must be absolute");
  text(job.prompt, 32 * 1024, "schedule prompt");
  object(job.schedule, ["time", "timezone", "days"], "schedule recurrence");
  validateSchedule(job.schedule);
  object(job.destination, ["kind", "channelId"], "schedule destination");
  if (job.destination.kind === "channel") text(job.destination.channelId, 200, "schedule channel");
  else if (job.destination.kind !== "dm" || "channelId" in job.destination) throw new Error("Invalid schedule destination");
  if (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs <= 0 || job.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Schedule timeout must be positive and at most 24 hours");
  }
  if (job.agent !== undefined) text(job.agent, 256, "schedule agent");
  if (job.model !== undefined) text(job.model, 512, "schedule model");
}

function validateJob(job: ScheduleJob): void {
  object(job, JOB_FIELDS, "schedule job");
  validateDefinition(job);
  text(job.id, 200, "schedule job ID");
  if (typeof job.enabled !== "boolean") throw new Error("Invalid schedule enabled flag");
  timestamp(job.createdAt, "schedule creation time");
  timestamp(job.updatedAt, "schedule update time");
  timestamp(job.nextRunAt, "schedule next occurrence");
  if (job.updatedAt < job.createdAt) throw new Error("Invalid schedule update time");
}

function validateRun(run: ScheduleRun): void {
  object(run, RUN_FIELDS, "schedule run");
  text(run.id, 200, "schedule run ID");
  text(run.jobId, 200, "schedule run job ID");
  validateJob(run.snapshot);
  if (run.snapshot.id !== run.jobId || typeof run.manual !== "boolean" || !STATUSES.has(run.status)) throw new Error("Invalid schedule run identity/status");
  timestamp(run.scheduledAt, "schedule occurrence time");
  timestamp(run.startedAt, "schedule start time");
  timestamp(run.deadlineAt, "schedule deadline");
  if (run.deadlineAt !== run.startedAt + run.snapshot.timeoutMs ||
      (!run.manual && run.id !== automaticRunId(run.jobId, run.scheduledAt))) throw new Error("Invalid schedule run identity/deadline");
  for (const field of ["sessionId", "messageId"] as const) if (run[field] !== undefined) text(run[field], 256, `schedule ${field}`);
  if (run.output !== undefined) text(run.output, MAX_SCHEDULE_OUTPUT_BYTES, "schedule output", true);
  if (run.error !== undefined) text(run.error, 8 * 1024, "schedule error", true);
  if (run.contextAttemptedAt !== undefined) timestamp(run.contextAttemptedAt, "schedule context attempt time");
  if (run.notified !== undefined && typeof run.notified !== "boolean") throw new Error("Invalid schedule notification flag");
  if (run.deliveryBindingPending !== undefined && typeof run.deliveryBindingPending !== "boolean") throw new Error("Invalid schedule continuation flag");
  if (run.deliveryBindingPending && (run.status !== "delivered" || !run.delivery?.ts)) throw new Error("Invalid pending report continuation");
  for (const [label, destination] of [["context", run.context], ["delivery", run.delivery]] as const) {
    if (destination === undefined) continue;
    object(destination, ["channel", "ts"], `schedule ${label}`);
    text(destination.channel, 200, `schedule ${label} channel`);
    if (label === "context" || destination.ts !== undefined) {
      if (typeof destination.ts !== "string" || !/^\d+\.\d{1,6}$/.test(destination.ts)) throw new Error(`Invalid schedule ${label} timestamp`);
    }
  }
}

interface StoreData { version: 1; jobs: ScheduleJob[]; runs: ScheduleRun[] }

/** Single bridge writer. Commit before effects; failed writes do not change memory. */
export class ScheduleStore {
  private definitions = new Map<string, ScheduleJob>();
  private records = new Map<string, ScheduleRun>();
  private persisted?: string;

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    if (!existsSync(path)) return;
    const raw = this.readDisk();
    const data = JSON.parse(raw) as StoreData;
    object(data, ["version", "jobs", "runs"], "schedule store");
    if (data.version !== 1) throw new Error("Unsupported schedule store version; refusing to overwrite");
    if (!Array.isArray(data.jobs) || !Array.isArray(data.runs) || data.jobs.length > MAX_SCHEDULE_JOBS || data.runs.length > MAX_SCHEDULE_RUNS) {
      throw new Error("Invalid schedule store capacity/data");
    }
    for (const job of data.jobs) {
      validateJob(job);
      if (this.definitions.has(job.id)) throw new Error("Duplicate schedule job ID");
      this.definitions.set(job.id, job);
    }
    for (const run of data.runs) {
      validateRun(run);
      if (this.records.has(run.id)) throw new Error("Duplicate schedule run ID");
      this.records.set(run.id, run);
    }
    this.persisted = raw;
  }

  jobs(): ScheduleJob[] { return structuredClone([...this.definitions.values()]); }
  job(id: string): ScheduleJob | undefined {
    const value = this.definitions.get(id);
    return value && structuredClone(value);
  }
  runs(jobId?: string): ScheduleRun[] {
    return structuredClone([...this.records.values()].filter(run => jobId === undefined || run.jobId === jobId));
  }
  run(id: string): ScheduleRun | undefined {
    const value = this.records.get(id);
    return value && structuredClone(value);
  }

  createJob(input: NewScheduleJob): ScheduleJob {
    object(input, NEW_JOB_FIELDS, "new schedule job");
    validateDefinition(input);
    if (this.definitions.size >= MAX_SCHEDULE_JOBS) throw new Error("Schedule store full; maximum 100 jobs");
    const now = this.time();
    const job: ScheduleJob = { ...structuredClone(input), id: randomUUID(), enabled: true, createdAt: now, updatedAt: now, nextRunAt: nextOccurrence(input.schedule, now) };
    job.schedule.days.sort((a, b) => a - b);
    validateJob(job);
    const next = new Map(this.definitions).set(job.id, job);
    this.commit(next, new Map(this.records));
    return this.job(job.id)!;
  }

  /** Applies changes to the current record, never to a snapshot held across awaits. */
  updateJob(id: string, change: (job: ScheduleJob) => void): ScheduleJob {
    const prior = this.job(id);
    if (!prior) throw new Error("Schedule job not found");
    const job = structuredClone(prior);
    change(job);
    if (job.id !== prior.id || job.createdAt !== prior.createdAt) throw new Error("Schedule job identity cannot change");
    validateDefinition(job);
    job.schedule.days.sort((a, b) => a - b);
    const changedDefinition = NEW_JOB_FIELDS.some(key => !isDeepStrictEqual(job[key as keyof ScheduleJob], prior[key as keyof ScheduleJob])) || job.enabled !== prior.enabled;
    const now = this.time();
    if (changedDefinition) job.nextRunAt = nextOccurrence(job.schedule, now);
    job.updatedAt = Math.max(now, prior.updatedAt);
    validateJob(job);
    this.commit(new Map(this.definitions).set(id, structuredClone(job)), new Map(this.records));
    return this.job(id)!;
  }

  removeJob(id: string): void {
    if (!this.definitions.has(id)) return;
    const next = new Map(this.definitions);
    next.delete(id);
    this.commit(next, new Map(this.records));
  }

  claim(jobId: string, scheduledAt: number, manual = false): ScheduleRun {
    return this.createRun(jobId, scheduledAt, manual, "claimed");
  }

  /** Atomic skipped claim: a crash must never turn a missed/overlap record into work. */
  skipOccurrence(jobId: string, scheduledAt: number, error: string): ScheduleRun {
    return this.createRun(jobId, scheduledAt, false, "skipped", error);
  }

  updateRun(id: string, change: (run: ScheduleRun) => void): ScheduleRun {
    const prior = this.run(id);
    if (!prior) throw new Error("Schedule run not found");
    const run = structuredClone(prior);
    change(run);
    for (const field of ["id", "jobId", "scheduledAt", "startedAt", "deadlineAt", "manual", "snapshot"] as const) {
      if (!isDeepStrictEqual(run[field], prior[field])) throw new Error("Schedule run identity/snapshot cannot change");
    }
    validateRun(run);
    this.commit(new Map(this.definitions), new Map(this.records).set(id, structuredClone(run)), id);
    return this.run(id)!;
  }

  private createRun(jobId: string, scheduledAt: number, manual: boolean, status: "claimed" | "skipped", error?: string): ScheduleRun {
    timestamp(scheduledAt, "schedule occurrence time");
    if (typeof manual !== "boolean") throw new Error("Invalid manual schedule flag");
    const id = manual ? `manual_${randomUUID()}` : automaticRunId(jobId, scheduledAt);
    const existing = this.run(id);
    if (existing) return existing;
    const job = this.job(jobId);
    if (!job) throw new Error("Schedule job not found");
    const now = this.time();
    const run: ScheduleRun = { id, jobId, scheduledAt, startedAt: now, deadlineAt: now + job.timeoutMs, manual, snapshot: job, status, ...(error === undefined ? {} : { error }) };
    validateRun(run);
    this.commit(new Map(this.definitions), new Map(this.records).set(id, run), id, true);
    return this.run(id)!;
  }

  private time(): number {
    const now = this.now();
    timestamp(now, "schedule clock");
    return now;
  }

  private readDisk(): string {
    if (statSync(this.path).size > MAX_STORE_BYTES) throw new Error("Schedule store exceeds 64 MiB");
    return readFileSync(this.path, "utf8");
  }

  private commit(jobs: Map<string, ScheduleJob>, runs: Map<string, ScheduleRun>, protectedRunId?: string, pruneOldRuns = false): void {
    const now = this.time();
    // Retain unresolved work and recent terminal history, even at capacity.
    for (const [id, run] of runs) {
      if (pruneOldRuns && id !== protectedRunId && isTerminalRun(run) && now - run.startedAt > SCHEDULE_RUN_RETENTION_MS) runs.delete(id);
    }
    if (jobs.size > MAX_SCHEDULE_JOBS || runs.size > MAX_SCHEDULE_RUNS) throw new Error("Schedule store full; unresolved/recent runs retained");
    for (const job of jobs.values()) validateJob(job);
    for (const run of runs.values()) validateRun(run);
    const raw = JSON.stringify({ version: 1, jobs: [...jobs.values()], runs: [...runs.values()] } satisfies StoreData);
    if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error("Schedule store exceeds 64 MiB");
    // Out-of-band edits/corruption are not permission to discard recovery state.
    if (existsSync(this.path) ? this.readDisk() !== this.persisted : this.persisted !== undefined) {
      throw new Error("Schedule store changed outside this writer; refusing to overwrite");
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, raw);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      this.definitions = jobs;
      this.records = runs;
      this.persisted = raw;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
