import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCatchupCoordinator, MAX_SNAPSHOT_CANDIDATES, sweepMissedMessages, type CatchupDeps } from "../src/slack/catchup.js";
import { StateStore, type ThreadState } from "../src/state.js";
import { MAX_REPLAY_AGE_MS, replayFloor, timestampFromMs } from "../src/slack/recovery-policy.js";
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
  const deps: CatchupDeps = { state, ownerSlackUserId: "U1", fetchReplies: async () => [], dispatch: async (m) => {
    dispatched.push(m);
    state.claimMessage(key, m.ts, { source: "history" });
    state.settleMessage(key, m.ts, "accepted");
    return "accepted";
  } };
  return { state, deps, dispatched };
}
const msg = (seconds: number, text = "work"): SlackMsg => ({ channel: "C", thread_ts: ts(0), ts: ts(seconds), user: "U1", text });

describe("bounded classified history", () => {
  it("filters parent, bots, subtypes and other users, stamping channel-less owner rows", async () => {
    const { state, deps, dispatched } = fixture("filter");
    deps.fetchReplies = async () => [msg(0), msg(2), { ...msg(3), user: "other" }, { ...msg(4), bot_id: "B" },
      { ...msg(5), subtype: "message_changed" }].map(({ channel, ...row }) => row as SlackMsg);
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
    expect(fetch.mock.calls[1]![3]).toMatchObject({ latest: timestampFromMs(NOW), maxPages: 2 });
    expect(dispatched).toEqual([]);
    expect(state.getThread(key)?.recovery?.canceledThroughTs).toBe(ts(4));
    expect(state.isMessageAccepted(key, ts(2))).toBe(false);
    expect(state.recoveryStatus().canceled).toBe(2);
  });

  it("holds an overflow instead of truncating it into executable work", async () => {
    const { state, deps, dispatched } = fixture("overflow");
    deps.fetchReplies = async () => Array.from({ length: MAX_SNAPSHOT_CANDIDATES + 1 }, (_, i) => ({ ...msg(2), ts: `${ts(2).split(".")[0]}.${String(i).padStart(6, "0")}` }));
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.recoveryStatus().threads[0]?.reason).toBe("backlog_overflow");
    expect(state.getThread(key)?.recovery?.scan).toBeUndefined();
  });

  it("waits for the previous classified task to finish, then sends the next in order", async () => {
    const { state, deps, dispatched } = fixture("sequential");
    deps.fetchReplies = async () => [msg(2), msg(3)];
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

  it("new live intent invalidates a collected snapshot before any replay", async () => {
    const { state, deps, dispatched } = fixture("invalidated");
    deps.fetchReplies = vi.fn<CatchupDeps["fetchReplies"]>()
      .mockResolvedValueOnce({ messages: [msg(2)], hasMore: true, pagesUsed: 2, nextCursor: "next" })
      .mockResolvedValue([]);
    await sweepMissedMessages(deps);
    state.noteLiveIntent(key);
    await sweepMissedMessages(deps);
    expect(dispatched).toEqual([]);
    expect(state.recoveryStatus().threads[0]?.reason).toBe("snapshot_invalidated");
  });

  it("a missed project/hush command holds later prompts until fresh live intent", async () => {
    const { state, deps, dispatched } = fixture("context-barrier");
    deps.fetchReplies = async () => [msg(2, "\\cd /elsewhere"), msg(3, "run here")];
    expect(await sweepMissedMessages(deps)).toBe(0);
    expect(dispatched).toEqual([]);
    expect(state.getThread(key)?.recovery?.needsFreshIntent).toBe(true);
    expect(state.recoveryStatus().threads[0]?.reason).toBe("historical_command_context");
    state.noteLiveIntent(key);
    expect(state.getThread(key)?.recovery?.needsFreshIntent).toBe(false);
  });

  it("never blindly replays mutating commands or historical permission answers", async () => {
    const { deps, dispatched } = fixture("commands");
    deps.fetchReplies = async () => [msg(2, "\\permission per_old always"), msg(3, "\\cmd deploy"), msg(4, "\\help")];
    expect(await sweepMissedMessages(deps)).toBe(0); // diagnostic replies aren't ghost replays
    expect(dispatched.map((m) => m.text)).toEqual(["\\help"]);
  });

  it("holds uncertain work while allowing scan progress without forging acceptance", async () => {
    const { state, deps, dispatched } = fixture("uncertain");
    state.claimMessage(key, ts(2));
    state.settleMessage(key, ts(2), "uncertain");
    deps.fetchReplies = async () => [msg(2), msg(3, "\\help")];
    await sweepMissedMessages(deps);
    expect(dispatched.map((m) => m.ts)).toEqual([ts(3)]);
    expect(state.getReceipt(key, ts(2))?.disposition).toBe("uncertain");
    expect(state.isMessageAccepted(key, ts(2))).toBe(false);
    expect(state.getThread(key)?.recovery?.replayFloorTs! > ts(3)).toBe(true);
  });

  it("retries a definite pre-submission failure and never consumes a void observer", async () => {
    const { state, deps } = fixture("retry");
    deps.fetchReplies = async () => [msg(2)];
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
    const fetch = vi.fn<CatchupDeps["fetchReplies"]>().mockResolvedValue([msg(2), { ...msg(3), bot_id: "bot" }]);
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
    deps.state.seedMissingWatermarks();
    expect(deps.state.getThread(key)?.lastSeenTs).toBeUndefined();
    deps.fetchReplies = async () => [msg(2)];
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
      const owner = timestampFromMs(NOW - (i < 11 ? 1000 : MAX_REPLAY_AGE_MS + 1000));
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    deps.fetchReplies = async () => { calls++; await gate; return []; };
    const coordinator = createCatchupCoordinator(deps);
    const first = coordinator.request();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(coordinator.request()).toBe(first);
    release();
    await first;
    expect(calls).toBe(2);
  });
});
