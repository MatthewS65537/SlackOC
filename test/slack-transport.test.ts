import { webApi } from "@slack/bolt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, _resetQueueForTests, SLACK_OP_TIMEOUT_MS } from "../src/slack/queue.js";
import { slackWebClientOptions, SLACK_UPLOAD_TIMEOUT_MS } from "../src/slack/transport.js";

describe("installed Slack SDK transport boundary", () => {
  beforeEach(() => { _resetQueueForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const client = () => new webApi.WebClient("fake-token", slackWebClientOptions);

  it("exposes SDK retryAfter and lets the queue own exactly one rate-limit retry", async () => {
    const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push(Date.now());
      return calls.length === 1 ? new Response("limited", { status: 429, headers: { "retry-after": "7" } })
        : Response.json({ ok: true, ts: "1" });
    }));
    const sdk = client();
    const response = enqueue(() => sdk.chat.postMessage({ channel: "C1", text: "test" }), { channel: "C1" });
    await vi.advanceTimersByTimeAsync(6999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await response).ts).toBe("1");
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBe(7000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an SDK post at the operation deadline, with no hidden retries or late post", async () => {
    let signal!: AbortSignal;
    const transport = vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const sdk = client();
    const rejected = expect(enqueue(() => sdk.chat.postMessage({ channel: "C1", text: "test" }), { channel: "C1" }))
      .rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(SLACK_OP_TIMEOUT_MS);
    await rejected;
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an upload's binary transfer at its end-to-end budget and never completes it", async () => {
    const urls: string[] = [];
    let transferSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      urls.push(String(url));
      if (String(url).endsWith("files.getUploadURLExternal")) return Promise.resolve(Response.json({
        ok: true, upload_url: "https://files.slack.com/upload/test", file_id: "F1",
      }));
      transferSignal = init.signal!;
      return new Promise((_resolve, reject) => {
        transferSignal.addEventListener("abort", () => reject(transferSignal.reason), { once: true });
      });
    }));
    const sdk = client();
    const rejected = expect(enqueue(() => sdk.filesUploadV2({ channel_id: "C1", filename: "test.txt", file: Buffer.from("test") }), {
      channel: "C1", timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false,
    })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(transferSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SLACK_UPLOAD_TIMEOUT_MS);
    await rejected;
    expect(transferSignal.aborted).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.endsWith("files.completeUploadExternal"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replay a whole upload when its final stage gets rate limited", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith("files.getUploadURLExternal")) return Response.json({
        ok: true, upload_url: "https://files.slack.com/upload/test", file_id: "F1",
      });
      if (String(url).includes("/upload/test")) return new Response("ok");
      return new Response("limited", { status: 429, headers: { "retry-after": "3" } });
    }));
    const sdk = client();
    const rejected = expect(enqueue(() => sdk.filesUploadV2({ channel_id: "C1", filename: "test.txt", file: Buffer.from("test") }), {
      channel: "C1", timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false,
    })).rejects.toMatchObject({ retryAfter: 3 });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(urls).toHaveLength(3);
  });

  it("isolates concurrent lane cancellation and clears successful-operation timers", async () => {
    const signals = new Map<string, AbortSignal>();
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      const channel = new URLSearchParams(String(init.body)).get("channel")!;
      signals.set(channel, init.signal!);
      if (channel === "C1") return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      return Response.json({ ok: true });
    }));
    const sdk = client();
    const stuck = expect(enqueue(() => sdk.chat.postMessage({ channel: "C1", text: "1" }), { channel: "C1", timeoutMs: 100 }))
      .rejects.toThrow("timed out");
    await enqueue(() => sdk.chat.postMessage({ channel: "C2", text: "2" }), { channel: "C2" });
    await vi.advanceTimersByTimeAsync(100);
    await stuck;
    expect(signals.get("C1")!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
