import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledReports } from "../src/schedules/slack.js";
import { ScheduleStore } from "../src/schedules/store.js";
import { _resetQueueForTests } from "../src/slack/queue.js";
import { StateStore } from "../src/state.js";

const dir = resolve("test/.fixtures/schedule-slack");
const ROOT = { channel: "D_OWNER", ts: "1791450000.000001" };
const MARKER = "slackoc-schedule-report:";

beforeEach(() => { mkdirSync(dir, { recursive: true }); _resetQueueForTests(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A ready DM run whose context root exists, wired to a mocked Slack that loses the report update's response. */
function setup(accepted: boolean) {
  const seed = new ScheduleStore(resolve(dir, "schedules.json"));
  const job = seed.createJob({ name: "Daily report", projectDir: dir, prompt: "Summarize", timeoutMs: 60_000,
    schedule: { time: "09:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] }, destination: { kind: "dm" } });
  const run = seed.claim(job.id, Date.now(), true);
  seed.updateRun(run.id, r => {
    r.status = "ready"; r.sessionId = "ses_report"; r.messageId = "msg_report"; r.context = ROOT; r.output = "Final report evidence";
  });
  let rootText = "⏳ generating";
  let rootMeta: { event_type: string; event_payload: unknown } | undefined;
  const update = vi.fn(async (input: { text: string; ts: string; metadata?: typeof rootMeta }) => {
    if (accepted) { rootText = input.text; rootMeta = input.metadata ?? rootMeta; } // Slack keeps metadata an edit omits
    throw new Error("response lost after send"); // ambiguous: neither a Slack rejection nor a replayable transport error
  });
  const postMessage = vi.fn(async (_: { text: string; thread_ts?: string }) => ({ ts: "1791450000.000002" }));
  const acquire = vi.fn(() => { throw new Error("no model requests allowed"); });
  const statePath = resolve(dir, "state.json");
  const reports = createScheduledReports({
    app: { action() {}, view() {}, client: { chat: { update, postMessage },
      // Like Slack: without include_all_metadata only event_type comes back, not the marker payload.
      conversations: { history: async (args: { include_all_metadata?: boolean }) => ({ messages: [{ user: "U_BOT", ts: ROOT.ts, text: rootText,
        ...(rootMeta ? { metadata: args.include_all_metadata ? rootMeta : { event_type: rootMeta.event_type } } : {}) }] }) } } } as never,
    pool: { acquire } as never, state: new StateStore(statePath), statePath,
    owner: "U_OWNER", botUserId: "U_BOT", ownerDm: () => ROOT.channel,
    signal: new AbortController().signal, stopping: () => false, onError: e => { throw e; },
  });
  const status = () => new ScheduleStore(resolve(dir, "schedules.json")).run(run.id)!;
  return { reports, update, postMessage, acquire, status, run, root: () => rootText, rootMeta: () => rootMeta };
}

describe("DM report delivery with a lost response", () => {
  it("keeps an accepted report and its metadata marker, then adopts it exactly once", async () => {
    const s = setup(true);
    await s.reports.poll();
    expect(s.status()).toMatchObject({ status: "uncertain", notified: true });
    // The uncertainty notice is a thread reply; the root still holds the report and its (invisible) marker.
    expect(s.postMessage).toHaveBeenCalledOnce();
    expect(s.postMessage.mock.calls[0]![0]).toMatchObject({ channel: ROOT.channel, thread_ts: ROOT.ts, text: expect.stringContaining("unconfirmed") });
    expect(s.root()).toContain("Final report evidence");
    expect(s.root()).not.toContain("slackoc-");
    expect(s.update.mock.calls[0]![0]).toMatchObject({ blocks: [] });
    expect(s.rootMeta()).toEqual({ event_type: "slackoc_marker", event_payload: { kind: "schedule_report", id: s.run.id, marker: `${MARKER}${s.run.id}` } });

    await s.reports.poll();
    expect(s.status()).toMatchObject({ status: "delivered", delivery: ROOT });
    await s.reports.poll();
    expect(s.status().status).toBe("delivered");
    expect(s.update).toHaveBeenCalledOnce();
    expect(s.postMessage).toHaveBeenCalledOnce();
    expect(s.acquire).not.toHaveBeenCalled();
    s.reports.close();
  });

  it("stays truthfully uncertain when the update never landed, without reposting", async () => {
    const s = setup(false);
    await s.reports.poll();
    await s.reports.poll();
    expect(s.status()).toMatchObject({ status: "uncertain", error: expect.stringContaining("no automatic repost") });
    expect(s.root()).toBe("⏳ generating");
    expect(s.postMessage).toHaveBeenCalledOnce();
    expect(s.postMessage.mock.calls[0]![0]).toMatchObject({ thread_ts: ROOT.ts, text: expect.stringContaining("unconfirmed") });
    expect(s.postMessage.mock.calls[0]![0].text).not.toContain("delivered");
    expect(s.update).toHaveBeenCalledOnce();
    expect(s.acquire).not.toHaveBeenCalled();
    s.reports.close();
  });
});

describe("Home tab report rows", () => {
  it("carry the newest run's outcome, so a skipped report is visible (#34)", () => {
    const seed = new ScheduleStore(resolve(dir, "schedules.json"));
    const job = seed.createJob({ name: "News", projectDir: dir, prompt: "Summarize", timeoutMs: 60_000,
      schedule: { time: "09:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] }, destination: { kind: "dm" } });
    seed.skipOccurrence(job.id, Date.now() - 3 * 3600_000, "Missed occurrence outside the 2-hour grace window.");
    const statePath = resolve(dir, "state.json");
    const reports = createScheduledReports({ app: { action() {}, view() {}, client: {} } as never, pool: {} as never,
      state: new StateStore(statePath), statePath, owner: "U_OWNER", botUserId: "U_BOT", ownerDm: () => null,
      signal: new AbortController().signal, stopping: () => false, onError: () => {} });
    expect(reports.jobs()).toEqual([expect.objectContaining({ id: job.id, last: expect.stringMatching(/^⚠ skipped /) })]);
    reports.close();
  });
});
