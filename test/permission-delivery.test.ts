import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PermissionDeliveryManager, type PermissionCopy, type PermissionDeliveryDeps } from "../src/slack/permission-delivery.js";
import { PermissionDeliveryStore, permissionDeliveryMarker, type PermissionRecord } from "../src/slack/permissions-store.js";
import * as blocks from "../src/slack/blocks.js";
import { recentLogs } from "../src/log.js";

const dir = resolve("test/.fixtures/permission-delivery");
const path = resolve(dir, "permissions.json");
const record = (): PermissionRecord => ({
  projectDir: "/project", sessionId: "ses_1", requestId: "per_1", generation: 2, threadKey: "C1:100.000001",
  permission: { id: "per_1", sessionID: "ses_1", type: "bash", title: "Run tests" },
  ownerActivityTs: "100.000001", firstObservedAt: 100_000, updatedAt: 100_000,
  thread: { format: "card", status: "new", attempts: 0 }, dm: { format: "card", status: "new", attempts: 0 },
  response: { status: "pending" },
});
const slackError = (error: string) => ({ code: "slack_webapi_platform_error", data: { ok: false, error } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { mkdirSync(dir, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function setup(initial = record()) {
  let time = 200_000;
  const now = () => time;
  const store = new PermissionDeliveryStore(path, { now });
  store.put(initial);
  const isCurrent = vi.fn(() => true);
  const post = vi.fn<PermissionDeliveryDeps["post"]>(async (_r, destination) => ({ ts: "101.000001", channel: destination === "thread" ? "C1" : "D1" }));
  const findCopy = vi.fn<PermissionDeliveryDeps["findCopy"]>(async () => "unknown");
  const onDelivered = vi.fn<PermissionDeliveryDeps["onDelivered"]>(async () => {});
  const onState = vi.fn<NonNullable<PermissionDeliveryDeps["onState"]>>(async () => {});
  const deps = { store, isCurrent, post, findCopy, onDelivered, onState, now };
  const manager = new PermissionDeliveryManager(deps);
  return { ...deps, deps, manager, advance: (ms = 60_000) => { time += ms; }, latest: () => store.get(initial)! };
}

describe("permission delivery", () => {
  it("posts valid native cards with stable top-level markers and coalesces by identity", async () => {
    const h = setup();
    const first = h.manager.deliver(record());
    const identity = { projectDir: "/project", sessionId: "ses_1", requestId: "per_1", generation: 2 };
    expect(h.manager.deliver(identity, { force: true })).toBe(first);
    await first;
    expect(h.post).toHaveBeenCalledTimes(2);
    for (const [r, destination, text, card] of h.post.mock.calls) {
      expect(text).toContain(permissionDeliveryMarker(r, destination));
      expect(text).toContain("\\permission per_1 deny");
      expect(card).toEqual(blocks.permissionBlocks(r.permission, 2));
      expect(r[destination]).toMatchObject({ status: "in-flight", attempts: 1 });
      expect(h.latest()[destination]).toMatchObject({ status: "delivered", format: "card", ts: "101.000001" });
    }
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.onDelivered).toHaveBeenCalledTimes(2);
  });

  it("delivers the DM while the thread is stalled and preserves a late confirmed Deny", async () => {
    const h = setup();
    const thread = deferred<PermissionCopy>();
    h.post.mockImplementation(async (_r, destination) => destination === "thread" ? thread.promise : { ts: "102.000001", channel: "D1" });
    const work = h.manager.deliver(record());
    await vi.waitFor(() => expect(h.latest().dm.status).toBe("delivered"));
    expect(h.latest().thread.status).toBe("in-flight");
    h.store.update(record(), r => { r.response = { status: "resolved", choice: "reject", confirmed: true, text: "Denied" }; });
    thread.resolve({ ts: "103.000001", channel: "C1" });
    await work;
    expect(h.latest().response).toMatchObject({ status: "resolved", choice: "reject", confirmed: true });
    expect(h.latest().dm.ts).toBe("102.000001");
    expect(h.onDelivered).toHaveBeenLastCalledWith(expect.objectContaining({ response: expect.objectContaining({ choice: "reject" }) }), "thread");
    expect(h.latest().thread.ts).toBe("103.000001");
  });

  it.each(["invalid_blocks", "msg_too_long"])("immediately falls back without blocks after %s", async error => {
    const h = setup();
    h.post.mockImplementation(async (_r, destination, _text, card) => {
      if (card) throw slackError(error);
      return { ts: "104.000001", channel: destination === "thread" ? "C1" : "D1" };
    });
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(4);
    for (const call of h.post.mock.calls.filter(call => !call[3])) {
      expect(call).toHaveLength(3);
      expect(call[2]).toContain("\\permission per_1 once");
    }
    expect(h.latest().thread).toMatchObject({ status: "delivered", format: "text", attempts: 2 });
    expect(h.findCopy).not.toHaveBeenCalled();
  });

  it("catches local block construction failures and sends usable text", async () => {
    const h = setup();
    vi.spyOn(blocks, "permissionBlocks").mockImplementation(() => { throw new Error("bad local card"); });
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls.every(call => call.length === 3 && call[2].includes("\\permission per_1 deny"))).toBe(true);
    expect(h.latest().thread.format).toBe("text");
  });

  it("survives malformed optional metadata that also breaks the normal fallback renderer", async () => {
    const initial = record();
    initial.permission.pattern = 123 as never;
    const h = setup(initial);
    await h.manager.deliver(initial);
    expect(h.post.mock.calls.every(call => call.length === 3 && call[2].includes("Run tests"))).toBe(true);
    expect(h.latest().thread.status).toBe("delivered");
  });

  it("adopts a timed-out accepted post on the next sweep without reposting", async () => {
    const h = setup();
    h.post.mockRejectedValue(new Error("timeout"));
    await h.manager.deliver(record());
    expect(h.latest().thread.status).toBe("uncertain");
    expect(h.findCopy).not.toHaveBeenCalled();
    h.findCopy.mockImplementation(async (_r, destination, marker) => {
      expect(marker).toBe(permissionDeliveryMarker(record(), destination));
      return { ts: "105.000001", channel: destination === "thread" ? "C1" : "D1" };
    });
    h.advance();
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.latest().thread).toMatchObject({ status: "delivered", ts: "105.000001", error: undefined });
    expect(h.onDelivered).toHaveBeenCalledTimes(2);
  });

  it("uses a text fallback when complete readable history proves absence", async () => {
    const h = setup();
    h.post.mockRejectedValue(new Error("lost response"));
    await h.manager.deliver(record());
    h.findCopy.mockResolvedValue("absent");
    h.post.mockResolvedValue({ ts: "106.000001", channel: "C1" });
    h.advance();
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(4);
    expect(h.post.mock.calls.slice(2).every(call => call.length === 3)).toBe(true);
    expect(h.latest().thread).toMatchObject({ format: "text", status: "delivered" });
  });

  it("bounds unreadable-history duplicates across restart, even with force and repeated failures", async () => {
    const h = setup();
    h.post.mockRejectedValue(new Error("timeout"));
    h.findCopy.mockRejectedValue(new Error("missing history scope"));
    await h.manager.deliver(record());
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(4);
    expect(h.latest().thread).toMatchObject({ status: "uncertain", format: "text", attempts: 2 });
    const store = new PermissionDeliveryStore(path, { now: h.now });
    const manager = new PermissionDeliveryManager({ ...h.deps, store });
    for (let i = 0; i < 5; i++) await manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(4);
    expect(store.get(record())!.thread.error).toContain("Text fallback already attempted");
    expect(h.onState).toHaveBeenCalledWith(expect.objectContaining({ thread: expect.objectContaining({ status: "uncertain" }) }));
  });

  it("preserves fallback uncertainty after a definite fallback rejection", async () => {
    const h = setup();
    h.post.mockRejectedValue(new Error("timeout"));
    await h.manager.deliver(record());
    h.post.mockRejectedValue(slackError("invalid_auth"));
    await h.manager.deliver(record(), { force: true });
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(4);
    expect(h.latest().thread).toMatchObject({ status: "uncertain", format: "text", attempts: 2 });
  });

  it("can later adopt or retry proven absence after the uncertain fallback budget was spent", async () => {
    const h = setup();
    h.post.mockRejectedValue(new Error("timeout"));
    await h.manager.deliver(record());
    await h.manager.deliver(record(), { force: true });
    h.findCopy.mockImplementation(async (_r, destination) => destination === "thread" ? { ts: "107.000001", channel: "C1" } : "absent");
    h.post.mockResolvedValue({ ts: "108.000001", channel: "D1" });
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(5);
    expect(h.latest().thread.ts).toBe("107.000001");
    expect(h.latest().dm.ts).toBe("108.000001");
  });

  it("recovers an in-flight text fallback across restart without another uncertain post", async () => {
    const initial = record();
    initial.thread = { format: "text", status: "in-flight", attempts: 2 };
    initial.dm = { format: "card", status: "delivered", attempts: 1, ts: "101.000001", channel: "D1" };
    const h = setup(initial);
    const store = new PermissionDeliveryStore(path, { now: h.now });
    await new PermissionDeliveryManager({ ...h.deps, store }).deliver(initial);
    expect(h.post).not.toHaveBeenCalled();
    expect(store.get(initial)!.thread.status).toBe("uncertain");
  });

  it("keeps access failures retryable past three attempts with capped backoff and reconnect force", async () => {
    const h = setup();
    h.post.mockImplementation(async (_r, destination) => {
      if (destination === "thread") throw slackError("not_in_channel");
      return { ts: "109.000001", channel: "D1" };
    });
    await h.manager.deliver(record());
    expect(h.latest().dm.status).toBe("delivered");
    expect(h.latest().thread.error).toContain("not_in_channel");
    for (let i = 0; i < 7; i++) {
      const count = h.post.mock.calls.length;
      await h.manager.deliver(record());
      expect(h.post).toHaveBeenCalledTimes(count);
      h.advance();
      await h.manager.deliver(record());
      expect(h.post).toHaveBeenCalledTimes(count + 1);
    }
    expect(h.latest().thread.attempts).toBe(8);
    h.post.mockResolvedValue({ ts: "110.000001", channel: "C1" });
    await h.manager.deliver(record(), { force: true });
    expect(h.latest().thread).toMatchObject({ status: "delivered", attempts: 9 });
    expect(h.findCopy).not.toHaveBeenCalled();
  });

  it("retains both inaccessible destinations and retries after a token repair", async () => {
    const h = setup();
    h.post.mockRejectedValue(slackError("invalid_auth"));
    await h.manager.deliver(record());
    expect(h.latest().response.status).toBe("pending");
    expect(h.latest().thread.status).toBe("rejected");
    expect(h.latest().dm.status).toBe("rejected");
    h.post.mockResolvedValue({ ts: "111.000001", channel: "C1" });
    await h.manager.deliver(record(), { force: true });
    expect(h.latest().dm.status).toBe("delivered");
  });

  it("leaves 429 retries to the queue and honors Retry-After even under force", async () => {
    const h = setup();
    h.post.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter: 90 });
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.latest().thread.status).toBe("rejected");
    h.advance(89_999);
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(2);
    h.advance(1);
    h.post.mockResolvedValue({ ts: "112.000001", channel: "C1" });
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(4);
    expect(h.post.mock.calls.every(call => call[3])).toBe(true);
  });

  it("never posts resolved or stale asks, including resolution while history is awaiting", async () => {
    const h = setup();
    h.isCurrent.mockReturnValue(false);
    await h.manager.deliver(record());
    expect(h.post).not.toHaveBeenCalled();
    h.isCurrent.mockReturnValue(true);
    h.post.mockRejectedValue(new Error("timeout"));
    await h.manager.deliver(record());
    const history = deferred<"absent">();
    h.findCopy.mockReturnValue(history.promise);
    const work = h.manager.deliver(record(), { force: true });
    await vi.waitFor(() => expect(h.findCopy).toHaveBeenCalledTimes(2));
    h.store.update(record(), r => { r.response.status = "resolved"; });
    history.resolve("absent");
    await work;
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("still adopts discovered copies if resolution arrives during history lookup", async () => {
    const h = setup();
    h.post.mockRejectedValue(new Error("timeout"));
    await h.manager.deliver(record());
    const history = deferred<PermissionCopy>();
    h.findCopy.mockReturnValue(history.promise);
    const work = h.manager.deliver(record(), { force: true });
    await vi.waitFor(() => expect(h.findCopy).toHaveBeenCalledTimes(2));
    h.store.update(record(), r => { r.response = { status: "resolved", choice: "reject", confirmed: true }; });
    history.resolve({ ts: "113.000001", channel: "C1" });
    await work;
    expect(h.onDelivered).toHaveBeenCalledTimes(2);
    expect(h.onDelivered.mock.calls.every(([r]) => r.response.choice === "reject")).toBe(true);
  });

  it("rechecks current state after diagnostics and before the fallback post", async () => {
    const h = setup();
    h.post.mockRejectedValue(slackError("invalid_blocks"));
    h.onState.mockImplementation(r => {
      if (r.thread.status === "rejected" || r.dm.status === "rejected") h.isCurrent.mockReturnValue(false);
    });
    await h.manager.deliver(record());
    expect(h.post.mock.calls.every(call => !!call[3])).toBe(true);
    expect(h.post.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("checks for resolution again after awaiting pre-post diagnostics", async () => {
    const h = setup();
    const diagnostics = deferred<void>();
    h.onState.mockReturnValue(diagnostics.promise);
    const work = h.manager.deliver(record());
    await vi.waitFor(() => expect(h.onState).toHaveBeenCalledTimes(2));
    h.store.update(record(), r => { r.response.status = "resolved"; });
    diagnostics.resolve();
    await work;
    expect(h.post).not.toHaveBeenCalled();
  });

  it("seeds a missing record durably and does not resurrect it from an old caller snapshot", async () => {
    const h = setup();
    const initial = { ...record(), requestId: "per_2", permission: { ...record().permission, id: "per_2" } };
    h.post.mockImplementation(async r => {
      expect(h.store.get(r)).toBeDefined();
      return { ts: "115.000001", channel: "C1" };
    });
    await h.manager.deliver(initial);
    h.store.update(initial, r => { r.response.status = "resolved"; });
    await h.manager.deliver(initial, { force: true });
    expect(h.store.get(initial)!.response.status).toBe("resolved");
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it("prevents effects when durable pre-post writes fail and exposes the error", async () => {
    const h = setup();
    vi.spyOn(h.store, "update").mockImplementation(() => { throw new Error("disk full"); });
    await expect(h.manager.deliver(record())).rejects.toThrow("state/callback failure");
    expect(h.post).not.toHaveBeenCalled();
    expect(h.manager.error).toContain("state/callback failure");
    expect(h.manager.error).toContain("disk full");
    expect(h.latest().thread.status).toBe("new");
  });

  it("adopts rather than reposts if saving a successful post fails", async () => {
    const h = setup();
    const put = h.store.put.bind(h.store);
    const fail = vi.spyOn(h.store, "put").mockImplementation(r => {
      if (r.thread.status === "delivered" || r.dm.status === "delivered") throw new Error("disk full after post");
      put(r);
    });
    await expect(h.manager.deliver(record())).rejects.toThrow();
    expect(h.latest().thread.status).toBe("in-flight");
    fail.mockRestore();
    h.findCopy.mockResolvedValue({ ts: "114.000001", channel: "C1" });
    await h.manager.deliver(record());
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.latest().thread.status).toBe("delivered");
  });

  it("logs callback failures without misclassifying delivered messages or retrying posts", async () => {
    const h = setup();
    h.onDelivered.mockRejectedValue(new Error("collapse failed"));
    h.onState.mockRejectedValue(new Error("diagnostics failed"));
    await expect(h.manager.deliver(record())).rejects.toThrow();
    expect(h.latest().thread.status).toBe("delivered");
    await h.manager.deliver(record(), { force: true });
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(recentLogs().join("\n")).toContain("diagnostics failed");
    expect(h.manager.error).toContain("collapse failed");
  });
});
