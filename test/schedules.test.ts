import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestOccurrence, nextOccurrence, type ScheduleSpec } from "../src/schedules/recurrence.js";
import { Scheduler, SCHEDULE_GRACE_MS } from "../src/schedules/scheduler.js";
import { automaticRunId, MAX_SCHEDULE_JOBS, MAX_SCHEDULE_OUTPUT_BYTES, MAX_SCHEDULE_RUNS, ScheduleStore, SCHEDULE_RUN_RETENTION_MS, type NewScheduleJob, type ScheduleJob, type ScheduleRun } from "../src/schedules/store.js";

const fixtureDir = resolve("test/.fixtures/schedules");
const path = join(fixtureDir, "schedules.json");
const ms = (date: string) => Date.parse(date);
const daily: ScheduleSpec = { time: "09:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] };
const definition = (): NewScheduleJob => ({ name: "Morning report", projectDir: "/work/reports", prompt: "Summarize the saved sources.", schedule: structuredClone(daily), destination: { kind: "dm" }, timeoutMs: 30 * 60 * 1000 });
let now: number;
let store: ScheduleStore;
beforeEach(() => {
  mkdirSync(fixtureDir, { recursive: true });
  now = ms("2026-03-02T08:00:00Z");
  store = new ScheduleStore(path, () => now);
});
afterEach(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function seedRuns(statuses: ScheduleRun["status"][]): { job: ScheduleJob; runs: ScheduleRun[] } {
  const job = store.createJob(definition());
  const sample = store.claim(job.id, now, true);
  const runs = statuses.map((status, index) => ({ ...structuredClone(sample), id: `manual_fixture_${index}`, status }));
  writeFileSync(path, JSON.stringify({ version: 1, jobs: [job], runs }));
  store = new ScheduleStore(path, () => now);
  return { job, runs };
}

describe("wall-clock recurrence", () => {
  it("uses explicit zones, weekly selection, exclusive next and inclusive latest", () => {
    const india = { ...daily, timezone: "Asia/Kolkata" };
    expect(nextOccurrence(india, ms("2026-03-02T00:00:00Z"))).toBe(ms("2026-03-02T03:30:00Z"));
    const weekly = { ...daily, days: [5, 1] };
    const monday = ms("2026-03-02T09:00:00Z");
    expect(latestOccurrence(weekly, monday)).toBe(monday);
    expect(latestOccurrence(weekly, monday - 1)).toBe(ms("2026-02-27T09:00:00Z"));
    expect(nextOccurrence(weekly, monday)).toBe(ms("2026-03-06T09:00:00Z"));
  });

  it.each([
    { ...daily, time: "9:00" }, { ...daily, time: "24:00" }, { ...daily, time: "09:60" },
    { ...daily, timezone: "" }, { ...daily, timezone: "Invalid/Nowhere" }, { ...daily, timezone: "+02:00" },
    { ...daily, days: [] }, { ...daily, days: [0, 0] }, { ...daily, days: [-1] },
    { ...daily, days: [7] }, { ...daily, days: [1.5] }, { ...daily, days: Array<number>(1) },
  ])("rejects invalid recurrence %j", schedule => {
    expect(() => nextOccurrence(schedule, now)).toThrow();
    expect(() => latestOccurrence(schedule, now)).toThrow();
  });

  it("rejects invalid date boundaries", () => {
    for (const boundary of [NaN, Infinity, now + 0.5, 9e15]) expect(() => nextOccurrence(daily, boundary)).toThrow();
  });

  it("shifts a spring gap forward once, including calls made inside and after the gap", () => {
    const spring = { ...daily, time: "02:30", timezone: "America/New_York" };
    const shifted = ms("2026-03-08T07:30:00Z"); // 03:30 EDT, not the nonexistent 02:30.
    expect(nextOccurrence(spring, ms("2026-03-07T12:00:00Z"))).toBe(shifted);
    expect(nextOccurrence(spring, ms("2026-03-08T07:15:00Z"))).toBe(shifted);
    expect(latestOccurrence(spring, ms("2026-03-08T07:15:00Z"))).toBe(ms("2026-03-07T07:30:00Z"));
    expect(latestOccurrence(spring, ms("2026-03-08T08:00:00Z"))).toBe(shifted);
    expect(nextOccurrence(spring, shifted)).toBe(ms("2026-03-09T06:30:00Z"));
    expect(nextOccurrence({ ...spring, days: [0] }, shifted)).toBe(ms("2026-03-15T06:30:00Z"));
  });

  it("chooses the first fall-fold occurrence and never backfills the repeated hour", () => {
    const fall = { ...daily, time: "01:30", timezone: "America/New_York" };
    const first = ms("2026-11-01T05:30:00Z");
    const nextDay = ms("2026-11-02T06:30:00Z");
    expect(nextOccurrence(fall, ms("2026-10-31T12:00:00Z"))).toBe(first);
    expect(latestOccurrence(fall, first)).toBe(first);
    for (const boundary of ["2026-11-01T05:45:00Z", "2026-11-01T06:15:00Z", "2026-11-01T06:45:00Z"]) {
      expect(latestOccurrence(fall, ms(boundary))).toBe(first);
      expect(nextOccurrence(fall, ms(boundary))).toBe(nextDay);
    }
    expect(nextOccurrence({ ...fall, days: [0] }, ms("2026-11-01T06:15:00Z"))).toBe(ms("2026-11-08T06:30:00Z"));
  });

  it("preserves the library's half-hour-gap skip and first-fold policy", () => {
    const halfHourGap = { ...daily, time: "02:15", timezone: "Australia/Lord_Howe" };
    // October 4's 02:15 does not exist; cron-parser skips it rather than shifting it.
    expect(nextOccurrence(halfHourGap, ms("2026-10-03T08:00:00Z"))).toBe(ms("2026-10-04T15:15:00Z"));
    expect(latestOccurrence(halfHourGap, ms("2026-10-03T16:00:00Z"))).toBe(ms("2026-10-02T15:45:00Z"));
    const weeklyGap = { ...halfHourGap, days: [0] };
    expect(latestOccurrence(weeklyGap, ms("2026-10-10T10:00:00Z"))).toBe(ms("2026-09-26T15:45:00Z"));
    expect(nextOccurrence(weeklyGap, ms("2026-10-10T10:00:00Z"))).toBe(ms("2026-10-10T15:15:00Z"));
    const halfHourFold = { ...halfHourGap, time: "01:45" };
    expect(nextOccurrence(halfHourFold, ms("2026-04-04T08:00:00Z"))).toBe(ms("2026-04-04T14:45:00Z"));
    expect(latestOccurrence(halfHourFold, ms("2026-04-04T15:30:00Z"))).toBe(ms("2026-04-04T14:45:00Z"));
    expect(nextOccurrence(halfHourFold, ms("2026-04-04T15:00:00Z"))).toBe(ms("2026-04-05T15:15:00Z"));
  });
});

describe("durable schedule store", () => {
  it("does not write on construction and atomically writes versioned private JSON", () => {
    expect(readdirSync(fixtureDir)).toEqual([]);
    const job = store.createJob(definition());
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBe(ms("2026-03-02T09:00:00Z"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(fixtureDir)).toEqual(["schedules.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, jobs: [job], runs: [] });
    expect(new ScheduleStore(path).jobs()).toEqual([job]);
  });

  it("returns isolated clones, including callback references and immutable snapshots", () => {
    const input = definition();
    const job = store.createJob(input);
    input.schedule.days.pop();
    job.schedule.days.pop();
    store.jobs()[0]!.prompt = "not saved";
    let heldJob!: ScheduleJob;
    store.updateJob(job.id, current => { current.name = "Saved"; heldJob = current; });
    heldJob.name = "not saved";
    const run = store.claim(job.id, now, true);
    run.snapshot.prompt = "not saved";
    let heldRun!: ScheduleRun;
    store.updateRun(run.id, current => { current.status = "running"; heldRun = current; });
    heldRun.status = "canceled";
    store.runs()[0]!.snapshot.schedule.days.pop();
    expect(store.job(job.id)).toMatchObject({ name: "Saved", prompt: input.prompt, schedule: daily });
    expect(store.run(run.id)).toMatchObject({ status: "running", snapshot: { prompt: input.prompt, schedule: daily } });
    expect(() => store.updateRun(run.id, current => { current.snapshot.prompt = "change"; })).toThrow(/snapshot/);
    expect(() => store.updateRun(run.id, current => { current.deadlineAt++; })).toThrow(/identity/);
    expect(() => store.updateJob(job.id, current => { current.id = "change"; })).toThrow(/identity/);
  });

  it("deduplicates automatic claims through edits, deletion and restart; manual claims remain distinct", () => {
    const job = store.createJob(definition());
    const first = store.claim(job.id, job.nextRunAt);
    store.updateJob(job.id, current => { current.prompt = "Edited definition"; });
    expect(store.claim(job.id, job.nextRunAt)).toEqual(first);
    expect(store.claim(job.id, now, true).id).not.toBe(store.claim(job.id, now, true).id);
    store.removeJob(job.id);
    store = new ScheduleStore(path, () => now);
    expect(store.jobs()).toEqual([]);
    expect(store.claim(job.id, job.nextRunAt)).toEqual(first);
    expect(store.runs(job.id)).toHaveLength(3);
    expect(() => store.claim(job.id, now, true)).toThrow(/not found/);
  });

  it("removal retains even old terminal records and their task snapshots", () => {
    const job = store.createJob(definition());
    const run = store.claim(job.id, now, true);
    store.updateRun(run.id, current => { current.status = "delivered"; });
    now += SCHEDULE_RUN_RETENTION_MS + 1;
    store.removeJob(job.id);
    expect(new ScheduleStore(path).run(run.id)).toMatchObject({ status: "delivered", snapshot: job });
  });

  it("creates, edits and resumes with future-only occurrences, preserving active snapshots", () => {
    const job = store.createJob(definition());
    const run = store.claim(job.id, now, true);
    store.updateJob(job.id, current => { current.enabled = false; });
    now = ms("2026-03-05T11:00:00Z");
    const resumed = store.updateJob(job.id, current => { current.enabled = true; });
    expect(resumed.nextRunAt).toBe(ms("2026-03-06T09:00:00Z"));
    const edited = store.updateJob(job.id, current => { current.schedule.time = "12:00"; });
    expect(edited.nextRunAt).toBe(ms("2026-03-05T12:00:00Z"));
    expect(store.run(run.id)!.snapshot).toEqual(job);
    expect(store.run(run.id)!.status).toBe("claimed");
  });

  it("merges only intended fields after awaits, preserving a concurrent cancellation", async () => {
    const job = store.createJob(definition());
    const run = store.claim(job.id, now, true);
    const gate = deferred();
    const late = (async () => { await gate.promise; store.updateRun(run.id, current => { current.context = { channel: "DTEST", ts: "1.000001" }; }); })();
    store.updateRun(run.id, current => { current.status = "canceled"; });
    gate.resolve(); await late;
    expect(store.run(run.id)).toMatchObject({ status: "canceled", context: { channel: "DTEST", ts: "1.000001" } });
  });

  it("validates attempted context timestamps and bounds output in bytes without truncation", () => {
    const job = store.createJob(definition());
    const run = store.claim(job.id, now, true);
    store.updateRun(run.id, current => { current.contextAttemptedAt = now; current.output = "é".repeat(MAX_SCHEDULE_OUTPUT_BYTES / 2); });
    expect(new ScheduleStore(path).run(run.id)!.contextAttemptedAt).toBe(now);
    const saved = readFileSync(path, "utf8");
    expect(() => store.updateRun(run.id, current => { current.output += "é"; })).toThrow(/output/);
    expect(() => store.updateRun(run.id, current => { current.contextAttemptedAt = NaN; })).toThrow(/attempt/);
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(Buffer.byteLength(store.run(run.id)!.output!)).toBe(MAX_SCHEDULE_OUTPUT_BYTES);
  });

  it.each(["", "{", "null", '{"version":99,"jobs":[],"runs":[]}', '{"version":1,"jobs":{},"runs":[]}', '{"version":1,"jobs":[],"runs":[{}]}'])("fails closed on invalid persisted data: %s", raw => {
    writeFileSync(path, raw);
    expect(() => new ScheduleStore(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(fixtureDir)).toEqual(["schedules.json"]);
  });

  it("rejects duplicate identities and corrupt snapshots without rewriting them", () => {
    const job = store.createJob(definition());
    const run = store.claim(job.id, now);
    for (const data of [
      { version: 1, jobs: [job, job], runs: [run] },
      { version: 1, jobs: [job], runs: [run, run] },
      { version: 1, jobs: [job], runs: [{ ...run, snapshot: { ...job, id: "other" } }] },
      { version: 1, jobs: [job], runs: [{ ...run, id: "not-the-occurrence-key" }] },
    ]) {
      const raw = JSON.stringify(data);
      writeFileSync(path, raw);
      expect(() => new ScheduleStore(path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });

  it("refuses out-of-band writes and leaves its memory state intact", () => {
    const job = store.createJob(definition());
    const raw = '{"version":999,"jobs":[],"runs":[]}';
    writeFileSync(path, raw);
    expect(() => store.updateJob(job.id, current => { current.name = "new"; })).toThrow(/refusing to overwrite/);
    expect(store.job(job.id)).toEqual(job);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("enforces the job cap and validates new definitions before writing", () => {
    const job = store.createJob(definition());
    writeFileSync(path, JSON.stringify({ version: 1, jobs: Array.from({ length: MAX_SCHEDULE_JOBS }, (_, i) => ({ ...job, id: `job_${i}` })), runs: [] }));
    store = new ScheduleStore(path, () => now);
    expect(() => store.createJob(definition())).toThrow(/100 jobs/);
    expect(store.jobs()).toHaveLength(MAX_SCHEDULE_JOBS);
    for (const bad of [{ ...definition(), timeoutMs: 0 }, { ...definition(), projectDir: "relative" }, { ...definition(), enabled: false }]) {
      expect(() => store.createJob(bad)).toThrow();
    }
  });

  it("never prunes unresolved/uncertain runs to accept more work", () => {
    const { job } = seedRuns(Array.from({ length: MAX_SCHEDULE_RUNS }, (_, i) => i % 2 ? "uncertain" : "running"));
    now += 30 * 24 * 60 * 60 * 1000;
    const raw = readFileSync(path, "utf8");
    expect(() => store.claim(job.id, now, true)).toThrow(/full/);
    expect(store.runs()).toHaveLength(MAX_SCHEDULE_RUNS);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("prunes only old terminal runs, retaining recent terminal history", () => {
    const { job, runs } = seedRuns(["delivered", "failed", "canceled", "skipped", "uncertain", "ready", "delivering", "waiting"]);
    now += SCHEDULE_RUN_RETENTION_MS + 1;
    const recent = store.claim(job.id, now, true);
    store.updateRun(recent.id, current => { current.status = "delivered"; });
    expect(store.runs().map(run => run.id)).toEqual([...runs.slice(4).map(run => run.id), recent.id]);
    const { job: fullJob } = seedRuns(Array(MAX_SCHEDULE_RUNS).fill("delivered"));
    expect(() => store.claim(fullJob.id, now, true)).toThrow(/recent runs retained/);
  });

  it("persists skipped occurrences as terminal in a single claim", () => {
    const job = store.createJob(definition());
    const skip = store.skipOccurrence(job.id, job.nextRunAt, "Missed grace window");
    expect(new ScheduleStore(path).run(skip.id)).toMatchObject({ status: "skipped", error: "Missed grace window" });
    expect(store.claim(job.id, job.nextRunAt)).toEqual(skip);
  });
});

describe("singleflight scheduling and recovery", () => {
  it("coalesces polls, durably claims before ticking, and never ticks a run twice per poll", async () => {
    const job = store.createJob(definition());
    now = job.nextRunAt;
    const gate = deferred();
    const tickRun = vi.fn(async (run: ScheduleRun) => {
      expect(new ScheduleStore(path).run(run.id)).toEqual(run);
      expect(store.job(job.id)!.nextRunAt).toBeGreaterThan(now);
      await gate.promise;
      store.updateRun(run.id, current => { current.status = "running"; });
    });
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    const first = scheduler.poll();
    expect(scheduler.poll()).toBe(first);
    await Promise.resolve();
    expect(tickRun).toHaveBeenCalledTimes(1);
    gate.resolve(); await first;
    expect(store.runs()).toHaveLength(1);
    await scheduler.poll();
    expect(tickRun).toHaveBeenCalledTimes(2);
    expect(store.runs()).toHaveLength(1);
  });

  it("holds the singleflight lock during a synchronously reentrant runner callback", async () => {
    const job = store.createJob(definition());
    now = job.nextRunAt;
    let reentrant: Promise<void> | undefined;
    const tickRun = vi.fn(async () => { reentrant = scheduler.poll(); });
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    const polling = scheduler.poll();
    await polling;
    expect(reentrant).toBe(polling);
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(store.runs()).toHaveLength(1);
  });

  it("records the earlier missed range and starts only the latest occurrence", async () => {
    const job = store.createJob(definition());
    now = ms("2026-03-05T09:30:00Z");
    const tickRun = vi.fn(async () => {});
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    await scheduler.poll();
    const runs = store.runs(job.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ scheduledAt: job.nextRunAt, status: "skipped" });
    expect(runs[0]!.error).toMatch(/earlier occurrences.*only the latest/);
    expect(runs[1]).toMatchObject({ scheduledAt: ms("2026-03-05T09:00:00Z"), status: "claimed" });
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(store.job(job.id)!.nextRunAt).toBe(ms("2026-03-06T09:00:00Z"));
    await scheduler.poll();
    expect(store.runs()).toHaveLength(2);
  });

  it.each([0, 1])("has an inclusive two-hour grace boundary (plus %i ms)", async extra => {
    const job = store.createJob(definition());
    now = job.nextRunAt + SCHEDULE_GRACE_MS + extra;
    const tickRun = vi.fn(async () => {});
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(store.runs()[0]!.status).toBe(extra ? "skipped" : "claimed");
    expect(tickRun).toHaveBeenCalledTimes(extra ? 0 : 1);
    expect(store.job(job.id)!.nextRunAt).toBeGreaterThan(now);
  });

  it("records expired sleep catch-up without generating or building a backlog", async () => {
    const job = store.createJob(definition());
    now = ms("2026-03-05T12:00:00Z");
    const tickRun = vi.fn(async () => {});
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(store.runs(job.id)).toHaveLength(2);
    expect(store.runs(job.id).every(run => run.status === "skipped")).toBe(true);
    expect(store.runs(job.id)[1]!.error).toMatch(/grace/);
    expect(tickRun).not.toHaveBeenCalled();
  });

  it.each(["running", "waiting", "uncertain"] as const)("skips overlapping automatic work while a manual run is %s", async status => {
    const job = store.createJob(definition());
    now = job.nextRunAt - 60_000;
    const manual = store.claim(job.id, now, true);
    store.updateRun(manual.id, run => { run.status = status; });
    now = job.nextRunAt;
    const tickRun = vi.fn(async (_run: ScheduleRun) => {});
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    await scheduler.poll();
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(tickRun.mock.calls[0]![0]).toMatchObject({ id: manual.id, status });
    expect(store.run(automaticRunId(job.id, now))).toMatchObject({ status: "skipped", error: expect.stringMatching(/overlap/) });
    await scheduler.poll();
    expect(store.runs()).toHaveLength(2);
  });

  it("an uncertain run past its deadline no longer blocks later reports", async () => {
    const job = store.createJob(definition());
    now = job.nextRunAt - 2 * 60 * 60_000;
    const manual = store.claim(job.id, now, true);
    store.updateRun(manual.id, run => { run.status = "uncertain"; run.error = "Report runtime deadline exceeded; external admission remains unconfirmed"; });
    now = job.nextRunAt;
    expect(now).toBeGreaterThan(store.run(manual.id)!.deadlineAt);
    const tickRun = vi.fn(async (_run: ScheduleRun) => {});
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(store.run(automaticRunId(job.id, now))?.status).toBe("claimed");
  });

  it("allows only one global generation, not one per job", async () => {
    const first = store.createJob(definition());
    const second = store.createJob({ ...definition(), name: "Second" });
    now = first.nextRunAt;
    const tickRun = vi.fn(async (run: ScheduleRun) => { store.updateRun(run.id, current => { current.status = "running"; }); });
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(store.runs(first.id)[0]!.status).toBe("running");
    expect(store.runs(second.id)[0]!.status).toBe("skipped");
  });

  it.each(["ready", "delivering", "uncertain"] as const)("recovers saved-output %s through the runner without blocking future generation", async status => {
    const job = store.createJob(definition());
    const prior = store.claim(job.id, now, true);
    store.updateRun(prior.id, run => { run.status = status; run.output = "Saved output"; });
    now = job.nextRunAt;
    const tickRun = vi.fn(async (_run: ScheduleRun) => {});
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(tickRun.mock.calls.map(call => call[0].status)).toEqual([status, "claimed"]);
    expect(store.run(prior.id)!.status).toBe(status);
    expect(store.run(prior.id)!.output).toBe("Saved output");
  });

  it("rereads uncertainty after reconciliation before starting new work", async () => {
    const job = store.createJob(definition());
    const prior = store.claim(job.id, now, true);
    store.updateRun(prior.id, run => { run.status = "uncertain"; });
    now = job.nextRunAt;
    const tickRun = vi.fn(async (run: ScheduleRun) => { if (run.id === prior.id) store.updateRun(prior.id, current => { current.status = "ready"; }); });
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(tickRun).toHaveBeenCalledTimes(2);
    expect(store.runs()[1]!.status).toBe("claimed");
  });

  it("recovers a failure notification interrupted before its durable attempt", async () => {
    const job = store.createJob(definition());
    const failed = store.claim(job.id, now, true);
    store.updateRun(failed.id, run => { run.status = "failed"; run.error = "Report policy could not be verified"; });
    const tickRun = vi.fn(async (run: ScheduleRun) => { store.updateRun(run.id, current => { current.notified = true; }); });
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    await scheduler.poll();
    await scheduler.poll();
    expect(tickRun).toHaveBeenCalledOnce();
  });

  it("skips extra bare claims on recovery but reconciles preexisting external effects", async () => {
    const job = store.createJob(definition());
    const bare = store.claim(job.id, now, true);
    now++;
    const running = store.claim(job.id, now, true);
    store.updateRun(running.id, run => { run.status = "running"; });
    const tickRun = vi.fn(async (_run: ScheduleRun) => {});
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(store.run(bare.id)!.status).toBe("skipped");
    expect(tickRun.mock.calls.map(call => call[0].id)).toEqual([running.id]);
  });

  it.each(["pause", "remove"])("%s during recovery prevents future runs, not snapshot recovery", async action => {
    const job = store.createJob(definition());
    const prior = store.claim(job.id, now, true);
    store.updateRun(prior.id, run => { run.status = "running"; });
    now = job.nextRunAt;
    const gate = deferred();
    const tickRun = vi.fn(async () => { await gate.promise; });
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    const polling = scheduler.poll();
    await Promise.resolve();
    if (action === "pause") store.updateJob(job.id, current => { current.enabled = false; });
    else store.removeJob(job.id);
    gate.resolve(); await polling;
    await scheduler.poll();
    expect(store.runs()).toHaveLength(1);
    expect(store.run(prior.id)).toMatchObject({ status: "running", snapshot: job });
    expect(tickRun).toHaveBeenCalledTimes(2);
  });

  it("reuses a persisted occurrence after restart before the schedule pointer advanced", async () => {
    const job = store.createJob(definition());
    now = job.nextRunAt;
    const prior = store.claim(job.id, now);
    store = new ScheduleStore(path, () => now);
    const tickRun = vi.fn(async () => {});
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(store.runs()).toEqual([prior]);
    expect(store.job(job.id)!.nextRunAt).toBeGreaterThan(now);
  });

  it("advances through the fold without a second generation after a restart", async () => {
    now = ms("2026-10-31T12:00:00Z");
    const job = store.createJob({ ...definition(), schedule: { ...daily, time: "01:30", timezone: "America/New_York" } });
    now = ms("2026-11-01T05:45:00Z");
    const tickRun = vi.fn(async (run: ScheduleRun) => { store.updateRun(run.id, current => { current.status = "delivered"; }); });
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    store = new ScheduleStore(path, () => now);
    now = ms("2026-11-01T06:45:00Z");
    await new Scheduler({ store, now: () => now, tickRun }).poll();
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(store.runs(job.id)[0]!.scheduledAt).toBe(ms("2026-11-01T05:30:00Z"));
    expect(store.job(job.id)!.nextRunAt).toBe(ms("2026-11-02T06:30:00Z"));
  });

  it("isolates runner errors, retains claims, and retries only state-machine recovery", async () => {
    const job = store.createJob(definition());
    now = job.nextRunAt;
    const error = new Error("bounded transport failure");
    const tickRun = vi.fn(async () => { throw error; });
    const onError = vi.fn();
    const scheduler = new Scheduler({ store, now: () => now, tickRun, onError });
    await expect(scheduler.poll()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
    await scheduler.poll();
    expect(store.runs()).toHaveLength(1);
    expect(tickRun).toHaveBeenCalledTimes(2);
  });

  it("closing during a bounded step prevents subsequent claims and recovery", async () => {
    const job = store.createJob(definition());
    store.claim(job.id, now, true);
    now = job.nextRunAt;
    const gate = deferred();
    const tickRun = vi.fn(async () => { await gate.promise; });
    const scheduler = new Scheduler({ store, now: () => now, tickRun });
    const polling = scheduler.poll();
    await Promise.resolve();
    scheduler.close(); gate.resolve(); await polling;
    await scheduler.poll();
    expect(tickRun).toHaveBeenCalledTimes(1);
    expect(store.runs()).toHaveLength(1);
    expect(store.job(job.id)!.nextRunAt).toBe(now);
  });
});
