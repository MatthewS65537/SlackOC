import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocketModeClient } from "@slack/socket-mode";
import { SlackWebSocket } from "../node_modules/@slack/socket-mode/dist/src/SlackWebSocket.js";
import { isSocketModeFailure, SocketSupervisor } from "../src/slack/socket-supervisor.js";

/** Mimics SocketModeClient with autoReconnectEnabled=false. */
class FakeSocket extends EventEmitter {
  starts = 0;
  disconnects = 0;
  failNext = 0;
  hang = false;
  async start(): Promise<void> {
    this.starts++;
    if (this.hang) return new Promise(() => {});
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("A request error occurred: fetch failed");
    }
    this.emit("connected");
  }
  async disconnect(): Promise<void> {
    this.disconnects++;
    this.emit("disconnected");
  }
  drop(): void { this.emit("disconnected"); }
}

describe("SocketSupervisor", () => {
  let socket: FakeSocket;
  let logs: string[];
  beforeEach(() => { vi.useFakeTimers(); socket = new FakeSocket(); logs = []; });
  afterEach(() => { vi.useRealTimers(); });
  const make = (opts: Partial<ConstructorParameters<typeof SocketSupervisor>[1]> = {}) => {
    const sup = new SocketSupervisor(socket, { log: l => logs.push(l), random: () => 0.5, ...opts });
    sup.start();
    return sup;
  };

  it("reconnects quickly after a routine disconnect", async () => {
    const onRecovered = vi.fn();
    const sup = make({ onRecovered });
    socket.drop();
    expect(sup.health().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(socket.starts).toBe(1);
    expect(sup.health().connected).toBe(true);
    expect(onRecovered).toHaveBeenCalledOnce();
    sup.stop();
  });

  it("takes over a failed initial connect instead of leaving the socket down", async () => {
    const onRecovered = vi.fn();
    const sup = new SocketSupervisor(socket, { log: l => logs.push(l), random: () => 0.5, onRecovered });
    sup.start(false);
    expect(sup.health().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(socket.starts).toBe(1);
    expect(sup.health().connected).toBe(true);
    expect(onRecovered).toHaveBeenCalledOnce();
    sup.stop();
  });

  it("keeps retrying with backoff where the library would give up (fetch failed)", async () => {
    const sup = make();
    socket.failNext = 3;
    socket.drop();
    await vi.advanceTimersByTimeAsync(250); // attempt 1 fails
    expect(socket.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); // backoff 1s → attempt 2 fails
    expect(socket.starts).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000); // 2s → attempt 3 fails
    expect(socket.starts).toBe(3);
    await vi.advanceTimersByTimeAsync(4_000); // 4s → attempt 4 succeeds
    expect(socket.starts).toBe(4);
    expect(sup.health().connected).toBe(true);
    expect(logs.some(l => l.includes("reconnect failed"))).toBe(true);
    sup.stop();
  });

  it("caps backoff at 60s and never runs two starts at once", async () => {
    const sup = make();
    socket.failNext = 100;
    socket.drop();
    let maxConcurrent = 0; let inFlight = 0;
    const orig = socket.start.bind(socket);
    socket.start = async () => { inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight); try { await orig(); } finally { inFlight--; } };
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(maxConcurrent).toBe(1);
    // 1+2+4+8+16+32 = 63s for the first 6 attempts, then one per 60s.
    expect(socket.starts).toBeGreaterThan(10);
    expect(socket.starts).toBeLessThan(20);
    sup.stop();
  });

  it("times out a hung start, but retries only after that start settles", async () => {
    const sup = make({ startTimeoutMs: 10_000 });
    let fail!: (err: Error) => void;
    socket.start = async () => { socket.starts++; return new Promise<void>((_, reject) => { fail = reject; }); };
    socket.drop();
    await vi.advanceTimersByTimeAsync(250 + 10_000);
    expect(logs.some(l => l.includes("start timed out"))).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(socket.starts).toBe(1); // no overlapping start, not even from the backstop check
    socket.start = FakeSocket.prototype.start;
    fail(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.starts).toBe(2);
    expect(sup.health().connected).toBe(true);
    sup.stop();
  });

  it("treats an unhandled socket-mode rejection as a disconnect", async () => {
    const sup = make();
    sup.noteLibraryFailure(new Error("fetch failed"));
    expect(sup.health().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(sup.health().connected).toBe(true);
    sup.stop();
  });

  it("fires onFatal once after the fatal window", async () => {
    const onFatal = vi.fn();
    const sup = make({ fatalAfterMs: 10 * 60_000, onFatal });
    socket.failNext = 1_000;
    socket.drop();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(onFatal).toHaveBeenCalledOnce();
    sup.stop();
  });

  it("detects wake via timer drift and requests catch-up", () => {
    let now = 0;
    const onRecovered = vi.fn();
    const sup = make({ now: () => now, onRecovered, checkEveryMs: 15_000 });
    now = 15_000; sup.check();
    expect(onRecovered).not.toHaveBeenCalled();
    now = 15_000 + 15_000 + 600_000; sup.check();
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(logs.some(l => l.includes("wake detected"))).toBe(true);
    sup.stop();
  });

  it("does not reconnect after stop()", async () => {
    const sup = make();
    sup.stop();
    socket.drop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.starts).toBe(0);
  });
});

describe("isSocketModeFailure", () => {
  it("recognizes socket-mode stacks only", () => {
    const e = new Error("x");
    e.stack = "Error: x\n    at /a/node_modules/@slack/socket-mode/dist/src/SocketModeClient.js:1:1";
    expect(isSocketModeFailure(e)).toBe(true);
    expect(isSocketModeFailure(new Error("boom"))).toBe(false);
  });
});

/** The installed @slack/socket-mode client, with only its URL fetch and WebSocket boundaries mocked. */
describe("SocketSupervisor with the real Socket Mode client", () => {
  const proto = SlackWebSocket.prototype as any;
  const original = { connect: proto.connect, disconnect: proto.disconnect };
  let open: Set<unknown>;
  let maxOpen: number;
  let urls: Array<(url: string) => void>;
  let client: any;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is forbidden"); }));
    open = new Set(); maxOpen = 0; urls = [];
    proto.connect = function (this: any) { open.add(this); maxOpen = Math.max(maxOpen, open.size); this.options.client.emit("connected"); };
    proto.disconnect = function (this: any) { open.delete(this); this.options.client.emit("disconnected"); };
    const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => "error", setName() {} };
    client = new SocketModeClient({ appToken: "xapp-test", autoReconnectEnabled: false, logger: logger as never });
    client.retrieveWSSURL = () => new Promise<string>(resolve => urls.push(resolve));
  });
  afterEach(() => {
    Object.assign(proto, original);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const supervise = () => {
    const sup = new SocketSupervisor(client, { log: () => {}, random: () => 0.5, startTimeoutMs: 10_000 });
    sup.start(false);
    return sup;
  };

  it("never opens a competing socket when a timed-out start's URL arrives late", async () => {
    const sup = supervise();
    await vi.advanceTimersByTimeAsync(250 + 10_000 + 5 * 60_000);
    expect(urls).toHaveLength(1);
    urls[0]!("wss://late.invalid/1"); // the expired start opens, then is closed
    await vi.advanceTimersByTimeAsync(0);
    expect(open.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(urls).toHaveLength(2);
    urls[1]!("wss://fresh.invalid/2");
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.health().connected).toBe(true);
    expect(open.size).toBe(1);
    expect(maxOpen).toBe(1);
    sup.stop();
    await client.disconnect();
    expect(open.size).toBe(0);
  });

  it("closes a startup that completes after shutdown", async () => {
    const sup = supervise();
    await vi.advanceTimersByTimeAsync(250 + 10_000);
    sup.stop();
    await client.disconnect();
    urls[0]!("wss://late.invalid/1");
    await vi.advanceTimersByTimeAsync(0);
    expect(open.size).toBe(0);
    expect(urls).toHaveLength(1);
  });
});
