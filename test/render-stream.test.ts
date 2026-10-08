import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { SessionView, closeOpenFences, deleteView, setProjectConnectionState, type RenderDeps } from "../src/slack/render.js";
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
  const client = { session: { get: vi.fn(async () => ({ data: { id } })), messages: vi.fn(async () => ({ data: [] })), status: vi.fn(async () => ({ data: {} })) } };
  const directory = `${import.meta.dirname}/.fixtures/render-stream/${id}`;
  rmSync(directory, { recursive: true, force: true });
  const state = new StateStore(`${directory}/state.json`);
  const threadState = { sessionId: id, projectDir: "/render-stream", verbose: "on" as const, createdAt: 1, lastUsedAt: 1, ...(opts.stream === false ? { stream: false } : {}) };
  state.setThread("C:T", threadState);
  const v = new SessionView({ sessionId: id, projectDir: "/render-stream", channel: "C", threadTs: "T", threadKey: "C:T",
    client: client as unknown as OCClient, deps, state, threadState });
  views.push(v);
  const answerPosts = () => posts.filter(p => /Hello|x{10}|Final/.test(p.text));
  return { v, deps, posts, updates, answerPosts };
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

describe("live answer streaming", () => {
  it("posts the first partial at once, edits it in place, and finishes without a second post", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Hello"));
    expect(f.answerPosts()).toHaveLength(1);
    expect(f.answerPosts()[0]!.text).toMatch(/Hello$/);
    const prefix = f.answerPosts()[0]!.text.slice(0, -"Hello".length);
    const ts = f.answerPosts()[0]!.ts;
    await f.v.handle(partial("p1", "Hello wor"));
    await f.v.handle(partial("p1", "Hello world"));
    expect(f.updates.filter(u => u.ts === ts)).toHaveLength(0); // coalesced, not yet due
    await vi.advanceTimersByTimeAsync(SessionView.STREAM_UPDATE_MS);
    const edits = f.updates.filter(u => u.ts === ts);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe(`${prefix}Hello world`); // any section divider is kept on edits
    await f.v.handle(ended("p1", "Hello world!"));
    expect(f.updates.filter(u => u.ts === ts).at(-1)!.text).toMatch(/Hello world!$/);
    expect(f.answerPosts()).toHaveLength(1);
  });

  it("keeps the response divider on edits after tool output", async () => {
    const f = fixture();
    await f.v.handle({ type: "message.part.updated", properties: { part: { id: "t1", callID: "t1", type: "tool", tool: "bash", state: { status: "running", input: { command: "ls" } } } } });
    await f.v.handle(partial("p1", "Hello"));
    const first = f.answerPosts()[0]!;
    expect(first.text).toMatch(/response/);
    await f.v.handle(ended("p1", "Hello world"));
    expect(f.updates.find(u => u.ts === first.ts)!.text).toMatch(/response[\s\S]*Hello world$/);
  });

  it("does not edit when the final text equals what is already shown", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Hello"));
    await f.v.handle(ended("p1", "Hello"));
    expect(f.updates.filter(u => u.ts === f.answerPosts()[0]!.ts)).toHaveLength(0);
    expect(f.answerPosts()).toHaveLength(1);
  });

  it("splits a long streamed answer into continuation messages", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "x".repeat(100)));
    const long = `${"x".repeat(3000)}\n${"x".repeat(3000)}`;
    await f.v.handle(ended("p1", long));
    expect(f.answerPosts().length).toBe(2);
    const shown = [f.updates.find(u => u.ts === f.answerPosts()[0]!.ts)?.text ?? "", f.answerPosts()[1]!.text].join("");
    expect(shown.replace(/[^x]/g, "").length).toBe(6000);
  });

  it("falls back to a fresh full post (removing the stale partial) when edits fail", async () => {
    const f = fixture();
    await f.v.handle(partial("p1", "Hello"));
    const ts = f.answerPosts()[0]!.ts;
    vi.mocked(f.deps.update).mockRejectedValue(new Error("cant_update_message"));
    await f.v.handle(partial("p1", "Hello there"));
    await vi.advanceTimersByTimeAsync(SessionView.STREAM_UPDATE_MS);
    await f.v.handle(ended("p1", "Hello there, Final"));
    expect(f.deps.delete).toHaveBeenCalledWith("C", ts);
    expect(f.answerPosts().at(-1)!.text).toMatch(/Hello there, Final$/);
  });

  it("\\stream off keeps the old behaviour: nothing posts until the part completes", async () => {
    const f = fixture({ stream: false });
    await f.v.handle(partial("p1", "Hello"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.answerPosts()).toHaveLength(0);
    await f.v.handle(ended("p1", "Hello world"));
    expect(f.answerPosts()).toHaveLength(1);
  });

  it("closes an unterminated code fence in partial renders only", () => {
    expect(closeOpenFences("a\n```ts\nconst x")).toBe("a\n```ts\nconst x\n```");
    expect(closeOpenFences("a\n```ts\nx\n```")).toBe("a\n```ts\nx\n```");
  });
});
