import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuestionsStore, type QuestionSnapshot } from "../src/slack/questions-store.js";
import { QuestionUiReconciler, questionPresentationMarker } from "../src/slack/question-ui.js";

let dir: string;
let store: QuestionsStore;
const snapshot = (): QuestionSnapshot => ({ id: "form", sessionId: "session", projectDir: "/project", generation: 1, channel: "C", threadTs: "1",
  req: { id: "form", sessionID: "session", questions: [] }, answers: [], finalized: [], askTs: "2", dmTs: "3", response: "pending",
  ui: { revision: 1, threadApplied: 0, dmApplied: 0 }, updatedAt: Date.now() });
beforeEach(() => {
  vi.useFakeTimers();
  const root = resolve("test/.fixtures/question-ui"); mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, "ui-")); store = new QuestionsStore(join(dir, "questions.json")); store.put(snapshot());
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
function harness() {
  const send = vi.fn(async (_channel: string, _ts: string, build: () => { text: string; blocks: unknown[] } | undefined) => { build(); });
  const deleted: Array<{ channel: string; ts: string }> = [];
  const remove = vi.fn(async (channel: string, ts: string, allowed: () => boolean) => { if (allowed()) deleted.push({ channel, ts }); });
  const errors = vi.fn();
  const ui = new QuestionUiReconciler({ store, dmChannel: () => "DM", eligible: () => true, stopping: () => false,
    render: r => ({ text: r.resolvedText ?? `Revision ${r.ui?.revision}`, blocks: [] }), send, remove, onError: errors });
  return { send, remove, deleted, errors, ui };
}
it("advances a good copy independently and backs off only the failed one", async () => {
  const { send, errors, ui } = harness();
  send.mockImplementationOnce(async () => { throw new Error("transport failure"); });
  await ui.refresh("form");
  expect(store.get("form")?.ui).toEqual({ revision: 1, threadApplied: 0, dmApplied: 1 });
  expect(errors).toHaveBeenCalledOnce();
  await ui.refresh("form"); expect(send).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5_000); await ui.refresh("form");
  expect(store.get("form")?.ui?.threadApplied).toBe(1);
  expect(send).toHaveBeenCalledTimes(3);
});
it("coalesces an in-flight update then finishes on the newest terminal revision", async () => {
  const { send, ui } = harness();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const cards: string[] = [];
  send.mockImplementation(async (channel, _ts, build) => {
    const card = build(); if (card) cards.push(`${channel}:${card.text}`);
    if (channel === "C" && cards.length === 1) await held;
  });
  const first = ui.refresh("form");
  store.update("form", r => { r.ui!.revision++; r.response = "resolved"; r.resolvedText = "Answer confirmed."; });
  const second = ui.refresh("form");
  release(); await Promise.all([first, second]);
  expect(cards.filter(c => c.startsWith("C:")).at(-1)).toBe("C:Answer confirmed.");
  expect(store.get("form")?.ui).toEqual({ revision: 2, threadApplied: 2, dmApplied: 2 });
});
it("builds from current state when a queued update finally runs", async () => {
  const { send, ui } = harness();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const cards: string[] = [];
  send.mockImplementation(async (_channel, _ts, build) => { await held; const card = build(); if (card) cards.push(card.text); });
  const refresh = ui.refresh("form");
  store.update("form", r => { r.ui!.revision = 3; r.response = "resolved"; r.resolvedText = "Skip confirmed."; });
  release(); await refresh;
  expect(cards).toEqual(["Skip confirmed.", "Skip confirmed."]);
});
it("does not apply an old acknowledgment to another thread with an equal generation", async () => {
  const { send, ui } = harness();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  send.mockImplementation(async (channel, _ts, build) => { build(); if (channel === "C") await held; });
  const refresh = ui.refresh("form");
  store.put({ ...snapshot(), channel: "NEW", threadTs: "new-root", askTs: "new-copy", ui: { revision: 1, threadApplied: 0, dmApplied: 0 } });
  release(); await refresh;
  expect(store.get("form")?.ui).toEqual({ revision: 1, threadApplied: 1, dmApplied: 1 });
  expect(send).toHaveBeenCalledWith("NEW", "new-copy", expect.any(Function));
});
it("restores a dirty resolved card without an active native ask", async () => {
  store.put({ ...snapshot(), response: "resolved", resolvedText: "Answer confirmed." });
  store = new QuestionsStore(store.path);
  const { send, ui } = harness(); await ui.refreshAll();
  expect(send).toHaveBeenCalledTimes(2);
  expect(store.get("form")?.ui).toEqual({ revision: 1, threadApplied: 1, dmApplied: 1 });
});
it("silently deletes retired copies without touching a reused current message", async () => {
  store.update("form", r => { r.retiredCopies = [{ channel: "OLD", ts: "old" }, { channel: "C", ts: "2" }]; });
  const { send, deleted, ui } = harness();
  const cards: string[] = [];
  send.mockImplementation(async (_channel, _ts, build) => { const card = build(); if (card) cards.push(card.text); });
  await ui.refresh("form");
  expect(deleted).toEqual([{ channel: "OLD", ts: "old" }]);
  expect(cards).toEqual(["Revision 1", "Revision 1"]);
  expect(store.get("form")?.retiredCopies).toEqual([]);
});

type Card = { text: string; blocks: unknown[] };
function movingSnapshot(): QuestionSnapshot {
  return { ...snapshot(), presentation: 1, threadPresentation: 0, dmPresentation: 0,
    ui: { revision: 2, threadApplied: 1, dmApplied: 1 } };
}
const marker = (epoch: number, destination: "thread" | "dm" = "thread") => questionPresentationMarker({ ...snapshot(), presentation: epoch }, destination);
function movingHarness() {
  const state = { stopping: false, eligible: true };
  const posts: Array<{ channel: string; threadTs: string | undefined; card: Card }> = [];
  const updates: Array<{ channel: string; ts: string; card: Card }> = [];
  const deleted: Array<{ channel: string; ts: string }> = [];
  let serial = 0;
  const post = vi.fn(async (channel: string, threadTs: string | undefined, build: () => Card | undefined) => {
    const card = build();
    if (!card) return;
    posts.push({ channel, threadTs, card });
    return { ts: `new-${channel}-${++serial}` };
  });
  const send = vi.fn(async (channel: string, ts: string, build: () => Card | undefined) => {
    const card = build(); if (card) updates.push({ channel, ts, card });
  });
  const remove = vi.fn(async (channel: string, ts: string, allowed: () => boolean) => {
    if (allowed()) deleted.push({ channel, ts });
  });
  const find = vi.fn(async (_channel: string, _threadTs: string | undefined, _marker: string): Promise<{ ts: string } | undefined> => undefined);
  const errors = vi.fn();
  const adopted = vi.fn();
  const ui = new QuestionUiReconciler({ store, dmChannel: () => "DM", eligible: () => state.eligible, stopping: () => state.stopping,
    render: (r, destination) => ({ text: `${r.resolvedText ?? `Question ${r.presentation ?? 0}, revision ${r.ui?.revision}`}\n${questionPresentationMarker(r, destination)}`,
      blocks: r.response === "pending" ? [{ type: "actions", epoch: r.presentation ?? 0 }] :
        r.response === "uncertain" ? [{ type: "actions", retry: true, epoch: r.presentation ?? 0 }] : [] }),
    post, send, remove, find, rejectedPost: err => String(err).includes("platform rejected"), onAdopt: adopted, onError: errors });
  return { state, posts, updates, deleted, post, send, remove, find, errors, adopted, ui };
}
function deferred() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
}
it("posts a fresh next-step card per destination, adopts before silent old-card deletion", async () => {
  store.put(movingSnapshot());
  const h = movingHarness();
  h.adopted.mockImplementation(r => {
    expect(store.get("form")?.askTs).toBe(r.askTs);
    expect(store.get("form")?.dmTs).toBe(r.dmTs);
  });
  h.post.mockImplementation(async (channel, threadTs, build) => {
    const intent = store.get("form")?.relocation?.[channel === "C" ? "thread" : "dm"];
    expect(intent).toMatchObject({ epoch: 1, oldTs: channel === "C" ? "2" : "3", status: "in-flight", attempts: 1 });
    const card = build();
    expect(card?.text).toContain(`slackoc-question:form:1:card:1:${channel === "C" ? "thread" : "dm"}`);
    h.posts.push({ channel, threadTs, card: card! });
    return { ts: `new-${channel}` };
  });
  h.remove.mockImplementation(async (channel, ts, allowed) => {
    expect(store.get("form")?.[channel === "C" ? "askTs" : "dmTs"]).toBe(`new-${channel}`);
    if (allowed()) h.deleted.push({ channel, ts });
  });
  await h.ui.refresh("form");
  expect(h.posts.map(p => [p.channel, p.threadTs])).toEqual([["C", "1"], ["DM", undefined]]);
  expect(store.get("form")).toMatchObject({ askTs: "new-C", dmTs: "new-DM", threadPresentation: 1, dmPresentation: 1,
    ui: { revision: 2, threadApplied: 2, dmApplied: 2 }, retiredCopies: [], relocation: {} });
  expect(h.adopted).toHaveBeenCalledTimes(2);
  expect(h.deleted).toEqual([{ channel: "C", ts: "2" }, { channel: "DM", ts: "3" }]);
  expect(h.updates).toEqual([]);
});
it("does not make initial posts or move legacy cards merely because UI revisions change", async () => {
  const h = movingHarness();
  await h.ui.refresh("form");
  for (let n = 0; n < 3; n++) {
    store.update("form", r => { r.ui!.revision++; r.answers = [[String(n)]]; r.page = n; });
    await h.ui.refresh("form");
  }
  expect(h.post).not.toHaveBeenCalled();
  expect(h.updates).toHaveLength(8);
  store.put({ ...snapshot(), presentation: 1, askTs: null, dmTs: null });
  await h.ui.refresh("form");
  expect(h.post).not.toHaveBeenCalled();
});
it("updates multi-select toggles and pages in place after a confirmed new presentation", async () => {
  store.put(movingSnapshot());
  const h = movingHarness(); await h.ui.refresh("form");
  const adopted = store.get("form")!;
  for (let n = 0; n < 3; n++) {
    store.update("form", r => { r.answers = [[String(n)]]; r.page = n; r.ui!.revision++; });
    await h.ui.refresh("form");
  }
  expect(h.post).toHaveBeenCalledTimes(2);
  expect(store.get("form")).toMatchObject({ askTs: adopted.askTs, dmTs: adopted.dmTs, presentation: 1,
    threadPresentation: 1, dmPresentation: 1, ui: { revision: 5, threadApplied: 5, dmApplied: 5 } });
  expect(h.updates.slice(-2).map(u => u.ts)).toEqual([adopted.askTs, adopted.dmTs]);
});
it("keeps a failed thread move independent from the adopted DM copy", async () => {
  store.put(movingSnapshot());
  const h = movingHarness();
  h.post.mockImplementation(async (channel, _root, build) => {
    const card = build();
    if (channel === "C") throw new Error("platform rejected");
    expect(card).toBeDefined(); return { ts: "new-DM" };
  });
  await h.ui.refresh("form");
  expect(store.get("form")).toMatchObject({ askTs: "2", dmTs: "new-DM", threadPresentation: 0, dmPresentation: 1,
    relocation: { thread: { status: "rejected", attempts: 1 } } });
  const old = h.updates.find(u => u.channel === "C" && u.ts === "2")!;
  expect(old.card.text).toContain("delivery unconfirmed");
  expect(old.card.blocks.some((b: any) => b.type === "actions")).toBe(false);
  expect(h.errors).toHaveBeenCalledOnce();
});
it("retries a known pre-build rejection without treating it as an ambiguous external post", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  h.post.mockRejectedValueOnce(new Error("queue rejected before building the request"));
  await h.ui.refresh("form");
  expect(store.get("form")?.relocation?.thread).toMatchObject({ status: "rejected", attempts: 1 });
  expect(h.find).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  await h.ui.refresh("form", true);
  expect(store.get("form")?.threadPresentation).toBe(1);
  expect(h.post).toHaveBeenCalledTimes(2);
  expect(h.find).not.toHaveBeenCalled();
});
it("singleflights relocation and catches a later epoch without adopting the obsolete post", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  let calls = 0;
  h.post.mockImplementation(async (channel, root, build) => {
    const card = build(); if (!card) return;
    h.posts.push({ channel, threadTs: root, card });
    if (++calls === 1) await gate.held;
    return { ts: `posted-${calls}` };
  });
  const first = h.ui.refresh("form");
  expect(h.post).toHaveBeenCalledOnce();
  store.update("form", r => { r.presentation = 2; r.ui!.revision = 3; });
  const second = h.ui.refresh("form", true);
  expect(h.post).toHaveBeenCalledOnce();
  gate.release(); await Promise.all([first, second]);
  expect(h.post).toHaveBeenCalledTimes(2);
  expect(h.posts.map(p => p.card.text.split("\n").at(-1))).toEqual([
    marker(1), marker(2)]);
  expect(store.get("form")).toMatchObject({ askTs: "posted-2", threadPresentation: 2 });
  expect(h.adopted).toHaveBeenCalledOnce();
  expect(h.deleted.map(u => u.ts).sort()).toEqual(["2", "posted-1"]);
});
it("rebuilds a queued post from the latest toggles in the same epoch", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { await gate.held; const card = build();
    expect(card?.text).toContain("Question 1, revision 3"); return card ? { ts: "new" } : undefined; });
  const pending = h.ui.refresh("form");
  store.update("form", r => { r.answers = [["selected"]]; r.ui!.revision = 3; });
  gate.release(); await pending;
  expect(store.get("form")).toMatchObject({ askTs: "new", threadPresentation: 1, ui: { threadApplied: 3 }, answers: [["selected"]] });
  expect(h.post).toHaveBeenCalledOnce();
});
it("catches toggles arriving after post build without another post or stale answer overwrite", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { build(); await gate.held; return { ts: "new" }; });
  const pending = h.ui.refresh("form");
  store.update("form", r => { r.answers = [["latest"]]; r.ui!.revision = 3; });
  gate.release(); await pending;
  expect(h.post).toHaveBeenCalledOnce();
  expect(h.updates.find(u => u.ts === "new")?.card.text).toContain("revision 3");
  expect(store.get("form")).toMatchObject({ askTs: "new", answers: [["latest"]], ui: { threadApplied: 3 } });
});
it("cancels a stale queued epoch rather than rendering the newest epoch under its old marker", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  let calls = 0;
  h.post.mockImplementation(async (channel, root, build) => {
    if (++calls === 1) await gate.held;
    const card = build();
    if (!card) return;
    h.posts.push({ channel, threadTs: root, card }); return { ts: "new" };
  });
  const pending = h.ui.refresh("form");
  store.update("form", r => { r.presentation = 2; r.ui!.revision = 3; });
  gate.release(); await pending;
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]!.card.text).toContain("slackoc-question:form:1:card:2:thread");
  expect(store.get("form")?.threadPresentation).toBe(2);
});
it("cancels resolution before a queued build and updates the known copy in place", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { await gate.held; const card = build();
    expect(card).toBeUndefined(); return undefined; });
  const pending = h.ui.refresh("form");
  store.update("form", r => { r.response = "resolved"; r.resolvedText = "Answer confirmed."; r.ui!.revision = 3; });
  gate.release(); await pending;
  expect(h.adopted).not.toHaveBeenCalled();
  expect(store.get("form")).toMatchObject({ askTs: "2", threadPresentation: 0, relocation: {}, ui: { threadApplied: 3 } });
  expect(h.updates[0]?.card.text).toContain("Answer confirmed.");
});
it.each(["answering", "uncertain", "resolved"] as const)("updates %s on the known card instead of posting a pending question", async response => {
  store.put({ ...movingSnapshot(), response });
  const h = movingHarness(); await h.ui.refresh("form");
  expect(h.post).not.toHaveBeenCalled();
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(store.get("form")?.ui?.threadApplied).toBe(2);
});
it("retries failed retirement without losing the adopted timestamp or reposting", async () => {
  store.put({ ...movingSnapshot(), answers: [["private answer"]] });
  const h = movingHarness();
  h.remove.mockImplementationOnce(async (channel, ts, allowed) => {
    expect([channel, ts]).toEqual(["C", "2"]); expect(allowed()).toBe(true); throw new Error("retire unavailable"); });
  await h.ui.refresh("form");
  expect(store.get("form")).toMatchObject({ askTs: "new-C-1", dmTs: "new-DM-2", threadPresentation: 1, retiredCopies: [{ channel: "C", ts: "2" }] });
  expect(h.deleted).toEqual([{ channel: "DM", ts: "3" }]);
  await h.ui.refresh("form");
  expect(h.remove).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(60_000); await h.ui.refresh("form");
  expect(store.get("form")?.retiredCopies).toEqual([]);
  expect(h.post).toHaveBeenCalledTimes(2);
});
it.each(["thread", "dm"] as const)("rechecks a queued %s deletion when its timestamp becomes current", async destination => {
  const channel = destination === "thread" ? "C" : "DM";
  store.put({ ...snapshot(), ui: { revision: 1, threadApplied: 1, dmApplied: 1 }, retiredCopies: [{ channel, ts: "old" }] });
  const h = movingHarness();
  const gate = deferred();
  const queued = deferred();
  h.remove.mockImplementation(async (queuedChannel, ts, allowed) => {
    queued.release();
    await gate.held;
    if (allowed()) h.deleted.push({ channel: queuedChannel, ts });
  });
  const pending = h.ui.refresh("form");
  await queued.held;
  expect(h.remove).toHaveBeenCalledOnce();
  store.update("form", r => { r[destination === "thread" ? "askTs" : "dmTs"] = "old"; });
  gate.release(); await pending;
  expect(h.deleted).toEqual([]);
  expect(store.get("form")?.retiredCopies).toEqual([]);
});
it("never reposts a response-lost card without positive exact-epoch evidence", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  h.post.mockImplementationOnce(async (_channel, _root, build) => { build(); throw new Error("response lost"); });
  await h.ui.refresh("form");
  expect(store.get("form")?.relocation?.thread).toMatchObject({ status: "uncertain", attempts: 1, revision: 2 });
  await h.ui.refresh("form", true); await h.ui.refresh("form", true);
  expect(h.post).toHaveBeenCalledOnce();
  expect(h.find).toHaveBeenLastCalledWith("C", "1", marker(1));
  expect(store.get("form")?.askTs).toBe("2");
  expect(h.updates.every(u => u.card.blocks.every((b: any) => b.type !== "actions"))).toBe(true);
  h.find.mockResolvedValueOnce({ ts: "found" });
  await h.ui.refresh("form", true);
  expect(store.get("form")).toMatchObject({ askTs: "found", threadPresentation: 1, relocation: {}, retiredCopies: [] });
  expect(h.adopted).toHaveBeenCalledOnce();
  expect(h.post).toHaveBeenCalledOnce();
});
it("treats a built post with a missing timestamp as uncertain, not a rejection", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  h.post.mockImplementationOnce(async (_channel, _root, build) => { build(); return undefined; });
  await h.ui.refresh("form"); await h.ui.refresh("form", true);
  expect(store.get("form")?.relocation?.thread?.status).toBe("uncertain");
  expect(h.post).toHaveBeenCalledOnce();
});
it("bounds explicit rejections at three with persisted cooldown even for forced refresh", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  h.post.mockImplementation(async (_channel, _root, build) => { build(); throw new Error("platform rejected"); });
  await h.ui.refresh("form"); await h.ui.refresh("form", true);
  expect(h.post).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(5_000); await h.ui.refresh("form", true);
  expect(h.post).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10_000); await h.ui.refresh("form", true);
  vi.advanceTimersByTime(60_000); await h.ui.refresh("form", true);
  expect(h.post).toHaveBeenCalledTimes(3);
  expect(store.get("form")?.relocation?.thread).toMatchObject({ status: "rejected", attempts: 3 });
  expect(h.find).not.toHaveBeenCalled();
  expect(h.updates.every(u => u.card.text.includes("delivery unconfirmed"))).toBe(true);
});
it("reconciles an interrupted post after restart and adopts only its exact epoch", async () => {
  store.put({ ...movingSnapshot(), dmTs: null, relocation: { thread: { epoch: 1, oldTs: "2", status: "in-flight", attempts: 1, revision: 2 } } });
  store = new QuestionsStore(store.path);
  const h = movingHarness(); h.find.mockResolvedValue({ ts: "recovered" });
  await h.ui.refreshAll();
  expect(h.post).not.toHaveBeenCalled();
  expect(h.find).toHaveBeenCalledWith("C", "1", marker(1));
  expect(store.get("form")).toMatchObject({ askTs: "recovered", threadPresentation: 1, ui: { threadApplied: 2 } });
});
it("cleans up exact old-epoch evidence after restart before posting the newer step", async () => {
  store.put({ ...movingSnapshot(), dmTs: null, presentation: 2, ui: { revision: 3, threadApplied: 1, dmApplied: 1 },
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1, revision: 2 } } });
  store = new QuestionsStore(store.path);
  const h = movingHarness(); h.find.mockResolvedValue({ ts: "old-epoch" });
  await h.ui.refresh("form");
  expect(h.find).toHaveBeenCalledWith("C", "1", marker(1));
  expect(h.posts[0]?.card.text).toContain("slackoc-question:form:1:card:2:thread");
  expect(h.adopted).toHaveBeenCalledOnce();
  expect(h.deleted.map(u => u.ts).sort()).toEqual(["2", "old-epoch"]);
});
it("retires a confirmed late post after resolution without recreating live authority", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { build(); await gate.held; return { ts: "late" }; });
  const pending = h.ui.refresh("form");
  store.update("form", r => { r.response = "resolved"; r.resolvedText = "Answer confirmed."; r.ui!.revision = 3; });
  gate.release(); await pending;
  expect(h.adopted).not.toHaveBeenCalled();
  expect(store.get("form")).toMatchObject({ askTs: "2", threadPresentation: 0, response: "resolved", relocation: {}, retiredCopies: [] });
  expect(h.deleted).toContainEqual({ channel: "C", ts: "late" });
  expect(h.updates.find(u => u.ts === "2")?.card.text).toContain("Answer confirmed.");
});
it("keeps a confirmed post for cleanup when shutdown starts during HTTP", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { build(); await gate.held; return { ts: "late" }; });
  const pending = h.ui.refresh("form"); h.state.stopping = true;
  gate.release(); await pending;
  expect(h.adopted).not.toHaveBeenCalled();
  expect(h.updates).toEqual([]);
  expect(h.deleted).toEqual([]);
  expect(store.get("form")).toMatchObject({ askTs: "2", retiredCopies: [{ channel: "C", ts: "late" }] });
  store = new QuestionsStore(store.path);
  const restarted = movingHarness(); await restarted.ui.refresh("form");
  expect(restarted.deleted).toContainEqual({ channel: "C", ts: "late" });
});
it("never adopts a late post into another binding with the same generation", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { build(); await gate.held; return { ts: "late" }; });
  const pending = h.ui.refresh("form");
  store.put({ ...snapshot(), dmTs: null, channel: "NEW", threadTs: "new-root", askTs: "new-copy" });
  gate.release(); await pending;
  expect(h.adopted).not.toHaveBeenCalled();
  expect(store.get("form")).toMatchObject({ channel: "NEW", askTs: "new-copy", threadPresentation: 0, relocation: {}, retiredCopies: [] });
  expect(h.deleted).toContainEqual({ channel: "C", ts: "late" });
  expect(h.updates.find(u => u.channel === "NEW")?.ts).toBe("new-copy");
});
it("retains ambiguous old-binding intent and recovers it even when the current binding is ineligible", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  const gate = deferred();
  h.post.mockImplementation(async (_channel, _root, build) => { build(); await gate.held; throw new Error("response lost"); });
  const pending = h.ui.refresh("form");
  store.put({ ...snapshot(), dmTs: null, channel: "NEW", threadTs: "root", askTs: "new-copy", generation: 2 });
  h.state.eligible = false; gate.release(); await pending;
  expect(store.get("form")?.relocation?.thread).toMatchObject({ generation: 1, channel: "C", threadTs: "1", status: "uncertain" });
  store = new QuestionsStore(store.path);
  const restarted = movingHarness(); restarted.state.eligible = false; restarted.find.mockResolvedValue({ ts: "old-binding-post" });
  await restarted.ui.refreshAll();
  expect(restarted.find).toHaveBeenCalledWith("C", "1", marker(1));
  expect(restarted.post).not.toHaveBeenCalled();
  expect(restarted.adopted).not.toHaveBeenCalled();
  expect(restarted.deleted).toContainEqual({ channel: "C", ts: "old-binding-post" });
  expect(store.get("form")?.askTs).toBe("new-copy");
});
it("continues terminal-card updates while uncertain evidence is still missing", async () => {
  store.put({ ...movingSnapshot(), dmTs: null, response: "resolved", resolvedText: "Expired.",
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1 } } });
  const h = movingHarness(); await h.ui.refresh("form");
  expect(h.post).not.toHaveBeenCalled();
  expect(h.find).toHaveBeenCalledOnce();
  expect(h.updates[0]?.card.text).toContain("Expired.");
  expect(h.updates[0]?.card.text).toContain(marker(0));
  expect(h.updates[0]?.card.text).not.toContain(marker(1));
  expect(store.get("form")?.relocation?.thread?.status).toBe("uncertain");
});
it("keeps native retry controls current while the placement marker identifies the older known copy", async () => {
  store.put({ ...movingSnapshot(), dmTs: null, response: "uncertain",
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1 } } });
  const h = movingHarness(); await h.ui.refresh("form");
  expect(h.updates[0]?.card.blocks).toEqual([{ type: "actions", retry: true, epoch: 1 }]);
  expect(h.updates[0]?.card.text).toContain(marker(0));
  expect(h.updates[0]?.card.text).not.toContain(marker(1));
  expect(store.get("form")?.response).toBe("uncertain");
});
it("does not accept the original timestamp as evidence of a replacement", async () => {
  store.put({ ...movingSnapshot(), dmTs: null, response: "resolved", resolvedText: "Expired.",
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1 } } });
  const h = movingHarness(); h.find.mockResolvedValue({ ts: "2" });
  await h.ui.refresh("form");
  expect(store.get("form")?.relocation?.thread?.status).toBe("uncertain");
  expect(h.post).not.toHaveBeenCalled();
  expect(h.adopted).not.toHaveBeenCalled();
  expect(h.errors.mock.calls[0]?.[0]).toContain("old copy");
});
it("scopes replacement markers to the full binding even when generation and DM destination match", () => {
  const old = movingSnapshot();
  const rebound = { ...old, channel: "OTHER", threadTs: "other-root" };
  expect(questionPresentationMarker(old, "dm")).not.toBe(questionPresentationMarker(rebound, "dm"));
  expect(questionPresentationMarker(snapshot(), "thread")).toContain(":card:0:thread:");
});
it("finishes terminal updates when resolution arrives during a queued uncertainty notice", async () => {
  store.put({ ...movingSnapshot(), dmTs: null,
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1 } } });
  const h = movingHarness();
  const gate = deferred();
  h.send.mockImplementationOnce(async (_channel, _ts, build) => { await gate.held; expect(build()).toBeUndefined(); });
  const pending = h.ui.refresh("form");
  await Promise.resolve(); await Promise.resolve();
  store.update("form", r => { r.response = "resolved"; r.resolvedText = "Expired."; r.ui!.revision = 3; });
  gate.release(); await pending;
  expect(h.updates.at(-1)?.card.text).toContain("Expired.");
  expect(store.get("form")?.ui?.threadApplied).toBe(3);
  expect(h.post).not.toHaveBeenCalled();
});
it("fails visibly at the cleanup bound without discarding identities or posting", async () => {
  const copies = Array.from({ length: 32 }, (_, n) => ({ channel: "OLD", ts: String(n) }));
  store.put({ ...movingSnapshot(), dmTs: null, retiredCopies: copies });
  const h = movingHarness(); h.send.mockRejectedValue(new Error("cleanup unavailable"));
  h.remove.mockRejectedValue(new Error("cleanup unavailable"));
  await h.ui.refresh("form");
  expect(h.post).not.toHaveBeenCalled();
  expect(store.get("form")?.retiredCopies).toEqual(copies);
  expect(h.errors.mock.calls.some(c => c[0].includes("cleanup full"))).toBe(true);
});
it("retains confirmed identity in intent if concurrent cleanup fills the last reserved slot", async () => {
  store.put({ ...movingSnapshot(), dmTs: null });
  const h = movingHarness();
  h.post.mockImplementation(async (_channel, _root, build) => {
    build(); store.update("form", r => { r.retiredCopies = Array.from({ length: 32 }, (_, n) => ({ channel: "OLD", ts: String(n) })); });
    return { ts: "confirmed" };
  });
  h.send.mockRejectedValue(new Error("cleanup unavailable"));
  h.remove.mockRejectedValue(new Error("cleanup unavailable"));
  await h.ui.refresh("form");
  expect(store.get("form")?.relocation?.thread).toMatchObject({ postedTs: "confirmed", status: "uncertain" });
  expect(store.get("form")?.askTs).toBe("2");
  store.update("form", r => { r.retiredCopies = []; });
  h.send.mockImplementation(async (_channel, _ts, build) => { build(); });
  await h.ui.refresh("form", true);
  expect(store.get("form")).toMatchObject({ askTs: "confirmed", threadPresentation: 1 });
  expect(h.post).toHaveBeenCalledOnce();
  expect(h.find).not.toHaveBeenCalled();
});
