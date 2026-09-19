import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClient, pendingQuestions, promptAsync, sessionCommand, sessionList, sessionStatus, sseEvents } from "../src/opencode/client.js";
import { COMMAND_TIMEOUT_MS, HTTP_TIMEOUT_MS } from "../src/http.js";

describe("OpenCode request deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function hang() {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signals.push(init.signal!);
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    return signals;
  }

  it("aborts the SDK transport at 30s, without resubmitting a prompt", async () => {
    const signals = hang();
    const rejected = expect(promptAsync(makeClient("http://localhost:4096"), "s1", "hello")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
    await rejected;
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows synchronous commands a longer request budget", async () => {
    const signals = hang();
    const rejected = expect(sessionCommand(makeClient("http://localhost:4096"), "s1", "test", "")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS + 1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    await rejected;
    expect(signals[0]!.aborted).toBe(true);
  });

  it("combines caller cancellation with the generation signal and cleans timers", async () => {
    const signals = hang();
    const generation = new AbortController();
    const caller = new AbortController();
    const result = expect(sessionList(makeClient("http://localhost:4096", { signal: generation.signal }), caller.signal))
      .rejects.toThrow("caller stopped");
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new Error("caller stopped"));
    await result;
    expect(signals[0]!.aborted).toBe(true);
    expect(generation.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds raw calls and refuses a pre-canceled request before fetch", async () => {
    const signals = hang();
    const result = expect(pendingQuestions("http://localhost:4096", { timeoutMs: 50 })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(signals[0]!.aborted).toBe(true);
    await expect(pendingQuestions("http://localhost:4096", { signal: AbortSignal.abort(new Error("canceled")) }))
      .rejects.toThrow("canceled");
    expect(signals).toHaveLength(1);
  });

  it("reads actual SDK session-status map and leaves absent sessions absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://localhost:4096/session/status");
      return Response.json({ s1: { type: "busy" }, s2: { type: "retry", attempt: 1, message: "later", next: 123 } });
    }));
    const statuses = await sessionStatus(makeClient("http://localhost:4096"));
    expect(statuses.s1).toEqual({ type: "busy" });
    expect(statuses.s2?.type).toBe("retry");
    expect(statuses.absent).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("a real SDK fetch aborts a stalled response body and closes its socket", async () => {
  let closed!: () => void;
  const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("[");
    res.on("close", closed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await expect(sessionList(makeClient(`http://127.0.0.1:${address.port}`, { timeoutMs: 150 }))).rejects.toThrow("timed out");
    await socketClosed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("SSE idle watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function stream() {
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const canceled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(c) { input = c; }, cancel: canceled });
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => { signal = init.signal!; return new Response(body); }));
    return { body, canceled, input, signal: () => signal };
  }

  it("cancels a silent reader, aborts fetch, and releases its lock", async () => {
    const s = stream();
    const events = sseEvents("http://localhost:4096", new AbortController().signal, 60_000);
    const result = expect(events.next()).rejects.toThrow("SSE idle timeout");
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(s.signal().aborted).toBe(true);
    expect(s.canceled).toHaveBeenCalled();
    expect(s.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("10s heartbeats keep a stream alive beyond its idle budget; early return cleans up", async () => {
    const s = stream();
    const events = sseEvents("http://localhost:4096", new AbortController().signal);
    for (let i = 0; i < 12; i++) {
      const event = events.next();
      await vi.advanceTimersByTimeAsync(10_000);
      s.input.enqueue(new TextEncoder().encode('data: {"type":"server.heartbeat"}\r\n\r\n'));
      expect((await event).value?.type).toBe("server.heartbeat");
    }
    expect(s.signal().aborted).toBe(false);
    await events.return(undefined);
    expect(s.canceled).toHaveBeenCalled();
    expect(s.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller abort wakes a pending read immediately", async () => {
    const s = stream();
    const controller = new AbortController();
    const result = expect(sseEvents("http://localhost:4096", controller.signal).next()).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("stop"));
    await result;
    expect(s.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
