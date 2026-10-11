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
  const update = vi.fn(async (input: { text: string; ts: string }) => {
    if (accepted) rootText = input.text;
    throw new Error("response lost after send"); // ambiguous: neither a Slack rejection nor a replayable transport error
  });
  const postMessage = vi.fn(async (_: { text: string; thread_ts?: string }) => ({ ts: "1791450000.000002" }));
  const acquire = vi.fn(() => { throw new Error("no model requests allowed"); });
  const statePath = resolve(dir, "state.json");
  const reports = createScheduledReports({
    app: { action() {}, view() {}, client: { chat: { update, postMessage },
      conversations: { history: async () => ({ messages: [{ user: "U_BOT", ts: ROOT.ts, text: rootText }] }) } } } as never,
    pool: { acquire } as never, state: new StateStore(statePath), statePath,
    owner: "U_OWNER", botUserId: "U_BOT", ownerDm: () => ROOT.channel,
    signal: new AbortController().signal, stopping: () => false, onError: e => { throw e; },
  });
  const status = () => new ScheduleStore(resolve(dir, "schedules.json")).run(run.id)!;
  return { reports, update, postMessage, acquire, status, root: () => rootText };
}

describe("DM report delivery with a lost response", () => {
  it("keeps an accepted report and its marker, then adopts it exactly once", async () => {
    const s = setup(true);
    await s.reports.poll();
    expect(s.status()).toMatchObject({ status: "uncertain", notified: true });
    // The uncertainty notice is a thread reply; the root still holds the report and marker.
    expect(s.postMessage).toHaveBeenCalledOnce();
    expect(s.postMessage.mock.calls[0]![0]).toMatchObject({ channel: ROOT.channel, thread_ts: ROOT.ts, text: expect.stringContaining("unconfirmed") });
    expect(s.root()).toContain("Final report evidence");
    expect(s.root()).toContain(MARKER);

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
