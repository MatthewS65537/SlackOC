import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { SessionView, deleteView, paragraphCut, setProjectConnectionState, type RenderDeps } from "../src/slack/render.js";
import { StateStore } from "../src/state.js";
import type { OCClient, OcEvent } from "../src/opencode/api.js";
import * as logModule from "../src/log.js";

const partial = (id: string, value: string): OcEvent =>
  ({ type: "message.part.updated", properties: { part: { id, messageID: "m1", type: "text", text: value } } });
const ended = (id: string, value: string): OcEvent =>
  ({ type: "message.part.updated", properties: { part: { id, messageID: "m1", type: "text", text: value, time: { end: 1 } } } });

let seq = 0;
const views: SessionView[] = [];
function fixture(opts: { stream?: boolean } = {}) {
  const id = `stream-${++seq}`;
  const posts: Array<{ ts: string; text: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  let postSeq = 0;
  const deps: RenderDeps = {
    post: vi.fn(async (_c, _t, text) => { const ts = `ts-${++postSeq}`; posts.push({ ts, text }); return { ts }; }),
    update: vi.fn(async (_c, ts, text) => { updates.push({ ts, text }); }),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}), unreact: vi.fn(async () => {}), upload: vi.fn(async () => {}), dm: vi.fn(async () => ({ ts: "dm" })),
  };
  const client: { session: Record<string, ReturnType<typeof vi.fn>> } = { session: { get: vi.fn(async () => ({ data: { id } })), messages: vi.fn(async () => ({ data: [] })), status: vi.fn(async () => ({ data: {} })) } };
  const directory = `${import.meta.dirname}/.fixtures/render-stream/${id}`;
  rmSync(directory, { recursive: true, force: true });
  const state = new StateStore(`${directory}/state.json`);
  const threadState = { sessionId: id, projectDir: "/render-stream", verbose: "on" as const, createdAt: 1, lastUsedAt: 1, ...(opts.stream === false ? { stream: false } : {}) };
  state.setThread("C:T", threadState);
  const v = new SessionView({ sessionId: id, projectDir: "/render-stream", channel: "C", threadTs: "T", threadKey: "C:T",
    client: client as unknown as OCClient, deps, state, threadState });
  views.push(v);
  const answerPosts = () => posts.filter(p => /Para|Final/.test(p.text));
  return { v, deps, client, posts, updates, answerPosts };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(logModule, "logErr").mockImplementation(() => {});
  setProjectConnectionState("/render-stream", "connected");
});
afterEach(() => {
  for (const v of views.splice(0)) deleteView(v.sessionId);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => rmSync(`${import.meta.dirname}/.fixtures/render-stream`, { recursive: true, force: true }));

describe("paragraph streaming", () => {
  it("posts a paragraph once the next one begins, never editing", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Para one"));
    expect(f.answerPosts()).toHaveLength(0); // still being written
    await f.v.handle(partial("p1", "Para one\n\nPara tw"));
    expect(f.answerPosts()).toHaveLength(1);
    expect(f.answerPosts()[0]!.text).toMatch(/Para one$/);
    await f.v.handle(ended("p1", "Para one\n\nPara two. Final"));
    expect(f.answerPosts().map(p => p.text.replace(/^[\s\S]*\n\n/, ""))).toEqual(["Para one", "Para two. Final"]);
    expect(f.updates.filter(u => /Para/.test(u.text))).toHaveLength(0);
  });

  it("posts several finished paragraphs together as one message", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Para one\n\nPara two\n\nPara thr"));
    expect(f.answerPosts()).toHaveLength(1);
    expect(f.answerPosts()[0]!.text).toMatch(/Para one\n\nPara two$/);
  });

  it("never splits inside an open code fence", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Para intro\n\n```\nline one\n\nline two"));
    expect(f.answerPosts()).toHaveLength(1);
    expect(f.answerPosts()[0]!.text).toMatch(/Para intro$/);
    await f.v.handle(ended("p1", "Para intro\n\n```\nline one\n\nline two\n```\nFinal"));
    expect(f.answerPosts()).toHaveLength(2);
    expect(f.answerPosts()[1]!.text).toMatch(/line one\n\nline two[\s\S]*Final/);
  });

  it("\\stream off posts each part once, when it completes", async () => {
    const f = fixture({ stream: false });
    await f.v.handle(partial("p1", "Para one\n\nPara two"));
    expect(f.answerPosts()).toHaveLength(0);
    await f.v.handle(ended("p1", "Para one\n\nPara two. Final"));
    expect(f.answerPosts()).toHaveLength(1);
  });

  it("finalize posts only the tail of a streamed part whose end never arrived", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Para one\n\nPara t"));
    f.client.session.messages!.mockResolvedValue({ data: [{ info: { id: "m1", role: "assistant", time: { created: Date.now() } },
      parts: [{ id: "p1", messageID: "m1", type: "text", text: "Para one\n\nPara two. Final" }] }] });
    await f.v.finalize();
    const texts = f.answerPosts().map(p => p.text.replace(/^[\s\S]*\n\n/, ""));
    expect(texts[0]).toBe("Para one");
    expect(texts.at(-1)).toBe("Para two. Final");
    expect(texts.filter(t => /Para one/.test(t))).toHaveLength(1);
  });

  it("paragraphCut finds the last blank line outside fences", () => {
    expect(paragraphCut("no break yet")).toBe(0);
    expect(paragraphCut("a\n\nb")).toBe(3);
    expect(paragraphCut("a\n\nb\n\nc")).toBe(6);
    expect(paragraphCut("a\n\n```\nx\n\ny")).toBe(3);
    expect(paragraphCut("a\n\n```\nx\n\ny\n```\n\nz")).toBe("a\n\n```\nx\n\ny\n```\n\n".length);
  });
});
