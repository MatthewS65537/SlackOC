import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { V2Event } from "@opencode/client";
import { createRenderDeps } from "../src/slack/render-deps.js";
import { SessionView, deleteView } from "../src/slack/render.js";
import { StateStore } from "../src/state.js";
import { droppedOpCount, _resetQueueForTests } from "../src/slack/queue.js";
import { V2Events } from "../src/opencode/v2.js";
import { logErr } from "../src/log.js";

vi.mock("../src/log.js", async (original) => ({ ...await original<typeof import("../src/log.js")>(), logErr: vi.fn() }));

const FIXTURE = `${import.meta.dirname}/.fixtures/agent-session`;
const slackError = (error: string) =>
  Object.assign(new Error(`An API error occurred: ${error}`), { code: "slack_webapi_platform_error", data: { ok: false, error } });

/** Slack client fake recording chat/reaction traffic; `agents` only when setStatus is given. */
function fakeSlack(setStatus?: (args: Record<string, unknown>) => Promise<unknown>) {
  let n = 0;
  const traffic: string[] = [];
  const rename = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true }));
  const client = {
    chat: {
      postMessage: async (a: { text: string }) => { traffic.push(`post ${a.text}`); return { ts: `9.${++n}` }; },
      update: async (a: { ts: string; text: string }) => { traffic.push(`update ${a.ts} ${a.text}`); return {}; },
      delete: async (a: { ts: string }) => { traffic.push(`delete ${a.ts}`); return {}; },
    },
    reactions: {
      add: async (a: { name: string }) => { traffic.push(`react ${a.name}`); return {}; },
      remove: async (a: { name: string }) => { traffic.push(`unreact ${a.name}`); return {}; },
    },
    ...(setStatus ? { agents: { sessions: { setStatus: vi.fn(setStatus), rename } } } : {}),
  };
  const deps = createRenderDeps({ client } as never, { isStopping: () => false, dmChannel: () => null, viewThread: () => "", owner: "UOWNER" });
  return { deps, traffic, rename, setStatus: client.agents?.sessions.setStatus };
}

beforeEach(() => {
  vi.mocked(logErr).mockClear();
  _resetQueueForTests();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(FIXTURE, { recursive: true, force: true });
});

describe("agents.sessions adapter (render-deps)", () => {
  it("names a new session with the owner as initiator and sends each status once per thread", async () => {
    const { deps, setStatus } = fakeSlack(async () => ({ ok: true }));
    await deps.sessionStatus!("C", "T", "processing", { title: "Fix the login bug" });
    await deps.sessionStatus!("C", "T", "processing");
    await deps.sessionStatus!("C", "T", "active");
    await deps.sessionStatus!("C", "T", "active");
    await deps.sessionStatus!("C", "T2", "closed"); // never create a session just to close it
    expect(setStatus!.mock.calls.map(([a]) => a)).toEqual([
      { channel_id: "C", thread_ts: "T", status: "processing", title: "Fix the login bug", initiator_user_id: "UOWNER" },
      { channel_id: "C", thread_ts: "T", status: "active", initiator_user_id: "UOWNER" },
    ]);
  });

  it("a channel-scoped refusal keeps the feature on; any other refusal turns it off for the process with one log line", async () => {
    const refusals = ["not_in_channel", "agent_view_not_enabled"];
    const { deps, setStatus, rename } = fakeSlack(async () => { const code = refusals.shift(); if (code) throw slackError(code); return { ok: true }; });
    await deps.sessionStatus!("C", "T1", "processing");
    expect(logErr).not.toHaveBeenCalled();
    await deps.sessionStatus!("C", "T2", "processing");
    expect(logErr).toHaveBeenCalledOnce();
    expect(vi.mocked(logErr).mock.calls[0]![0]).toContain("agent_view_not_enabled");
    await deps.sessionStatus!("C", "T3", "processing");
    await deps.sessionRename!("C", "T2", "New title");
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(rename).not.toHaveBeenCalled();
    expect(logErr).toHaveBeenCalledOnce();
    expect(droppedOpCount()).toBe(0); // an expected refusal is not a lost Slack op
  });

  it("logs Slack's missing stop-subscription warning once", async () => {
    const { deps } = fakeSlack(async () => ({ ok: true, response_metadata: { warnings: ["missing_agent_session_stopped_event_subscription"] } }));
    await deps.sessionStatus!("C", "T1", "processing");
    await deps.sessionStatus!("C", "T2", "processing");
    expect(logErr).toHaveBeenCalledOnce();
    expect(vi.mocked(logErr).mock.calls[0]![0]).toContain("agent_session_stopped");
  });

  it("renames only threads it opened a session for", async () => {
    const { deps, rename } = fakeSlack(async () => ({ ok: true }));
    await deps.sessionRename!("C", "T", "Early");
    await deps.sessionStatus!("C", "T", "processing");
    await deps.sessionRename!("C", "T", "Fix flaky login test");
    expect(rename.mock.calls.map(([a]) => a)).toEqual([{ channel_id: "C", thread_ts: "T", title: "Fix flaky login test" }]);
  });
});

describe("app without agent_view (not reinstalled)", () => {
  /** prompt → question → answer → finish through the real adapter and queue; returns the thread's Slack traffic. */
  async function run(slack: ReturnType<typeof fakeSlack>, sessionId: string): Promise<string[]> {
    const v = new SessionView({ sessionId, projectDir: "/p", channel: "C", threadTs: "T", threadKey: "C:T", client: {} as never,
      deps: slack.deps, state: new StateStore(`${FIXTURE}/${sessionId}.json`),
      threadState: { sessionId, projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 } });
    await v.beginPrompt("1.1", "Fix it");
    await vi.advanceTimersByTimeAsync(2_500);
    v.setWaiting("q1", "question", true);
    await vi.advanceTimersByTimeAsync(2_500);
    v.setWaiting("q1", "question", false);
    await v.handle({ type: "message.part.updated", properties: { part: { id: "x1", messageID: "m", type: "text", text: "Done.", time: { end: 1 } } } } as never);
    await vi.advanceTimersByTimeAsync(2_500);
    await v.handle({ type: "session.idle", properties: {} } as never);
    await vi.advanceTimersByTimeAsync(5_000);
    deleteView(sessionId);
    return slack.traffic;
  }

  it("renders the thread exactly as an app with no agents API does", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const baseline = await run(fakeSlack(), "sess-plain");
    _resetQueueForTests();
    vi.setSystemTime(0);
    const refused = fakeSlack(async () => { throw slackError("not_allowed"); });
    const traffic = await run(refused, "sess-refused");
    expect(traffic).toEqual(baseline);
    expect(traffic.some((t) => t.startsWith("post Done."))).toBe(true);
    expect(refused.setStatus).toHaveBeenCalledOnce(); // the first refusal switched it off for the rest of the run
  });
});

describe("V2 session.renamed", () => {
  it("is translated for the bridge (start.ts mirrors it onto the thread's session)", () => {
    const out = new V2Events().translate({ type: "session.renamed", data: { sessionID: "s", title: "Fix flaky login test" } } as V2Event);
    expect(out).toEqual([{ type: "session.renamed", properties: { sessionID: "s", title: "Fix flaky login test" } }]);
  });
});
