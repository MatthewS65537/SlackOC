import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePermissionButton, parsePermissionCommand, PermissionDeliveryStore, permissionDeliveryMarker, PermissionResponder, type PermissionRecord, type PermissionResponseInput } from "../src/slack/permissions.js";

const dir = resolve("test/.fixtures/permissions");
const path = resolve(dir, "permissions.json");
const record = (overrides: Partial<PermissionRecord> = {}): PermissionRecord => ({
  projectDir: "/project", sessionId: "ses_1", requestId: "per_1", generation: 2, threadKey: "C1:100.000001",
  permission: { id: "per_1", sessionID: "ses_1", type: "bash", title: "Run tests", messageID: "msg_1", callID: "tool_1" },
  ownerActivityTs: "100.000001", firstObservedAt: 100_000, updatedAt: 100_000,
  thread: { format: "card", status: "new", attempts: 0 }, dm: { format: "card", status: "new", attempts: 0 },
  response: { status: "pending" }, ...overrides,
});
const input = (overrides: Partial<PermissionResponseInput> = {}): PermissionResponseInput => ({
  actor: "OWNER", requestId: "per_1", response: "once", context: { threadKey: "C1:100.000001" }, ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { mkdirSync(dir, { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setup(r = record()) {
  const store = new PermissionDeliveryStore(path, { now: () => 200_000 });
  store.put(r);
  const server = {};
  const getRunning = vi.fn((): object | undefined => server);
  const getBinding = vi.fn(() => ({ projectDir: r.projectDir, sessionId: r.sessionId, generation: r.generation }));
  const findPending = vi.fn(async () => [r.permission]);
  const respond = vi.fn(async () => {});
  const resolved = vi.fn(async () => {});
  const eligible = vi.fn(() => true);
  const responder = new PermissionResponder({ ownerSlackUserId: "OWNER", store, getRunning, getBinding, findPending, respond, resolved, eligible });
  return { store, server, getRunning, getBinding, findPending, respond, resolved, eligible, responder };
}

describe("permission input validation", () => {
  it.each(["once", "always", "reject"] as const)("validates %s and matching new/legacy action IDs", r => {
    const value = { s: "ses_1", p: "per_1", r, g: 2 };
    expect(parsePermissionButton(`perm_${r}`, JSON.stringify(value))).toEqual(value);
    expect(parsePermissionButton("perm", JSON.stringify(value))).toEqual(value);
    expect(parsePermissionButton("perm_bogus", JSON.stringify(value))).toBeUndefined();
  });
  it.each([null, "{", "null", "{}", JSON.stringify({ s: "ses_1", p: "per_1", r: "yes" }),
    JSON.stringify({ s: "ses_1", p: "per_1", r: "once", g: -1 }), JSON.stringify({ s: "ses_1", p: "bad id", r: "once" })])("rejects malformed payload %s", raw => {
    expect(parsePermissionButton("perm_once", raw)).toBeUndefined();
  });
  it("rejects mismatched action decisions and accepts only exact text grammar", () => {
    expect(parsePermissionButton("perm_once", JSON.stringify({ s: "ses_1", p: "per_1", r: "reject" }))).toBeUndefined();
    expect(parsePermissionCommand("per_1 deny")).toEqual({ requestId: "per_1", response: "reject" });
    expect(parsePermissionCommand("per_1 always")).toEqual({ requestId: "per_1", response: "always" });
    for (const text of ["yes", "ok", "per_1 reject", "per_1 once extra", "per_1", "per_1 ONCE"]) expect(parsePermissionCommand(text)).toBeUndefined();
  });
});

describe("shared permission responder", () => {
  it.each(["once", "always", "reject"] as const)("confirms %s and deduplicates subsequent decisions", async choice => {
    const h = setup();
    const result = await h.responder.respond(input({ response: choice }));
    expect(result.status).toBe("resolved");
    expect(result.record?.response).toMatchObject({ choice, confirmed: true, actor: "OWNER" });
    expect(h.respond).toHaveBeenCalledWith(h.server, record().permission, choice);
    await h.responder.respond(input({ response: "always", context: { dm: true } }));
    await h.responder.observeResolved(record());
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.resolved).toHaveBeenCalledTimes(1);
    expect(h.store.get(record())!.response.choice).toBe(choice);
  });

  it("checks owner, exact ID/session/thread/action/generation and lifecycle before querying", async () => {
    const h = setup();
    for (const [override, status] of [
      [{ actor: "OTHER" }, "forbidden"], [{ requestId: "per" }, "missing"], [{ sessionId: "ses_other" }, "missing"],
      [{ context: { threadKey: "C2:100.000001" } }, "missing"], [{ generation: 3 }, "missing"],
      [{ source: "history" }, "stale"],
      [{ actionId: "perm_reject" }, "invalid"], [{ response: "yes" }, "invalid"],
    ] as [Partial<PermissionResponseInput>, string][]) {
      expect((await h.responder.respond(input(override))).status).toBe(status);
    }
    h.getBinding.mockReturnValue({ projectDir: "/project", sessionId: "ses_1", generation: 3 });
    expect((await h.responder.respond(input())).status).toBe("stale");
    expect(h.findPending).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("never spawns an unavailable server and never replies on untrusted pending evidence", async () => {
    const h = setup();
    h.getRunning.mockReturnValue(undefined);
    expect((await h.responder.respond(input())).status).toBe("unavailable");
    expect(h.findPending).not.toHaveBeenCalled();
    h.getRunning.mockReturnValue(h.server);
    h.findPending.mockRejectedValueOnce(new Error("offline"));
    expect((await h.responder.respond(input())).status).toBe("unavailable");
    h.findPending.mockResolvedValueOnce([{} as never]);
    expect((await h.responder.respond(input())).status).toBe("unavailable");
    h.findPending.mockResolvedValueOnce([{ ...record().permission, sessionID: "ses_other" }]);
    expect((await h.responder.respond(input())).status).toBe("stale");
    h.findPending.mockResolvedValueOnce([{ ...record().permission, callID: "wrong_tool" }]);
    expect((await h.responder.respond(input())).status).toBe("stale");
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("refuses ambiguous owner-DM IDs across projects", async () => {
    const h = setup();
    h.store.put(record({ projectDir: "/other", threadKey: "C2:100.000001" }));
    expect((await h.responder.respond(input({ context: { dm: true } }))).status).toBe("ambiguous");
    expect(h.findPending).not.toHaveBeenCalled();
  });

  it("locks before the first await across thread/DM/text and ignores racing SSE echoes", async () => {
    const h = setup();
    const pending = deferred<ReturnType<typeof record>["permission"][]>();
    const reply = deferred<void>();
    h.findPending.mockReturnValueOnce(pending.promise);
    h.respond.mockReturnValueOnce(reply.promise);
    const first = h.responder.respond(input({ response: "reject", actionId: "perm_reject" }));
    expect((await h.responder.respond(input({ context: { dm: true } }))).status).toBe("busy");
    expect((await h.responder.respond(input())).status).toBe("busy");
    pending.resolve([record().permission]);
    await vi.waitFor(() => expect(h.respond).toHaveBeenCalledTimes(1));
    expect(await h.responder.observeResolved(record())).toBeUndefined();
    h.store.update(record(), r => { r.dm = { format: "text", status: "delivered", attempts: 1, channel: "D1", ts: "101.000001" }; });
    reply.resolve();
    const result = await first;
    expect(result.text).toContain("Denied");
    expect(result.record!.dm.ts).toBe("101.000001");
    expect(h.respond).toHaveBeenCalledTimes(1);
    await h.responder.observeResolved(record());
    expect(h.store.get(record())!.response.text).toContain("Denied");
  });

  it("does not send a reply when an external resolution overtakes the pending query", async () => {
    const h = setup();
    const pending = deferred<ReturnType<typeof record>["permission"][]>();
    h.findPending.mockReturnValueOnce(pending.promise);
    const response = h.responder.respond(input());
    await h.responder.observeResolved(record());
    pending.resolve([record().permission]);
    expect((await response).text).toContain("not confirmed");
    expect(h.respond).not.toHaveBeenCalled();
  });

  it.each(["binding", "server", "eligibility"])("rechecks %s after pending query, before the effect", async kind => {
    const h = setup();
    const pending = deferred<ReturnType<typeof record>["permission"][]>();
    h.findPending.mockReturnValueOnce(pending.promise);
    const result = h.responder.respond(input());
    if (kind === "binding") h.getBinding.mockReturnValue({ projectDir: "/project", sessionId: "new_session", generation: 3 });
    if (kind === "server") h.getRunning.mockReturnValue({});
    if (kind === "eligibility") h.eligible.mockReturnValue(false);
    pending.resolve([record().permission]);
    expect((await result).status).toBe("stale");
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("treats disappearance as resolved/expired without claiming approval", async () => {
    const h = setup();
    h.findPending.mockResolvedValue([]);
    const result = await h.responder.respond(input());
    expect(result.status).toBe("resolved");
    expect(result.text).toContain("not confirmed");
    expect(result.record!.response.confirmed).toBe(false);
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("persists uncertain outcomes, reconciles without resend, and requires a fresh decision", async () => {
    const h = setup();
    h.respond.mockRejectedValueOnce(new Error("timeout after server accepted?"));
    expect((await h.responder.respond(input())).status).toBe("uncertain");
    expect(new PermissionDeliveryStore(path).get(record())!.response.status).toBe("uncertain");
    h.findPending.mockRejectedValueOnce(new Error("offline"));
    expect((await h.responder.respond(input())).status).toBe("unavailable");
    expect(h.store.get(record())!.response.status).toBe("uncertain");
    expect((await h.responder.respond(input())).status).toBe("retry");
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect((await h.responder.respond(input({ response: "reject" }))).text).toContain("Denied");
    expect(h.respond).toHaveBeenCalledTimes(2);
  });

  it("reconciles a vanished uncertain request without attributing the attempted choice", async () => {
    const h = setup(record({ response: { status: "uncertain", choice: "once" } }));
    h.findPending.mockResolvedValue([]);
    const result = await h.responder.respond(input());
    expect(result.record!.response.confirmed).toBe(false);
    expect(result.text).not.toContain("Approved");
    expect(h.respond).not.toHaveBeenCalled();
  });

  it("does not retry an accepted reply when collapsing Slack copies fails", async () => {
    const h = setup();
    h.resolved.mockRejectedValueOnce(new Error("Slack unavailable"));
    const result = await h.responder.respond(input());
    expect(result.status).toBe("resolved");
    expect(result.notificationError).toContain("Slack unavailable");
    expect(h.store.get(record())!.response.confirmed).toBe(true);
    await h.responder.respond(input());
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it("durability failure before reply has no external effect and releases the lock", async () => {
    const h = setup();
    vi.spyOn(h.store, "put").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(h.responder.respond(input())).rejects.toThrow("disk full");
    expect(h.respond).not.toHaveBeenCalled();
    expect((await h.responder.respond(input())).status).toBe("resolved");
  });
});

describe("durable permission delivery store", () => {
  it("roundtrips scope, original time, per-destination format/errors and response uncertainty", () => {
    const h = setup(record({ response: { status: "answering", choice: "reject", actor: "OWNER" },
      thread: { status: "in-flight", format: "card", attempts: 1, error: "timeout" },
      dm: { status: "delivered", format: "text", attempts: 2, channel: "D1", ts: "101.000001" } }));
    h.store.put({ ...h.store.get(record())!, ownerActivityTs: "999.000001", firstObservedAt: 999_000 });
    const restored = new PermissionDeliveryStore(path).get(record())!;
    expect(restored).toMatchObject({ generation: 2, ownerActivityTs: "100.000001", firstObservedAt: 100_000,
      thread: { status: "uncertain", error: "timeout" }, dm: { status: "delivered", format: "text", ts: "101.000001" },
      response: { status: "uncertain", choice: "reject" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["permissions.json"]);
    expect(permissionDeliveryMarker(restored, "thread")).toBe(permissionDeliveryMarker(record(), "thread"));
    expect(permissionDeliveryMarker(restored, "thread")).not.toBe(permissionDeliveryMarker(restored, "dm"));
  });

  it("evicts terminal evidence at capacity but never silently loses unresolved requests", () => {
    const store = new PermissionDeliveryStore(path, { maxRecords: 2, now: () => 200_000 });
    store.put(record({ response: { status: "resolved" } }));
    store.put(record({ generation: 3, response: { status: "uncertain" } }));
    store.put(record({ generation: 4 }));
    expect(store.list().map(r => r.generation)).toEqual([3, 4]);
    const before = readFileSync(path, "utf8");
    expect(() => store.put(record({ generation: 5 }))).toThrow("full");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(store.list()).toHaveLength(2);
  });

  it("prunes terminal records by age without refreshing original owner time", () => {
    let now = 100_000;
    const store = new PermissionDeliveryStore(path, { now: () => now, resolvedRetentionMs: 100 });
    store.put(record({ response: { status: "resolved" } }));
    now += 101;
    store.put(record({ generation: 3 }));
    expect(store.list().map(r => r.generation)).toEqual([3]);
  });

  it("fails closed on corrupted state and malformed records", () => {
    writeFileSync(path, "{broken");
    expect(() => new PermissionDeliveryStore(path)).toThrow();
    rmSync(path);
    const store = new PermissionDeliveryStore(path);
    expect(() => store.put(record({ permission: { ...record().permission, id: "other" } }))).toThrow("Invalid");
    expect(() => store.put(record({ thread: { status: "delivered", format: "card", attempts: 1 } }))).toThrow("destination");
  });

  it("returns snapshots and refuses mutation of scope/identity", () => {
    const h = setup();
    h.store.get(record())!.response.status = "resolved";
    h.store.list()[0]!.dm.status = "uncertain";
    expect(h.store.get(record())!.response.status).toBe("pending");
    expect(h.store.get(record())!.dm.status).toBe("new");
    expect(() => h.store.put(record({ threadKey: "wrong" }))).toThrow("scope");
    expect(() => h.store.update(record(), r => { r.generation++; })).toThrow("identity");
  });
});
