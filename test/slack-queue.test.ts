import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQueueForTests,
  droppedOpCount,
  enqueue,
  laneDepth,
  oldestPendingAgeMs,
  PROMOTE_AFTER_MS,
  queueDepth,
  SLACK_OP_TIMEOUT_MS,
  SLACK_PACE_MS,
} from "../src/slack/queue.js";

// The queue is a module-global singleton — reset pacing state between cases
// so fake-timer clock jumps can't bleed across tests.
describe("Slack queue: per-op guards (B2)", () => {
  beforeEach(() => {
    _resetQueueForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("an operation that never resolves is rejected after the timeout", async () => {
    const p = enqueue(() => new Promise(() => {}), { channel: "C1" });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(SLACK_OP_TIMEOUT_MS + 2_000);
    await assertion;
  });

  it("a timed-out op does not block operations queued behind it", async () => {
    const stuck = enqueue(() => new Promise(() => { }), { channel: "C1" }).catch((e: Error) => e.message);
    const next = enqueue(() => Promise.resolve("made it"), { channel: "C1" });
    await vi.advanceTimersByTimeAsync(SLACK_OP_TIMEOUT_MS + 5_000);
    await expect(stuck).resolves.toMatch(/timed out/);
    await expect(next).resolves.toBe("made it");
  });

  it("results and non-rate-limit errors pass straight through", async () => {
    const ok = expect(enqueue(() => Promise.resolve(42), { channel: "C1" })).resolves.toBe(42);
    const bad = expect(enqueue(() => Promise.reject(new Error("channel_not_found")), { channel: "C1" })).rejects.toThrow(
      "channel_not_found",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([ok, bad]);
  });

  it("rate-limit errors back off 3 times then give up", async () => {
    let calls = 0;
    const p = enqueue(
      () => {
        calls += 1;
        return Promise.reject(new Error("HTTP 429 rate limited"));
      },
      { channel: "C1" },
    ).catch((e: Error) => e.message);
    // initial attempt + 3 retries (2s, 4s, 8s backoff)
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toMatch(/429/);
    expect(calls).toBe(4);
  });

  it("dropped ops are counted for \\status (RB5)", async () => {
    expect(droppedOpCount()).toBe(0);
    const p1 = enqueue(() => Promise.reject(new Error("HTTP 429")), { channel: "C1" }).catch(() => {});
    const p2 = enqueue(() => Promise.reject(new Error("channel_not_found")), { channel: "C1" }).catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([p1, p2]);
    expect(droppedOpCount()).toBe(2);
  });
});

/**
 * Priority tiers are only meaningful for ops queued behind a running one —
 * the drain commits to the next op immediately, so tests stage contenders
 * behind a blocker that occupies the lane's head.
 */
function blocker(channel = "C1"): { release: () => void } {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  void enqueue(() => p, { channel }).catch(() => {});
  return { release };
}

describe("Slack queue: priority tiers in one channel lane (#5)", () => {
  beforeEach(() => {
    _resetQueueForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("interactive ops overtake queued background ops (command replies beat stream traffic)", async () => {
    const { release } = blocker();
    const order: string[] = [];
    const bg = enqueue(() => (order.push("bg"), Promise.resolve()), { channel: "C1" });
    const int = enqueue(() => (order.push("int"), Promise.resolve()), { channel: "C1", lane: "interactive" });
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([bg, int]);
    expect(order).toEqual(["int", "bg"]);
  });

  it("FIFO is preserved within a tier", async () => {
    const { release } = blocker();
    const order: number[] = [];
    const a = enqueue(() => (order.push(1), Promise.resolve()), { channel: "C1", lane: "interactive" });
    const b = enqueue(() => (order.push(2), Promise.resolve()), { channel: "C1", lane: "interactive" });
    const c = enqueue(() => (order.push(3), Promise.resolve()), { channel: "C1" });
    const d = enqueue(() => (order.push(4), Promise.resolve()), { channel: "C1" });
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([a, b, c, d]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it(`a background op pending > PROMOTE_AFTER_MS promotes ahead of interactive traffic`, async () => {
    const { release } = blocker();
    const order: string[] = [];
    const bg = enqueue(() => (order.push("bg"), Promise.resolve()), { channel: "C1" });
    await vi.advanceTimersByTimeAsync(1); // bg queued behind the blocker
    // Age the queued op past the promotion threshold by jumping the clock —
    // setSystemTime doesn't fire timers, so the blocker's 30s op-timeout
    // stays put (a 31s advance-by-time would trip it mid-test).
    vi.setSystemTime(Date.now() + PROMOTE_AFTER_MS + 1_000);
    const int = enqueue(() => (order.push("int"), Promise.resolve()), { channel: "C1", lane: "interactive" });
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([bg, int]);
    expect(order).toEqual(["bg", "int"]);
  });
});

describe("Slack queue: per-channel lanes (#5)", () => {
  beforeEach(() => {
    _resetQueueForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("different channels do not serialize — each lane starts its first op immediately", async () => {
    const times: Record<string, number | undefined> = {};
    const a = enqueue(() => Promise.resolve((times.A = Date.now())), { channel: "CA" });
    const b = enqueue(() => Promise.resolve((times.B = Date.now())), { channel: "CB" });
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([a, b]);
    // Both ran on the same tick — no 1.05s stagger across lanes.
    expect(times.B! - times.A!).toBe(0);
  });

  it("a burst in one channel does not delay another channel's lane", async () => {
    const times: Record<string, number | undefined> = {};
    const burst = [0, 1, 2].map((i) => enqueue(() => Promise.resolve((times[`A${i}`] = Date.now())), { channel: "CA" }));
    const quiet = enqueue(() => Promise.resolve((times.B = Date.now())), { channel: "CB" });
    await vi.advanceTimersByTimeAsync(1); // CA's chain still pacing op 2 — CB is already done
    expect(times.B).toBeDefined();
    expect(times.A1).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SLACK_PACE_MS * 3);
    await Promise.all(burst.concat(quiet));
    // CB's op completed without waiting for CA's paced chain.
    expect(times.B! - times.A0!).toBeLessThan(SLACK_PACE_MS);
  });

  it("pacing is preserved WITHIN one channel lane", async () => {
    const times: number[] = [];
    const ops = [0, 1, 2].map(() => enqueue(() => Promise.resolve(times.push(Date.now())), { channel: "C1" }));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(SLACK_PACE_MS);
    await vi.advanceTimersByTimeAsync(SLACK_PACE_MS);
    await Promise.all(ops);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(SLACK_PACE_MS);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(SLACK_PACE_MS);
  });

  it("a 429 holds EVERY lane for the brake window (app+method-scoped limits)", async () => {
    const err429 = Object.assign(new Error("HTTP 429"), { data: { retry_after: 5 } });
    let aCalls = 0;
    const a = enqueue(
      () => {
        aCalls += 1;
        return aCalls === 1 ? Promise.reject(err429) : Promise.resolve("a-ok");
      },
      { channel: "CA" },
    );
    // The brake engages the moment CA's op 429s. CB's own lane is free, but
    // its op must wait out the same Retry-After window.
    await vi.advanceTimersByTimeAsync(100);
    let bRanAt = -1;
    const b = enqueue(() => Promise.resolve((bRanAt = Date.now(), "b-ok")), { channel: "CB" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bRanAt).toBe(-1); // held by the brake, not by CB's pacing
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(a).resolves.toBe("a-ok");
    await expect(b).resolves.toBe("b-ok");
    expect(aCalls).toBe(2);
  });
});

describe("Slack queue: health stats for \\status", () => {
  beforeEach(() => {
    _resetQueueForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("queueDepth/laneDepth count PENDING ops per tier scope; oldestPendingAgeMs ages the oldest", async () => {
    expect(queueDepth()).toBe(0);
    expect(laneDepth("C1")).toBe(0);
    expect(oldestPendingAgeMs()).toBe(0);
    const b1 = blocker("C1"); // occupies C1's drain — not itself "pending"
    const b2 = blocker("C2"); // same for C2 (a free lane starts ops immediately)
    const p1 = enqueue(() => Promise.resolve(), { channel: "C1" });
    const p2 = enqueue(() => Promise.resolve(), { channel: "C1", lane: "interactive" });
    const p3 = enqueue(() => Promise.resolve(), { channel: "C2" });
    expect(queueDepth()).toBe(3);
    expect(laneDepth("C1")).toBe(2);
    expect(laneDepth("C2")).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(oldestPendingAgeMs()).toBeGreaterThanOrEqual(5_000);
    b1.release();
    b2.release();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([p1, p2, p3]);
    expect(queueDepth()).toBe(0);
    expect(oldestPendingAgeMs()).toBe(0);
  });
});
