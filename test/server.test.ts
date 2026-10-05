import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerPool } from "../src/opencode/server.js";
const f = vi.hoisted(() => ({ ensure: vi.fn(), stop: vi.fn(), events: vi.fn(), make: vi.fn() }));
vi.mock("@opencode/client/service", () => ({ Service: { ensure: f.ensure, stop: f.stop, headers: () => ({ authorization: "fixture" }) } }));
vi.mock("../src/opencode/client.js", () => ({ makeClient: f.make, clientEvents: f.events }));

describe("V2 shared-service ownership", () => {
  let pool: ServerPool;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    f.ensure.mockResolvedValue({ url: "http://127.0.0.1:1234" });
    f.make.mockImplementation((_url, options) => ({ directory: options.directory, options }));
    f.events.mockImplementation(async function* (_client, signal: AbortSignal) {
      yield { type: "server.connected" };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    });
    pool = new ServerPool(vi.fn());
  });
  afterEach(async () => { await pool.close(); vi.useRealTimers(); });

  it("discovers once for concurrent projects and uses one event subscription", async () => {
    const [a, b, again] = await Promise.all([pool.ensure("/a"), pool.ensure("/b"), pool.ensure("/a")]);
    expect(a).toBe(again);
    expect(a.client?.directory).toBe("/a"); expect(b.client?.directory).toBe("/b");
    expect(f.ensure).toHaveBeenCalledOnce(); expect(f.events).toHaveBeenCalledOnce();
  });
  it("requires the supported stable V2 minimum during service discovery", async () => {
    await pool.ensure("/a");
    const compatible = f.ensure.mock.calls[0]![0].version as (version: string) => boolean;
    for (const version of ["2.0.12", "v2.0.12", "2.0.13", "2.1.0", "2.0.12+build.1"]) {
      expect(compatible(version), version).toBe(true);
    }
    for (const version of ["1.18.31", "2.0.11", "3.0.0", "2.0.12-beta.1", "2.1.0-beta", "2.garbage", "2.0", "02.0.12", "2.0.12junk", "", "2.9007199254740992.0"]) {
      expect(compatible(version), version).toBe(false);
    }
  });
  it("warm prompts never wait on health checks or rediscovery, even after idle", async () => {
    const entry = await pool.ensure("/a");
    await vi.advanceTimersByTimeAsync(3600_000);
    const lease = await pool.acquire("/a");
    expect(lease.entry).toBe(entry); lease.release(); lease.release();
    expect(pool.reapIdle(1, () => false)).toBe(0);
    expect(f.ensure).toHaveBeenCalledOnce();
  });
  it("closing or detaching SlackOC never stops the shared OpenCode service", async () => {
    await pool.ensure("/a"); await pool.killOne("/a");
    expect(pool.acquireExisting("/a")).toBeUndefined();
    await pool.close();
    expect(f.stop).not.toHaveBeenCalled();
    await expect(pool.ensure("/b")).rejects.toThrow("closed");
  });
  it("discovery failure does not leave a ready handle and a later attempt recovers", async () => {
    f.ensure.mockRejectedValueOnce(new Error("offline"));
    await expect(pool.ensure("/a")).rejects.toThrow("offline");
    expect(pool.get("/a")).toBeNull();
    expect((await pool.ensure("/a")).status).toBe("ready");
  });
  it("reconnects the stream, preserves clients, and reconciles after a disconnect", async () => {
    const resume = vi.fn(); pool = new ServerPool(vi.fn(), vi.fn(), undefined, resume);
    const entry = await pool.ensure("/a");
    const client = entry.client;
    f.ensure.mockResolvedValue({ url: "http://127.0.0.1:5678" });
    await pool.reconnect(); await vi.advanceTimersByTimeAsync(100);
    expect(entry.client).toBe(client);
    expect(entry.url).toBe("http://127.0.0.1:5678");
    expect(resume).toHaveBeenCalledTimes(2);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("filters other locations and does not await Slack from event ingestion", async () => {
    const event = vi.fn(); pool = new ServerPool(event);
    f.events.mockImplementationOnce(async function* (_client, signal: AbortSignal) {
      yield { type: "server.connected" };
      yield { type: "question.asked", directory: "/other", properties: { id: "no" } };
      yield { type: "question.asked", directory: "/a", properties: { id: "yes" } };
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await pool.ensure("/a"); await vi.advanceTimersByTimeAsync(0);
    expect(event).toHaveBeenCalledWith("/a", "question.asked", { id: "yes" });
    expect(event).not.toHaveBeenCalledWith("/other", expect.anything(), expect.anything());
  });
});
