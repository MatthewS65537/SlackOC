import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LIVE_GRACE_MS, MAX_SNAPSHOT_CANDIDATES, sweepMissedMessages, sweepTopLevelMessages, type CatchupDeps, type RepliesPage, type TopLevelCatchupDeps } from "../src/slack/catchup.js";
import { StateStore, type ThreadState } from "../src/state.js";
import { MAX_REPLAY_AGE_MS, classifyRecovery, replayFloor, timestampFromMs } from "../src/slack/recovery-policy.js";
import type { SlackMsg } from "../src/slack/router.js";

const FIXTURES = join(import.meta.dirname, ".fixtures", "catchup");
const NOW = Date.parse("2026-09-22T00:00:00Z");
const ts = (seconds: number) => timestampFromMs(NOW - 60_000 + seconds * 1000);
const key = `C:${ts(0)}`;
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));
function fixture(name: string) {
  const state = new StateStore(join(FIXTURES, name, "state.json"), () => NOW);
  state.setThread(key, { sessionId: name, projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW,
    lastSeenTs: ts(1), historyCursorTs: ts(1) });
  const dispatched: SlackMsg[] = [];
  const deps: CatchupDeps = { state, ownerSlackUserId: "U1", fetchReplies: async () => page([]), dispatch: async (m) => {
    dispatched.push(m);
    state.claimMessage(key, m.ts, { source: "history" });
    state.settleMessage(key, m.ts, "accepted");
    return "accepted";
  } };
  return { state, deps, dispatched };
}
const msg = (seconds: number, text = "work"): SlackMsg => ({ channel: "C", thread_ts: ts(0), ts: ts(seconds), user: "U1", text });
/** One complete page of replies. */
const page = (messages: SlackMsg[]): RepliesPage => ({ messages, hasMore: false, pagesUsed: 1 });

describe("bounded classified history", () => {
  it("filters parent, bots, subtypes and other users, stamping channel-less owner rows", async () => {
    const { state, deps, dispatched } = fixture("filter");
    deps.fetchReplies = async () => page([msg(0), msg(2), { ...msg(3), user: "other" }, { ...msg(4), bot_id: "B" },
      { ...msg(5), subtype: "message_changed" }].map(({ channel, ...row }) => row as SlackMsg));
    expect(await sweepMissedMessages(deps)).toBe(1);
    expect(dispatched).toEqual([msg(2)]);
    expect(state.getThread(key)?.recovery?.ownerActivityTs).toBe(ts(2));
  });

  it("does not execute page one before a page-three stop; persists snapshot through restart", async () => {
    let { state, deps, dispatched } = fixture("page-stop");
    const fetch = vi.fn<CatchupDeps["fetchReplies"]>()
      .mockResolvedValueOnce({ messages: [msg(2)], hasMore: true, pagesUsed: 2, nextCursor: "page3" })
      .mockResolvedValueOnce({ messages: [msg(4, "\\stop")], hasMore: false, pagesUsed: 1 });
    deps.fetchReplies = fetch;
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.getThread(key)?.historyCursorTs).toBe(ts(1));
    state = new StateStore(join(FIXTURES, "page-stop", "state.json"), () => NOW);
    deps = { ...deps, state };
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(fetch.mock.calls[1]![2]).toBe(ts(2).replace(".000000", ".000001"));
    expect(fetch.mock.calls[1]![3]).toMatchObject({ latest: timestampFromMs(NOW - LIVE_GRACE_MS), maxPages: 2 });
    expect(dispatched).toEqual([]);
    expect(state.getThread(key)?.recovery?.canceledThroughTs).toBe(ts(4));
    expect(state.isMessageAccepted(key, ts(2))).toBe(false);
    expect(state.recoveryStatus().canceled).toBe(2);
  });

  it("holds an overflow instead of truncating it into executable work", async () => {
    const { state, deps, dispatched } = fixture("overflow");
    deps.fetchReplies = async () => page(Array.from({ length: MAX_SNAPSHOT_CANDIDATES + 1 }, (_, i) => ({ ...msg(2), ts: `${ts(2).split(".")[0]}.${String(i).padStart(6, "0")}` })));
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.recoveryStatus().threads[0]?.reason).toBe("backlog_overflow");
    expect(state.getThread(key)?.recovery?.scan).toBeUndefined();
  });

  it("waits for the previous classified task to finish, then sends the next in order", async () => {
    const { state, deps, dispatched } = fixture("sequential");
    deps.fetchReplies = async () => page([msg(2), msg(3)]);
    const dispatch = deps.dispatch;
    deps.dispatch = async (m, context) => {
      const result = await dispatch(m, context);
      state.setThread(key, { ...state.getThread(key)!, pendingRun: { userMsgTs: [m.ts] } });
      return result;
    };
    expect(await sweepMissedMessages(deps)).toBe(1);
    expect(dispatched.map((m) => m.ts)).toEqual([ts(2)]);
    expect(await sweepMissedMessages(deps)).toBe(0);
    state.recordRunOutcome(key, "sequential", "completed");
    state.setThread(key, { ...state.getThread(key)!, pendingRun: undefined });
    expect(await sweepMissedMessages(deps)).toBe(1);
    expect(dispatched.map((m) => m.ts)).toEqual([ts(2), ts(3)]);
  });

  it("drops a confirmed prompt's receipt on the first sweep after its run ends (#39)", async () => {
    const { state, deps, dispatched } = fixture("receipt-leak");
    state.claimMessage(key, ts(2), { source: "live" });
    state.settleMessage(key, ts(2), "accepted");
    state.setThread(key, { ...state.getThread(key)!, pendingRun: { userMsgTs: [ts(2)] } });
    deps.fetchReplies = async () => page([msg(2)]);
    await sweepMissedMessages(deps);
    expect(state.getThread(key)?.historyCursorTs).toBe(ts(2));
    expect(state.recoveryStatus().receipts).toBe(1); // kept while the run is pending
    state.setThread(key, { ...state.getThread(key)!, pendingRun: undefined });
    await sweepMissedMessages(deps);
    expect(state.recoveryStatus().receipts).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("new live intent invalidates a collected snapshot before any replay", async () => {
    const { state, deps, dispatched } = fixture("invalidated");
    deps.fetchReplies = vi.fn<CatchupDeps["fetchReplies"]>()
      .mockResolvedValueOnce({ messages: [msg(2)], hasMore: true, pagesUsed: 2, nextCursor: "next" })
      .mockResolvedValue(page([]));
    await sweepMissedMessages(deps);
    state.noteLiveIntent(key);
    await sweepMissedMessages(deps);
    expect(dispatched).toEqual([]);
    expect(state.recoveryStatus().threads[0]?.reason).toBe("snapshot_invalidated");
  });

  it("a missed project/hush command holds later prompts until fresh live intent", async () => {
    const { state, deps, dispatched } = fixture("context-barrier");
    deps.fetchReplies = async () => page([msg(2, "\\cd /elsewhere"), msg(3, "run here")]);
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.getThread(key)?.recovery?.needsFreshIntent).toBe(true);
    expect(state.recoveryStatus().threads[0]?.reason).toBe("historical_command_context");
    state.noteLiveIntent(key);
    expect(state.getThread(key)?.recovery?.needsFreshIntent).toBe(false);
  });

  it("never blindly replays mutating commands or historical permission answers", async () => {
    const { deps, dispatched } = fixture("commands");
    deps.fetchReplies = async () => page([msg(2, "\\permission per_old always"), msg(3, "\\cmd deploy"), msg(4, "\\help")]);
    expect(await sweepMissedMessages(deps)).toBe(0); // diagnostic replies aren't ghost replays
    expect(dispatched.map((m) => m.text)).toEqual(["\\help"]);
  });

  it("holds uncertain work while allowing scan progress without forging acceptance", async () => {
    const { state, deps, dispatched } = fixture("uncertain");
    state.claimMessage(key, ts(2));
    state.settleMessage(key, ts(2), "uncertain");
    deps.fetchReplies = async () => page([msg(2), msg(3, "\\help")]);
    await sweepMissedMessages(deps);
    expect(dispatched.map((m) => m.ts)).toEqual([ts(3)]);
    expect(state.getReceipt(key, ts(2))?.disposition).toBe("uncertain");
    expect(state.isMessageAccepted(key, ts(2))).toBe(false);
    expect(state.getThread(key)?.recovery?.replayFloorTs! > ts(3)).toBe(true);
  });

  it("retries a definite pre-submission failure and never consumes a void observer", async () => {
    const { state, deps } = fixture("retry");
    deps.fetchReplies = async () => page([msg(2)]);
    deps.dispatch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined).mockImplementationOnce(async (m: SlackMsg) => {
      state.claimMessage(key, m.ts); state.settleMessage(key, m.ts, "accepted"); return "accepted";
    });
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(state.getThread(key)?.historyCursorTs).toBe(ts(1));
    expect(await sweepMissedMessages(deps)).toBe(1);
  });
});

describe("recent eligibility and fair read-only discovery", () => {
  it("clamps old maintenance-refreshed chats to 72h and discovers only genuinely recent owner input", async () => {
    const { state, deps, dispatched } = fixture("dormant");
    const old = timestampFromMs(NOW - 30 * 86400_000);
    const path = join(FIXTURES, "dormant-legacy", "state.json");
    mkdirSync(join(FIXTURES, "dormant-legacy"), { recursive: true });
    writeFileSync(path, JSON.stringify({ threads: { [key]: { ...state.getThread(key), recovery: undefined,
      historyCursorTs: old, lastSeenTs: old, lastUsedAt: NOW } }, projects: {} }));
    deps.state = new StateStore(path, () => NOW);
    const fetch = vi.fn<CatchupDeps["fetchReplies"]>().mockResolvedValue(page([msg(2), { ...msg(3), bot_id: "bot" }]));
    deps.fetchReplies = fetch;
    expect(await sweepMissedMessages(deps)).toBe(1);
    expect(fetch.mock.calls[0]![2]).toBe(replayFloor(NOW));
    expect(fetch.mock.calls[0]![3]).toMatchObject({ inclusive: true });
    expect(dispatched.map((m) => m.ts)).toEqual([ts(2)]);
  });

  it("holds legacy no-boundary gaps rather than manufacturing a maintenance watermark", async () => {
    const { state, deps, dispatched } = fixture("no-boundary");
    const path = join(FIXTURES, "no-boundary", "state.json");
    writeFileSync(path, JSON.stringify({ threads: { [key]: { sessionId: "legacy", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW } }, projects: {} }));
    deps.state = new StateStore(path, () => NOW);
    expect(deps.state.getThread(key)?.lastSeenTs).toBeUndefined();
    deps.fetchReplies = async () => page([msg(2)]);
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(deps.state.getThread(key)?.lastSeenTs).toBe(ts(2)); // a real history observation, not migration
    expect(deps.state.getThread(key)?.historyCursorTs).toBeUndefined();
    expect(deps.state.recoveryStatus().threads[0]?.reason).toBe("legacy_without_boundary");
  });

  it("reserves eight recent and two dormant slots and rotates failures with a 20-page cap", async () => {
    const { state, deps } = fixture("fair");
    state.deleteThread(key);
    for (let i = 0; i < 16; i++) {
      const owner = timestampFromMs(NOW - (i < 11 ? LIVE_GRACE_MS + 1000 : MAX_REPLAY_AGE_MS + 1000));
      state.setThread(`${i < 11 ? "R" : "O"}:${i}`, { sessionId: `s${i}`, projectDir: "/p", verbose: "on", createdAt: NOW,
        lastUsedAt: NOW, lastSeenTs: owner, historyCursorTs: owner });
    }
    const fetched: string[] = [];
    const budgets: number[] = [];
    deps.fetchReplies = async (channel, root, _oldest, budget) => { fetched.push(`${channel}:${root}`); budgets.push(budget.maxPages); throw new Error("offline"); };
    for (let i = 0; i < 3; i++) await sweepMissedMessages(deps);
    expect(fetched.slice(0, 10).filter((k) => k.startsWith("R:"))).toHaveLength(8);
    expect(fetched.slice(0, 10).filter((k) => k.startsWith("O:"))).toHaveLength(2);
    expect(new Set(fetched).size).toBe(16);
    expect(budgets.slice(0, 10).reduce((a, b) => a + b)).toBe(20);
  });

  it("coalesces overlapping timer/reconnect calls", async () => {
    const { deps } = fixture("coordinator");
    let now = NOW;
    deps.state = new StateStore(join(FIXTURES, "coordinator", "state.json"), () => now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    deps.fetchReplies = async () => { calls++; await gate; return page([]); };
    const first = sweepMissedMessages(deps);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(sweepMissedMessages(deps)).toBe(first);
    now += LIVE_GRACE_MS; // the coalesced rerun scans past the first sweep's grace horizon
    release();
    await first;
    expect(calls).toBe(2);
  });
});

describe("top-level sweep (\\listen channels + owner DM)", () => {
  const top = (seconds: number, extra: Partial<SlackMsg> = {}): SlackMsg => ({ channel: "L", ts: ts(seconds), user: "U1", text: "work", ...extra });
  function topFixture(name: string, messages: SlackMsg[] = [], clock = () => NOW) {
    const state = new StateStore(join(FIXTURES, name, "state.json"), clock);
    const dispatched: SlackMsg[] = [];
    const deps: TopLevelCatchupDeps = { state, ownerSlackUserId: "U1", channels: ["L"],
      fetchHistory: vi.fn(async () => ({ messages, hasMore: false })),
      fetchReplies: vi.fn<CatchupDeps["fetchReplies"]>(async () => page([])),
      dispatch: async (m) => {
        dispatched.push(m);
        state.claimMessage(`L:${m.ts}`, m.ts, { source: "history" });
        state.settleMessage(`L:${m.ts}`, m.ts, "accepted");
        return "accepted";
      } };
    return { state, deps, dispatched };
  }

  it("seeds a missing watermark at now instead of replaying old history", async () => {
    const { state, deps, dispatched } = topFixture("top-seed", [top(-30)]);
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(deps.fetchHistory).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    expect(state.topLevelWatermark("L")).toBe(timestampFromMs(NOW));
  });

  it("replays only unseen owner top-level prompts after the watermark, once", async () => {
    const live = top(3);
    const { state, deps, dispatched } = topFixture("top-replay", [top(1), top(2), live, top(4, { user: "other" }),
      top(5, { bot_id: "B" }), top(6, { thread_ts: ts(1) }), top(7, { subtype: "channel_join" })]);
    state.setTopLevelWatermark("L", ts(1));
    state.claimMessage(`L:${live.ts}`, live.ts, { source: "live" }); // delivered live
    state.settleMessage(`L:${live.ts}`, live.ts, "accepted");
    expect(await sweepTopLevelMessages(deps)).toBe(1);
    expect(dispatched).toEqual([top(2)]);
    expect(state.topLevelWatermark("L")).toBe(ts(7));
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(deps.fetchHistory).toHaveBeenLastCalledWith("L", ts(7));
  });

  it("skips a DM root the thread sweep already confirmed (#51)", async () => {
    const root = top(2, { channel: "D" });
    const { state, deps, dispatched } = topFixture("top-bound", [root]);
    deps.channels = ["D"];
    state.setTopLevelWatermark("D", ts(1));
    // After confirmHistory: the root is bound and its receipt is gone.
    state.setThread(`D:${root.ts}`, { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW,
      lastSeenTs: root.ts, historyCursorTs: root.ts });
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(deps.fetchReplies).not.toHaveBeenCalled();
    expect(state.topLevelWatermark("D")).toBe(root.ts);
  });

  it("leaves a root inside the live grace to its live event, then recovers it (#38)", async () => {
    let now = NOW;
    const fresh = { ...top(0), ts: timestampFromMs(NOW - 2000) };
    const { state, deps, dispatched } = topFixture("top-grace", [top(2), fresh], () => now);
    state.setTopLevelWatermark("L", ts(1));
    expect(await sweepTopLevelMessages(deps)).toBe(1);
    expect(dispatched.map((m) => m.ts)).toEqual([ts(2)]);
    expect(state.topLevelWatermark("L")).toBe(ts(2));
    now += LIVE_GRACE_MS;
    expect(await sweepTopLevelMessages(deps)).toBe(1);
    expect(dispatched.map((m) => m.ts)).toEqual([ts(2), fresh.ts]);
  });

  it("stops at a retry so the next sweep tries it again", async () => {
    const { state, deps } = topFixture("top-retry", [top(2), top(3)]);
    state.setTopLevelWatermark("L", ts(1));
    deps.dispatch = async () => "retry";
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(state.topLevelWatermark("L")).toBe(ts(1));
  });

  it("holds an over-budget backlog instead of replaying a partial window", async () => {
    const { state, deps, dispatched } = topFixture("top-backlog");
    state.setTopLevelWatermark("L", ts(1));
    deps.fetchHistory = async () => ({ messages: [top(5), top(6)], hasMore: true });
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.topLevelWatermark("L")).toBe(ts(6));
  });

  const reply = (root: SlackMsg, seconds: number, text: string, extra: Partial<SlackMsg> = {}): SlackMsg =>
    ({ channel: "L", ts: ts(seconds), thread_ts: root.ts, user: "U1", text, ...extra });

  it.each(["\\stop", "\\abort", "\\cancel", "\\cd /elsewhere", "\\model x/y"])("a missed root superseded by a later owner %s never starts", async (text) => {
    const root = top(2);
    const { state, deps, dispatched } = topFixture(`top-later-${text.slice(1, 4)}`, [root]);
    state.setTopLevelWatermark("L", ts(1));
    deps.fetchReplies = vi.fn<CatchupDeps["fetchReplies"]>(async () => page([root, reply(root, 3, text)]));
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(deps.fetchReplies).toHaveBeenCalledWith("L", root.ts, root.ts, expect.objectContaining({ maxPages: 2 }));
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.topLevelWatermark("L")).toBe(root.ts);
  });

  it("read-only commands, non-owner replies, and follow-up prompts do not supersede the root", async () => {
    const root = top(2);
    const { deps, dispatched } = topFixture("top-later-benign", [root]);
    deps.state.setTopLevelWatermark("L", ts(1));
    deps.fetchReplies = async () => page([root, reply(root, 3, "\\help"), reply(root, 4, "\\stop", { user: "other" }),
      reply(root, 5, "\\stop", { bot_id: "B" }), reply(root, 6, "and also this")]);
    expect(await sweepTopLevelMessages(deps)).toBe(1);
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(dispatched).toEqual([root]);
  });

  it("holds the root when its replies are unreadable or incomplete", async () => {
    const root = top(2);
    const { state, deps, dispatched } = topFixture("top-later-unreadable", [root]);
    state.setTopLevelWatermark("L", ts(1));
    deps.fetchReplies = async () => { throw new Error("offline"); };
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(state.topLevelWatermark("L")).toBe(ts(1)); // retried next sweep
    deps.fetchReplies = async () => ({ messages: [root], hasMore: true, pagesUsed: 2 });
    expect(await sweepTopLevelMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.topLevelWatermark("L")).toBe(root.ts);
  });

  it("policy: only the top-level sweep may recover an unbound message; \\listen on restarts the watermark", () => {
    const now = NOW;
    expect(classifyRecovery({ ts: ts(2), thread: null, now, context: { source: "history", topLevel: true } }).decision).toBe("recover");
    expect(classifyRecovery({ ts: ts(2), thread: null, now, context: { source: "history" } }).decision).toBe("held");
    const { state } = topFixture("top-toggle");
    state.setAlwaysOn("L", true);
    expect(state.topLevelWatermark("L")).toBe(timestampFromMs(NOW));
    state.setAlwaysOn("L", false);
    expect(state.topLevelWatermark("L")).toBeUndefined();
  });
});
