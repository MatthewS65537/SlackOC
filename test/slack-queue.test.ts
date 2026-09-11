import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetQueueForTests, droppedOpCount, enqueue, SLACK_OP_TIMEOUT_MS } from "../src/slack/queue.js";

// The queue is a module-global singleton — reset pacing state between cases
// so fake-timer clock jumps can't bleed across tests.
describe("Slack FIFO queue (B2: per-op timeout)", () => {
  beforeEach(() => {
    _resetQueueForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("an operation that never resolves is rejected after the timeout", async () => {
    const p = enqueue(() => new Promise(() => {}));
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(SLACK_OP_TIMEOUT_MS + 2_000);
    await assertion;
  });

  it("a timed-out op does not block operations queued behind it", async () => {
    const stuck = enqueue(() => new Promise(() => {})).catch((e: Error) => e.message);
    const next = enqueue(() => Promise.resolve("made it"));
    await vi.advanceTimersByTimeAsync(SLACK_OP_TIMEOUT_MS + 5_000);
    await expect(stuck).resolves.toMatch(/timed out/);
    await expect(next).resolves.toBe("made it");
  });

  it("results and non-rate-limit errors pass straight through", async () => {
    const ok = expect(enqueue(() => Promise.resolve(42))).resolves.toBe(42);
    const bad = expect(enqueue(() => Promise.reject(new Error("channel_not_found")))).rejects.toThrow("channel_not_found");
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([ok, bad]);
  });

  it("rate-limit errors back off 3 times then give up", async () => {
    let calls = 0;
    const p = enqueue(() => {
      calls += 1;
      return Promise.reject(new Error("HTTP 429 rate limited"));
    }).catch((e: Error) => e.message);
    // initial attempt + 3 retries (2s, 4s, 8s backoff)
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toMatch(/429/);
    expect(calls).toBe(4);
  });

  it("dropped ops are counted for \\status (RB5)", async () => {
    expect(droppedOpCount()).toBe(0);
    const p1 = enqueue(() => Promise.reject(new Error("HTTP 429"))).catch(() => {});
    const p2 = enqueue(() => Promise.reject(new Error("channel_not_found"))).catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([p1, p2]);
    expect(droppedOpCount()).toBe(2);
  });
});
