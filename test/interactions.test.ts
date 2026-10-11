import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInteractions } from "../src/slack/interactions.js";
import { PermissionDeliveryStore, permissionDeliveryMarker, type PermissionRecord } from "../src/slack/permissions-store.js";
import { QuestionsStore, questionBindingToken, type QuestionSnapshot } from "../src/slack/questions-store.js";
import { questionPresentationMarker } from "../src/slack/question-ui.js";
import { _resetQueueForTests } from "../src/slack/queue.js";
import { normalizeForm } from "../src/opencode/v2.js";

const root = resolve("test/.fixtures/interactions");
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Restart-shaped harness: durable stores exist before createInteractions, with no live asks. */
function harness(name: string) {
  _resetQueueForTests();
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const ownerTs = `${Math.floor(now / 1000)}.000001`;
  const rootTs = `${Math.floor(now / 1000) - 30}.000001`;
  const threadKey = `C1:${rootTs}`;
  const thread: any = { sessionId: "ses_1", projectDir: dir, recovery: { bindingGeneration: 1, ownerActivityTs: ownerTs,
    lastRun: { outcome: "active", sessionId: "ses_1", userMsgTs: [ownerTs] } }, pendingRun: { userMsgTs: [ownerTs] } };
  const state: any = { now: () => Date.now(), getThread: (key: string) => key === threadKey ? structuredClone(thread) : null,
    findThreadBySession: (id: string) => id === thread.sessionId ? { key: threadKey, thread: structuredClone(thread) } : null,
    bindingGeneration: () => thread.recovery.bindingGeneration };
  const updates: any[] = [];
  const posts: any[] = [];
  const histories: any[] = [];
  const replies = vi.fn(async (args: any): Promise<any> => { histories.push(args); return { messages: [] }; });
  const app: any = { action() {}, view() {}, client: {
    chat: { update: async (args: any) => { updates.push(args); return {}; }, delete: async () => ({}),
      postMessage: async (args: any) => { posts.push(args); return { ts: "1791400999.000001" }; } },
    conversations: { replies, history: async (args: any) => { histories.push(args); return { messages: [] }; },
      open: async () => ({ channel: { id: "D1" } }) } } };
  // Any native reply/answer would go through these; reconciliation must never call them.
  const native = { permission: vi.fn(), formReply: vi.fn(), formCancel: vi.fn() };
  const client: any = { postSessionIdPermissionsPermissionId: native.permission,
    v2: { permission: { request: { list: vi.fn(async () => ({ data: [] as unknown[] })) } }, form: { list: vi.fn(async () => ({ data: [] as unknown[] })) },
      session: { form: { reply: native.formReply, cancel: native.formCancel } } } };
  const entry: any = { dir, baseUrl: "http://never-used.invalid", status: "ready", client };
  const pool: any = { get: () => entry, list: () => [entry], acquireExisting: () => ({ entry, release() {} }) };
  const permissionStore = new PermissionDeliveryStore(join(dir, "permissions.json"));
  const questionStore = new QuestionsStore(join(dir, "questions.json"));
  const start = () => createInteractions({ app, state, pool, permissionStore, questionStore,
    config: { ownerSlackUserId: "U_OWNER" } as any, render: {} as any,
    isStopping: () => false, enabled: () => true, dmChannel: () => "D1", setDmChannel() {}, botUserId: () => "U_BOT",
    scheduledReports: () => undefined, viewThread: () => "" });
  const permission = (): PermissionRecord => ({ projectDir: dir, sessionId: "ses_1", requestId: "per_1", generation: 1, threadKey,
    permission: { id: "per_1", sessionID: "ses_1", type: "bash", title: "Run tests" },
    ownerActivityTs: ownerTs, firstObservedAt: now, updatedAt: now,
    thread: { status: "delivered", format: "card", attempts: 1, channel: "C1", ts: "1791400000.000001" },
    dm: { status: "delivered", format: "card", attempts: 1, channel: "D1", ts: "1791400000.000002" },
    response: { status: "pending" } });
  return { dir, thread, threadKey, rootTs, client, native, replies, updates, posts, histories, permissionStore, questionStore, start, permission };
}

const noControls = (u: any) => u.blocks.every((b: any) => b.type !== "actions");

describe("saved permissions absent from the authoritative sweep (#21)", () => {
  it("resolves a never-hydrated request as unconfirmed, collapses both copies, and stops listing it", async () => {
    const h = harness("absent");
    h.permissionStore.put(h.permission());
    const interactions = h.start();
    await interactions.refreshPermissions();
    await interactions.refreshPermissions();
    const record = h.permissionStore.list()[0]!;
    expect(record.response).toMatchObject({ status: "resolved", confirmed: false });
    expect(record.response.choice).toBeUndefined();
    expect(record.response.text).toMatch(/not confirmed/);
    expect(h.updates.map(u => [u.channel, u.ts])).toEqual([["C1", "1791400000.000001"], ["D1", "1791400000.000002"]]);
    expect(h.updates.every(noControls)).toBe(true);
    expect([record.thread.collapsed, record.dm.collapsed]).toEqual([true, true]);
    expect(await interactions.permissions.list({ threadKey: h.threadKey })).toMatch(/no pending requests/);
    expect(h.posts).toEqual([]);
    expect(h.native.permission).not.toHaveBeenCalled();
    interactions.close();
  });

  it.each([
    ["rejected", () => Promise.reject(new Error("server down"))],
    ["malformed", async () => ({ data: [{ id: 7 }] })],
  ])("resolves nothing when the upstream query is %s", async (_label, list) => {
    const h = harness("failed");
    h.permissionStore.put(h.permission());
    h.client.v2.permission.request.list.mockImplementation(list);
    const interactions = h.start();
    await interactions.refreshPermissions();
    expect(h.permissionStore.list()[0]!.response.status).toBe("pending");
    expect(h.updates).toEqual([]);
    expect(await interactions.permissions.list({ threadKey: h.threadKey })).toMatch(/per_1/);
    interactions.close();
  });

  it("keeps a request still pending upstream usable", async () => {
    const h = harness("present");
    h.permissionStore.put(h.permission());
    h.client.v2.permission.request.list.mockResolvedValue({ data: [{ id: "per_1", sessionID: "ses_1", action: "bash", message: "Run tests" }] });
    const interactions = h.start();
    await interactions.refreshPermissions();
    await interactions.refreshPermissions();
    expect(h.permissionStore.list()[0]!.response.status).toBe("pending");
    expect(h.updates).toEqual([]);
    expect(h.posts).toEqual([]);
    expect(await interactions.permissions.list({ threadKey: h.threadKey })).toMatch(/\\permission per_1 once/);
    interactions.close();
  });
});

describe("response-lost copies of resolved permissions (#22)", () => {
  const resolvedWithLostThreadCard = (h: ReturnType<typeof harness>): PermissionRecord => ({ ...h.permission(),
    thread: { status: "uncertain", format: "card", attempts: 1 },
    dm: { status: "delivered", format: "card", attempts: 1, channel: "D1", ts: "1791400000.000002", collapsed: true },
    response: { status: "resolved", choice: "once", actor: "U_OWNER", confirmed: true, text: "Allow once confirmed." } });

  it("adopts the accepted card by its exact bot marker after restart and collapses it with the confirmed text", async () => {
    const h = harness("terminal");
    const record = resolvedWithLostThreadCard(h);
    const marker = permissionDeliveryMarker(record, "thread");
    h.replies.mockImplementation(async (args: any) => { h.histories.push(args); return { messages: [
      { user: "U_OTHER", ts: "1791400000.000004", text: `quoted\n${marker}` },
      { user: "U_BOT", ts: "1791400000.000003", text: `Permission card\n${marker}` }], has_more: false }; });
    h.permissionStore.put(record);
    const interactions = h.start();
    await interactions.refreshPermissions();
    await interactions.refreshPermissions();
    const after = h.permissionStore.list()[0]!;
    expect(after.thread).toMatchObject({ status: "delivered", channel: "C1", ts: "1791400000.000003", collapsed: true });
    expect(after.response).toMatchObject({ status: "resolved", choice: "once", confirmed: true, text: "Allow once confirmed." });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ channel: "C1", ts: "1791400000.000003", text: "Allow once confirmed." });
    expect(noControls(h.updates[0])).toBe(true);
    expect(h.histories).toHaveLength(1);
    expect(h.histories[0]).toMatchObject({ channel: "C1", ts: h.rootTs });
    expect(h.posts).toEqual([]);
    expect(h.native.permission).not.toHaveBeenCalled();
    interactions.close();
  });

  it("never posts a replacement when history is incomplete", async () => {
    const h = harness("terminal-incomplete");
    h.replies.mockImplementation(async (args: any) => { h.histories.push(args); return { messages: [], has_more: true }; });
    h.permissionStore.put(resolvedWithLostThreadCard(h));
    const interactions = h.start();
    await interactions.refreshPermissions(true);
    expect(h.permissionStore.list()[0]!.thread.status).toBe("uncertain");
    expect(h.posts).toEqual([]);
    expect(h.updates).toEqual([]);
    interactions.close();
  });
});

describe("question placement-marker recovery in long threads (#19)", () => {
  // Thread history requests share the queue's 1.5s pacing clock; run it on fake time.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  async function settle<T>(work: Promise<T>): Promise<T> {
    let done = false;
    void work.finally(() => { done = true; }).catch(() => {});
    while (!done) await vi.advanceTimersByTimeAsync(250);
    return work;
  }

  function setup(name: string, secondPage: (marker: string) => any) {
    const h = harness(name);
    const rawForm: any = { id: "frm_1", sessionID: "ses_1", title: "Choose", fields: [
      { key: "answer", type: "string", title: "Choose", required: true, options: [{ label: "A", description: "A" }] }] };
    const req = normalizeForm(rawForm);
    h.client.v2.form.list.mockResolvedValue({ data: [rawForm] });
    const oldTs = "1791400000.000001";
    const record: QuestionSnapshot = { id: req.id, sessionId: req.sessionID, projectDir: h.dir, generation: 1, channel: "C1", threadTs: h.rootTs,
      req, answers: [[]], finalized: [false], askTs: oldTs, dmTs: null, response: "pending",
      presentation: 1, threadPresentation: 0, dmPresentation: 0, ui: { revision: 2, threadApplied: 1, dmApplied: 0 }, updatedAt: Date.now(),
      threadDelivery: { status: "delivered", attempts: 1 }, dmDelivery: { status: "uncertain", attempts: 3 } };
    record.relocation = { thread: { epoch: 1, oldTs, status: "uncertain", attempts: 1,
      binding: questionBindingToken(record), generation: 1, channel: "C1", threadTs: h.rootTs } };
    const marker = questionPresentationMarker(record, "thread");
    const firstPage = { messages: Array.from({ length: 100 }, (_, i) => ({ user: "U_BOT", ts: `1791400000.${String(i + 1).padStart(6, "0")}`, text: `prior output ${i}` })),
      has_more: true, response_metadata: { next_cursor: "page-two" } };
    h.replies.mockImplementation(async (args: any) => { h.histories.push(args); return args.cursor === "page-two" ? secondPage(marker) : firstPage; });
    h.questionStore.put(record);
    return { ...h, req, oldTs };
  }

  it("adopts a page-two marker without reposting, then a same-session resume hydrates current-generation controls", async () => {
    const postedTs = "1791400000.000200";
    const h = setup("pagination", marker => ({ messages: [{ user: "U_BOT", ts: postedTs, text: `OpenCode question\n${marker}` }], has_more: false }));
    const interactions = h.start();
    await settle(interactions.onQuestion(h.req as any, true));
    const adopted = h.questionStore.get(h.req.id)!;
    expect(adopted.askTs).toBe(postedTs);
    expect(adopted.relocation?.thread).toBeUndefined();
    const threadSearches = h.histories.filter(a => a.channel === "C1");
    expect(threadSearches.map(a => a.cursor)).toEqual([undefined, "page-two"]);
    // Searched only from the copy being replaced onward.
    expect(threadSearches.every(a => a.ts === h.rootTs && a.oldest === h.oldTs && a.inclusive)).toBe(true);
    expect(h.posts).toEqual([]);

    h.thread.recovery.bindingGeneration = 2;
    await settle(interactions.resumeQuestions({ threadKey: h.threadKey, sessionId: "ses_1", generation: 2, ownerTs: h.thread.recovery.ownerActivityTs }));
    expect(h.questionStore.get(h.req.id)!.generation).toBe(2);
    expect(await settle(interactions.questions({ threadKey: h.threadKey }))).toMatch(/Pending questions:[\s\S]*frm_1/);
    expect(h.native.formReply).not.toHaveBeenCalled();
    expect(h.native.formCancel).not.toHaveBeenCalled();
    interactions.close();
  });

  it.each([
    ["a missing cursor", () => ({ messages: [], has_more: true })],
    ["an access failure", () => { throw Object.assign(new Error("not_in_channel"), { code: "slack_webapi_platform_error", data: { error: "not_in_channel" } }); }],
  ])("keeps placement uncertain on %s and never reposts", async (_label, page) => {
    const h = setup("incomplete", page);
    const interactions = h.start();
    await settle(interactions.onQuestion(h.req as any, true));
    await settle(interactions.refreshPermissions(true));
    const after = h.questionStore.get(h.req.id)!;
    expect(after.askTs).toBe(h.oldTs);
    expect(after.relocation?.thread?.status).toBe("uncertain");
    expect(h.posts).toEqual([]);
    expect(h.native.formReply).not.toHaveBeenCalled();
    interactions.close();
  });

  it("stops at the page budget with placement still uncertain", async () => {
    const h = setup("budget", () => ({ messages: [], has_more: true, response_metadata: { next_cursor: "page-two" } }));
    const interactions = h.start();
    await settle(interactions.onQuestion(h.req as any, true));
    expect(h.histories.filter(a => a.channel === "C1")).toHaveLength(5);
    expect(h.questionStore.get(h.req.id)!.relocation?.thread?.status).toBe("uncertain");
    expect(h.posts).toEqual([]);
    interactions.close();
  });
});
