import { latestOccurrence, nextOccurrence } from "./recurrence.js";
import { automaticRunId, isGenerationActive, isTerminalRun, type ScheduleRun, type ScheduleStore } from "./store.js";

export const SCHEDULE_GRACE_MS = 2 * 60 * 60 * 1000;

export interface SchedulerOptions {
  store: ScheduleStore;
  /** One bounded state-machine step, including reconciliation of ambiguous effects. */
  tickRun: (run: ScheduleRun) => Promise<void>;
  now?: () => number;
  onError?: (err: unknown) => void;
}

/** Caller owns the polling timer. Closing prevents further claims or recovery steps. */
export class Scheduler {
  private inFlight?: Promise<void>;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions) { this.now = options.now ?? Date.now; }

  poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.closed) return Promise.resolve();
    // Install the lock before tickRun (or onError) can synchronously reenter poll.
    this.inFlight = Promise.resolve().then(() => this.pollOnce()).catch(err => this.report(err)).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  close(): void { this.closed = true; }

  private report(err: unknown): void {
    try { this.options.onError?.(err); } catch { /* Error reporting must not stop the bridge. */ }
  }

  private async step(id: string, ticked: Set<string>): Promise<void> {
    if (this.closed || ticked.has(id)) return;
    const run = this.options.store.run(id);
    if (!run || isTerminalRun(run)) return;
    ticked.add(id);
    try { await this.options.tickRun(run); }
    catch (err) { this.report(err); }
  }

  private async pollOnce(): Promise<void> {
    const { store } = this.options;
    const ticked = new Set<string>();
    const recovered = store.runs().filter(run => !isTerminalRun(run)).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    for (const saved of recovered) {
      if (this.closed) return;
      try {
        const run = store.run(saved.id);
        if (!run || isTerminalRun(run)) continue;
        if (run.status === "claimed") {
          const active = store.runs().filter(r => isGenerationActive(r, this.now())).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
          // Recover effects already started; do not start another bare claim beside them.
          const primary = active.find(item => item.status !== "claimed") ?? active[0];
          if (primary && primary.id !== run.id) {
            store.updateRun(run.id, current => { current.status = "skipped"; current.error = "Skipped overlap with another generating or uncertain scheduled report."; });
            continue;
          }
        }
        // ready/delivering are stepped too; the runner reconciles delivering rather than reposting.
        await this.step(run.id, ticked);
      } catch (err) { this.report(err); }
    }

    for (const saved of store.jobs()) {
      if (this.closed) return;
      try {
        // Recovery awaited external work: definitions and generation state may have changed.
        const job = store.job(saved.id);
        const now = this.now();
        if (!job || !job.enabled || job.nextRunAt > now) continue;
        const latest = latestOccurrence(job.schedule, now);
        if (latest < job.nextRunAt) throw new Error("Schedule next occurrence does not match its recurrence");
        if (job.nextRunAt < latest) {
          store.skipOccurrence(job.id, job.nextRunAt, `Missed earlier occurrences from ${new Date(job.nextRunAt).toISOString()} before ${new Date(latest).toISOString()}; only the latest is considered.`);
        }
        const id = automaticRunId(job.id, latest);
        const existing = store.run(id);
        if (!existing) {
          if (now - latest > SCHEDULE_GRACE_MS) store.skipOccurrence(job.id, latest, "Missed occurrence outside the 2-hour grace window.");
          else if (store.runs().some(r => isGenerationActive(r, now))) store.skipOccurrence(job.id, latest, "Skipped overlap with another generating or uncertain scheduled report.");
          else store.claim(job.id, latest);
        }
        // Claims precede advancing the pointer; their stable keys survive a crash between commits.
        store.updateJob(job.id, current => { current.nextRunAt = nextOccurrence(current.schedule, now); });
        await this.step(id, ticked);
      } catch (err) { this.report(err); }
    }
  }
}
