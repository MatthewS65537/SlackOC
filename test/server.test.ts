import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isActivityEvent, ServerPool, shouldNotifyDeath, shouldReap, STALE_HEALTH_MS } from "../src/opencode/server.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), sse: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/opencode/client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/opencode/client.js")>(),
  sseEvents: mocks.sse,
}));

describe("server death notification gate", () => {
  it("notifies only for a ready server that was not stopped on purpose", () => {
    expect(shouldNotifyDeath(true, false)).toBe(true); // crash mid-run → page
    expect(shouldNotifyDeath(true, true)).toBe(false); // killOne/\restart/reaper/shutdown
    expect(shouldNotifyDeath(false, false)).toBe(false); // died while still starting — no views exist
    expect(shouldNotifyDeath(false, true)).toBe(false);
  });
});

describe("idle server reaper gate", () => {  const min = 60_000;
  it("reaps a ready server idle past the TTL with no active work", () => {
    const e = { status: "ready", lastEventAt: 0 };
    expect(shouldReap(e, 31 * min, 30 * min, false)).toBe(true);
  });

  it("spares young, busy, and non-ready servers", () => {
    expect(shouldReap({ status: "ready", lastEventAt: 29 * min }, 30 * min, 30 * min, false)).toBe(false); // recent events
    expect(shouldReap({ status: "ready", lastEventAt: 0 }, 31 * min, 30 * min, true)).toBe(false); // active view on it
    expect(shouldReap({ status: "starting", lastEventAt: 0 }, 31 * min, 30 * min, false)).toBe(false); // not ready yet
    expect(shouldReap({ status: "dead", lastEventAt: 0 }, 31 * min, 30 * min, false)).toBe(false);
  });
});

describe("reaper activity filter (RB1)", () => {
  it("heartbeats/connected do not count as activity; real events do", () => {
    expect(isActivityEvent("server.heartbeat")).toBe(false);
    expect(isActivityEvent("server.connected")).toBe(false);
    expect(isActivityEvent("session.idle")).toBe(true);
    expect(isActivityEvent("message.part.updated")).toBe(true);
  });
});

describe("pool generations and request ownership", () => {
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }> = [];
  let pool: ServerPool;
  let fetchMock: ReturnType<typeof vi.fn>;
  const ready = vi.fn();
  const death = vi.fn();
  const connection = vi.fn();
  const resume = vi.fn();
  const busy = vi.fn(() => false);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    children.length = 0;
    ready.mockClear(); death.mockClear(); connection.mockClear(); resume.mockClear(); busy.mockReset().mockReturnValue(false);
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
      children.push(child);
      return child;
    });
    mocks.sse.mockReset().mockImplementation(async function* (_url: string, signal: AbortSignal) {
      yield { type: "server.connected" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    fetchMock = vi.fn(async () => Response.json({ healthy: true }));
    vi.stubGlobal("fetch", fetchMock);
    pool = new ServerPool(() => {}, () => {}, death, resume, ready, { isBusy: busy, onConnectionState: connection });
  });

  afterEach(async () => {
    await pool.killAll();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function boot(dir = "/project") {
    const pending = pool.ensure(dir);
    await vi.advanceTimersByTimeAsync(0);
    children.at(-1)!.stdout.emit("data", Buffer.from("listening http://127.0.0.1:4096\n"));
    await vi.advanceTimersByTimeAsync(0);
    return pending;
  }

  it("coalesces startup and probes duplicate stdout/stderr URLs only once", async () => {
    let healthy!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { healthy = resolve; }));
    const a = pool.ensure("/project");
    const b = pool.ensure("/project/");
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(0);
    const child = children[0]!;
    child.stdout.emit("data", Buffer.from("http://127.0.0.1:4096\n"));
    child.stdout.emit("data", Buffer.from("http://127.0.0.1:4096\n"));
    child.stderr.emit("data", Buffer.from("more output http://127.0.0.1:4096\n"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    healthy(Response.json({ healthy: true }));
    const [first, second] = await Promise.all([a, b]);
    expect(first).toBe(second);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(mocks.sse).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(connection.mock.calls.map((c) => c[1])).toEqual(["connecting", "connected"]);
  });

  it("kill before spawn invalidates pending ensure and permits a fresh ensure", async () => {
    const old = expect(pool.ensure("/project")).rejects.toThrow("canceled");
    await pool.killOne("/project");
    await old;
    const entry = await boot();
    expect(entry.status).toBe("ready");
    expect(children).toHaveLength(1);
  });

  it("startup without a listening URL fails once and does not retain its deadline", async () => {
    const rejected = expect(pool.ensure("/project")).rejects.toThrow("did not start within 45s");
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(pool.get("/project")).toBeNull();
    expect(ready).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("killAll invalidates ensure work even before children have been published", async () => {
    const a = expect(pool.ensure("/project-a")).rejects.toThrow(/canceled|stopped/);
    const b = expect(pool.ensure("/project-b")).rejects.toThrow(/canceled|stopped/);
    await pool.killAll();
    await Promise.all([a, b]);
    expect(pool.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminal close cancels startup and rejects late handlers without respawning", async () => {
    const pending = expect(pool.ensure("/project")).rejects.toThrow(/canceled|stopped/);
    await pool.close();
    await pending;
    await expect(pool.ensure("/late-project")).rejects.toThrow("closed");
    await expect(pool.acquire("/late-project")).rejects.toThrow("closed");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(pool.list()).toEqual([]);
  });

  it("late health success and old child exit cannot revive or evict a replacement", async () => {
    let healthy!: (value: Response) => void;
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      signal = init.signal!;
      return new Promise<Response>((resolve) => { healthy = resolve; });
    });
    const old = expect(pool.ensure("/project")).rejects.toThrow("stopped");
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.stdout.emit("data", Buffer.from("http://127.0.0.1:4096\n"));
    await pool.killOne("/project");
    await old;
    expect(signal.aborted).toBe(true);
    const replacement = await boot();
    healthy(Response.json({ healthy: true }));
    children[0]!.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.get("/project")).toBe(replacement);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(death).not.toHaveBeenCalled();
    expect(mocks.sse).toHaveBeenCalledTimes(1);
  });

  it("exit during startup rejects promptly; health success after exit cannot signal ready", async () => {
    let healthy!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { healthy = resolve; }));
    const pending = expect(pool.ensure("/project")).rejects.toThrow("exited early");
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.stdout.emit("data", Buffer.from("http://127.0.0.1:4096\n"));
    children[0]!.emit("exit", 1);
    await pending;
    healthy(Response.json({ healthy: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.get("/project")).toBeNull();
    expect(ready).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stale-ready health at 5s and preserves active views", async () => {
    const entry = await boot();
    busy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(STALE_HEALTH_MS);
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const first = pool.ensure("/project");
    const second = pool.ensure("/project");
    expect(first).toBe(second);
    const rejected = expect(first).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(pool.get("/project")).toBe(entry);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(connection).toHaveBeenLastCalledWith("/project", "reconnecting");
  });

  it("replaces an idle unhealthy generation but ignores its later exit", async () => {
    const old = await boot();
    await vi.advanceTimersByTimeAsync(STALE_HEALTH_MS);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const pending = pool.ensure("/project");
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    children[1]!.stdout.emit("data", Buffer.from("http://127.0.0.1:4097\n"));
    const entry = await pending;
    children[0]!.emit("exit", 0);
    expect(entry).not.toBe(old);
    expect(pool.get("/project")).toBe(entry);
    expect(death).not.toHaveBeenCalled();
  });

  it("protects leases through session creation and releases idempotently", async () => {
    await boot();
    const lease = await pool.acquire("/project");
    await vi.advanceTimersByTimeAsync(STALE_HEALTH_MS);
    expect(pool.reapIdle(10, () => false)).toBe(0);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(pool.ensure("/project")).rejects.toThrow("health failed");
    expect(children).toHaveLength(1);
    lease.release(); lease.release();
    await vi.advanceTimersByTimeAsync(11);
    expect(pool.reapIdle(10, () => false)).toBe(1);
    expect(pool.get("/project")).toBeNull();
  });

  it("protects SDK requests and in-flight ensure from the reaper", async () => {
    const entry = await boot();
    let complete!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const request = entry.client!.session.create({ body: {} });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 100_000);
    expect(pool.reapIdle(10, () => false)).toBe(0);
    complete(Response.json({ id: "s1" }));
    await request;
    await vi.advanceTimersByTimeAsync(11);
    const ensure = pool.ensure("/project");
    expect(pool.reapIdle(10, () => false)).toBe(0);
    await ensure;
    expect(pool.get("/project")).toBe(entry);
  });

  it("unexpected ready death cancels requests and reports only that generation", async () => {
    const entry = await boot();
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = expect(entry.client!.session.list()).rejects.toThrow("server exited");
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.emit("exit", 9);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(death).toHaveBeenCalledExactlyOnceWith("/project", 9);
    expect(connection).toHaveBeenLastCalledWith("/project", "disconnected");
  });

  it("reports stream recovery and cancels reconnect backoff when the generation stops", async () => {
    mocks.sse.mockImplementationOnce(async function* () {
      yield { type: "server.connected" };
      throw new Error("stream lost");
    });
    await boot();
    expect(connection).toHaveBeenLastCalledWith("/project", "reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(resume).toHaveBeenCalledExactlyOnceWith("/project", 1000);
    expect(connection).toHaveBeenLastCalledWith("/project", "connected");
    await pool.killOne("/project");
    mocks.sse.mockImplementationOnce(async function* () { throw new Error("offline"); });
    await boot();
    expect(connection).toHaveBeenLastCalledWith("/project", "reconnecting");
    const attempts = mocks.sse.mock.calls.length;
    await pool.killOne("/project");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.sse).toHaveBeenCalledTimes(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });
});
