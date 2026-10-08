import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetQueueForTests, classifyTransport, droppedOpCount, enqueue, noteSlackOnline, slackOffline } from "../src/slack/queue.js";

const netErr = (code?: string): Error => {
  const inner = Object.assign(new Error("getaddrinfo"), code ? { code } : {});
  const fetchErr = new TypeError("fetch failed", { cause: inner });
  return Object.assign(new Error("A request error occurred: fetch failed"), { code: "slack_webapi_request_error", original: fetchErr });
};

describe("Slack queue: transient network errors", () => {
  beforeEach(() => { _resetQueueForTests(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("classifies connect-phase vs ambiguous vs non-network errors", () => {
    expect(classifyTransport(netErr("ENOTFOUND"))).toBe("connect");
    expect(classifyTransport(netErr("ECONNRESET"))).toBe("ambiguous");
    expect(classifyTransport(netErr())).toBe("ambiguous");
    expect(classifyTransport(new Error("slack call timed out (30s)"))).toBeNull();
    expect(classifyTransport(Object.assign(new Error("An API error occurred: invalid_blocks"), { code: "slack_webapi_platform_error" }))).toBeNull();
  });

  it("retries a post whose request never left the machine (DNS) and succeeds", async () => {
    let calls = 0;
    const p = enqueue(async () => { if (++calls < 3) throw netErr("ENOTFOUND"); return "ok"; }, { channel: "C1" });
    await vi.advanceTimersByTimeAsync(5_000); // 1s + 2s backoff (+ post pacing)
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
    expect(droppedOpCount()).toBe(0);
  });

  it("does NOT replay a post after an ambiguous mid-flight failure (no duplicate messages)", async () => {
    let calls = 0;
    const p = enqueue(async () => { calls++; throw netErr("ECONNRESET"); }, { channel: "C1" });
    const rejected = expect(p).rejects.toThrow(/fetch failed/);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(calls).toBe(1);
  });

  it("replays an idempotent update after an ambiguous failure", async () => {
    let calls = 0;
    const p = enqueue(async () => { if (++calls < 2) throw netErr("ECONNRESET"); return "ok"; }, { channel: "C1", method: "chat.update" });
    await vi.advanceTimersByTimeAsync(1_005);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("gives up after 4 retries and counts the drop", async () => {
    let calls = 0;
    const p = enqueue(async () => { calls++; throw netErr("ENOTFOUND"); }, { channel: "C1", method: "chat.update" });
    const rejected = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(calls).toBe(5);
    expect(droppedOpCount()).toBe(1);
  });

  it("engages a shared offline brake after repeated failures; success or reconnect releases it", async () => {
    const failing = enqueue(async () => { throw netErr("ENOTFOUND"); }, { channel: "C1", method: "chat.update" });
    failing.catch(() => {});
    await vi.advanceTimersByTimeAsync(3_005); // three failures
    expect(slackOffline()).toBe(true);
    // Another lane waits for the brake instead of hammering.
    let otherCalls = 0;
    const other = enqueue(async () => { otherCalls++; return "ok"; }, { channel: "C2", method: "chat.update" });
    await vi.advanceTimersByTimeAsync(10);
    expect(otherCalls).toBe(0);
    noteSlackOnline();
    expect(slackOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); // its already-computed brake wait ends
    await expect(other).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(120_000);
  });

  it("uploads with retryRateLimits=false are never replayed", async () => {
    let calls = 0;
    const p = enqueue(async () => { calls++; throw netErr("ENOTFOUND"); }, { channel: "C1", method: "files.upload", retryRateLimits: false });
    const rejected = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(calls).toBe(1);
  });
});
