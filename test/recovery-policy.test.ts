import { describe, expect, it } from "vitest";
import { classifyPendingRun, classifyRecovery, compareTs, isRecentRecoveryEligibleReceipt, isRecentRecoveryEligibleThread, MAX_REPLAY_AGE_MS, microsTimestamp, replayAge, timestampFromMs, timestampMicros } from "../src/slack/recovery-policy.js";
import type { ThreadState } from "../src/state.js";
const NOW = Date.parse("2026-09-22T00:00:00Z");
const recent = timestampFromMs(NOW - 1000);
function thread(): ThreadState {
  return { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW,
    historyCursorTs: timestampFromMs(NOW - 5000), recovery: { version: 1, ownerActivityTs: recent,
      replayFloorTs: timestampFromMs(NOW - MAX_REPLAY_AGE_MS), bindingGeneration: 3, intentVersion: 1 } };
}
describe("hard original-message age", () => {
  it("accepts 71h59m and exactly 72h, expires one microsecond older", () => {
    const boundary = timestampFromMs(NOW - MAX_REPLAY_AGE_MS);
    expect(replayAge(timestampFromMs(NOW - MAX_REPLAY_AGE_MS + 60_000), NOW).decision).toBe("recover");
    expect(replayAge(boundary, NOW).decision).toBe("recover");
    expect(replayAge(microsTimestamp(timestampMicros(boundary)! - 1n), NOW).decision).toBe("expired");
  });
  it("rejects unknown, malformed and materially future dates and compares nonuniform widths numerically", () => {
    for (const value of [undefined, "NaN", "1e9.000001", "1789999999.1234567", timestampFromMs(NOW + 60_001)])
      expect(replayAge(value, NOW).reason).toBe("invalid_timestamp");
    expect(compareTs("9.9", "10.01")).toBe(-1);
    expect(compareTs("10.1", "10.100000")).toBe(0);
  });
  it("does not use maintenance time for thread or receipt eligibility", () => {
    const t = thread();
    t.recovery!.ownerActivityTs = timestampFromMs(NOW - MAX_REPLAY_AGE_MS - 1);
    expect(isRecentRecoveryEligibleThread(t, NOW)).toBe(false);
    expect(isRecentRecoveryEligibleReceipt({ threadKey: "C:T", ts: t.recovery!.ownerActivityTs, disposition: "uncertain", updatedAt: NOW }, NOW)).toBe(false);
  });
});
describe("deterministic decisions", () => {
  it("distinguishes completion of earlier input, newer accepted intent, cancellation and changed binding", () => {
    const t = thread();
    const classify = () => classifyRecovery({ ts: recent, thread: t, now: NOW, context: { source: "history", generation: 3, intentVersion: 1 } });
    t.recovery!.lastRun = { generation: 3, sessionId: "s", userMsgTs: [timestampFromMs(NOW - 2000)], messageIds: ["msg_old"], outcome: "completed" };
    expect(classify().decision).toBe("recover");
    t.recovery!.latestAcceptedTs = timestampFromMs(NOW);
    expect(classify().reason).toBe("overtaken_by_accepted_prompt");
    t.recovery!.canceledThroughTs = recent;
    expect(classify().decision).toBe("canceled");
    delete t.recovery!.canceledThroughTs;
    t.recovery!.bindingGeneration++;
    expect(classify().reason).toBe("binding_changed");
  });
  it("boot expires old pending work and only proposes inspection for exact accepted recent associations", () => {
    const t = thread();
    t.pendingRun = { userMsgTs: [timestampFromMs(NOW - MAX_REPLAY_AGE_MS - 1)] };
    expect(classifyPendingRun(t, [], NOW).decision).toBe("expired");
    t.pendingRun.userMsgTs = [recent];
    expect(classifyPendingRun(t, [], NOW).decision).toBe("held");
    expect(classifyPendingRun(t, [{ threadKey: "C:T", ts: recent, disposition: "accepted", updatedAt: NOW,
      submission: { projectDir: "/p", sessionId: "s", messageId: "msg_exact" } }], NOW).reason).toBe("inspect_exact_run");
  });
});
