import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionView, deleteView, getView, setProjectConnectionState, type RenderDeps } from "../src/slack/render.js";
import { formatTool } from "../src/slack/tool-format.js";
import { StateStore } from "../src/state.js";
import type { OCClient, OcEvent, OcMessageInfo, OcPart } from "../src/opencode/api.js";
import * as logModule from "../src/log.js";

type Message = { info: OcMessageInfo & { finish?: string }; parts: OcPart[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function tool(id: string, status = "running", overrides: Partial<OcPart> = {}): OcEvent {
  return { type: "message.part.updated", properties: { part: {
    id, callID: id, type: "tool", tool: "bash", state: { status, input: { command: `run ${id}` } }, ...overrides,
  } } };
}
function text(id: string, value = id): OcEvent {
  return { type: "message.part.updated", properties: { part: { id, type: "text", text: value, time: { end: 1 } } } };
}

let seq = 0;
const views: SessionView[] = [];
function fixture(verbose: "on" | "off" | "full" = "on") {
  const id = `reliability-${++seq}`;
  const posted: string[] = [];
  let postSeq = 0;
  const deps: RenderDeps = {
    post: vi.fn(async (_c, _t, value) => { posted.push(value); return { ts: `ts-${++postSeq}` }; }),
    update: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}), unreact: vi.fn(async () => {}), upload: vi.fn(async () => {}), dm: vi.fn(async () => ({ ts: "dm" })),
  };
  let messages: Message[] = [];
  let status: string | undefined = "idle";
  const client = { session: {
    get: vi.fn(async (): Promise<{ data: unknown }> => ({ data: { id } })),
    messages: vi.fn(async () => ({ data: messages })),
    status: vi.fn(async (): Promise<{ data: unknown }> => ({ data: status ? { [id]: status === "retry"
      ? { type: "retry", attempt: 1, message: "retrying", next: Date.now() + 1_000 }
      : { type: status } } : {} })),
  } };
  const state = new StateStore(`${import.meta.dirname}/.fixtures/render-reliability/${id}/state.json`);
  const v = new SessionView({ sessionId: id, projectDir: "/renderer-reliability", channel: "C", threadTs: "T", threadKey: "C:T", client: client as unknown as OCClient, deps, state,
    threadState: { sessionId: id, projectDir: "/renderer-reliability", verbose, createdAt: 1, lastUsedAt: 1 } });
  views.push(v);
  return { v, deps, client, state, posted,
    messages: (m: Message[]) => { messages = m; }, status: (s?: string) => { status = s; },
    done: (parts: OcPart[] = []): Message => ({ info: { id: "assistant", sessionID: id, role: "assistant", time: { created: Date.now(), completed: Date.now() + 1 } }, parts }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  vi.spyOn(logModule, "logErr").mockImplementation(() => {});
  setProjectConnectionState("/renderer-reliability", "connected");
});
afterEach(() => {
  for (const v of views.splice(0)) deleteView(v.sessionId);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("timed tool delivery", () => {
  it("flushes a slow call at 1.5s from the FIRST item, without sliding on new calls", async () => {
    const f = fixture();
    await f.v.handle(tool("one"));
    await vi.advanceTimersByTimeAsync(1_000);
    await f.v.handle(tool("two"));
    await vi.advanceTimersByTimeAsync(499);
    expect(f.posted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.posted).toEqual(["⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 `run one`\n🔧 `run two`"]);
  });

  it("serializes a due timer behind a blocked answer and ahead of later content", async () => {
    const f = fixture();
    const gate = deferred<{ ts: string }>();
    vi.mocked(f.deps.post).mockImplementationOnce(async (_c, _t, value) => { f.posted.push(value); return gate.promise; });
    await f.v.handle(tool("first"));
    const answer = f.v.handle(text("answer")); // flushes tool batch, blocked by Slack
    await vi.advanceTimersByTimeAsync(0);
    const nextTool = f.v.handle(tool("next"));
    await vi.advanceTimersByTimeAsync(1_500);
    const last = f.v.handle(text("last"));
    expect(f.posted).toHaveLength(1);
    gate.resolve({ ts: "blocked" });
    await Promise.all([answer, nextTool, last]);
    expect(f.posted).toEqual([
      "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 `run first`", "⎯⎯⎯ response ⎯⎯⎯\n\nanswer",
      "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 `run next`", "⎯⎯⎯ response ⎯⎯⎯\n\nlast",
    ]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.posted).toHaveLength(4);
  });

  it("a timer's in-flight batch cannot be overtaken by a response", async () => {
    const f = fixture();
    const gate = deferred<{ ts: string }>();
    vi.mocked(f.deps.post).mockImplementationOnce(async (_c, _t, value) => { f.posted.push(value); return gate.promise; });
    await f.v.handle(tool("slow"));
    await vi.advanceTimersByTimeAsync(1_500);
    const response = f.v.handle(text("answer"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.posted).toHaveLength(1);
    gate.resolve({ ts: "tools" });
    await response;
    expect(f.posted[1]).toContain("response ⎯⎯⎯\n\nanswer");
  });

  it("silent mode cancels buffered tools, and finalization flushes before pending text", async () => {
    const f = fixture();
    await f.v.handle(tool("discard"));
    f.v.setVerbose("off");
    await vi.advanceTimersByTimeAsync(2_000);
    f.v.setVerbose("on");
    await f.v.handle(tool("keep"));
    await f.v.handle({ type: "message.part.updated", properties: { part: { id: "pending", type: "text", text: "unfinished" } } });
    await f.v.finalize();
    expect(f.posted[0]).toContain("run keep");
    expect(f.posted[1]).toContain("unfinished");
    expect(f.posted.join("\n")).not.toContain("discard");
    const count = f.posted.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.posted).toHaveLength(count);
  });

  it("retains the 2KB pressure flush after Slack escaping expands payloads", async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) {
      await f.v.handle(tool(`large-${i}`, "running", { tool: "read", state: { status: "running", input: { filePath: "&".repeat(70) } } }));
    }
    expect(f.posted).toHaveLength(1); // fewer than the eight-call threshold
    expect(f.posted[0]!.length).toBeGreaterThan(2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.posted).toHaveLength(1);
  });

  it("timer post errors log and finalize with failure rather than hang", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    vi.mocked(f.deps.post).mockRejectedValueOnce(new Error("batch failed"));
    await f.v.handle(tool("slow"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(logModule.logErr).toHaveBeenCalledWith(expect.stringContaining("tool batch failed"));
    expect(f.deps.react).toHaveBeenCalledWith("C", "user", "x");
    expect(getView(f.v.sessionId)).toBeUndefined();
  });

  it("terminal-only calls get starts and full output exactly once, including uploads", async () => {
    const f = fixture("full");
    const event = tool("only", "completed", { state: { status: "completed", input: { command: "long" }, output: "x".repeat(500) } });
    await f.v.handle(event);
    await f.v.handle(event);
    await f.v.handle(tool("only")); // out-of-order old running event
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.posted.filter((p) => p.includes("tools ⎯⎯⎯"))).toHaveLength(1);
    expect(f.deps.upload).toHaveBeenCalledTimes(1);
    expect((f.v as unknown as { toolCalls: number }).toolCalls).toBe(1);
  });

  it("terminal errors remain visible in silent mode and are deduplicated", async () => {
    const f = fixture("off");
    const event = tool("error", "error", { state: { status: "error", input: { command: "test" }, error: "<!channel> ```bad```" } });
    await f.v.handle(event);
    await f.v.handle(event);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toContain("failed: &lt;!channel&gt;");
    expect(f.posted[0]).not.toMatch(/```|⎯⎯⎯/);
  });

  it("full inline output cannot close its code fence or inject a Slack mention", async () => {
    const f = fixture("full");
    await f.v.handle(tool("inline", "completed", { state: { status: "completed", output: "```\n<!here> <@U123> & stuff\n`foo_bar.ts` *.ts ~/src" } }));
    const output = f.posted.at(-1)!;
    expect(output.match(/```/g)).toHaveLength(2);
    expect(output).toContain("&lt;!here&gt; &lt;@U123&gt; &amp; stuff");
    expect(output).toContain("`foo_bar.ts` *.ts ~/src");
  });
});

describe("status reliability and lifetime", () => {
  it("backs off failed sinks 2/4/8/16/30 seconds and resets after success", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    const attempts: number[] = [];
    const base = f.deps.post;
    let failing = true;
    f.deps.post = vi.fn(async (...args: Parameters<RenderDeps["post"]>) => {
      attempts.push(Date.now());
      if (failing) throw new Error("offline");
      return base(...args);
    });
    const start = Date.now();
    f.v.contentPosted();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000]) {
      const before = attempts.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      f.v.contentPosted();
      expect(attempts).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(before + 1);
    }
    expect(attempts.map((t) => t - start)).toEqual([0, 2_000, 6_000, 14_000, 30_000, 60_000]);
    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    failing = true;
    f.v.contentPosted();
    await vi.advanceTimersByTimeAsync(0);
    const before = attempts.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toHaveLength(before + 1);
  });

  it("recreates only a definitively deleted current status, not a network failure", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    vi.mocked(f.deps.update).mockRejectedValueOnce(new Error("message_not_found in network text"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.posted).toHaveLength(1);
    vi.mocked(f.deps.update).mockRejectedValueOnce({ data: { error: "message_not_found" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.posted).toHaveLength(2);
    expect(f.deps.delete).not.toHaveBeenCalled(); // already deleted, not an old live bar
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.posted).toHaveLength(2);
  });

  it("a late missing-message error for an OLD bar cannot erase a newly adopted bar", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    const update = deferred<void>();
    vi.mocked(f.deps.update).mockReturnValueOnce(update.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    f.v.contentPosted();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.posted).toHaveLength(2);
    update.reject({ data: { error: "message_not_found" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.posted).toHaveLength(2);
    expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-2", expect.any(String));
  });

  it("logs cleanup failures, and still adopts the new bar without retrying posts", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    vi.mocked(f.deps.delete).mockRejectedValue(new Error("cannot delete"));
    f.v.contentPosted();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.posted).toHaveLength(2);
    expect(logModule.logErr).toHaveBeenCalledWith(expect.stringContaining("status cleanup failed"));
    expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-2", expect.any(String));
    await f.v.finalize();
    expect(getView(f.v.sessionId)).toBeUndefined();
  });

  it("deleteView disposes all timers, queued events, and a late sink", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    await f.v.handle(tool("buffered"));
    const gate = deferred<{ ts: string }>();
    vi.mocked(f.deps.post).mockReturnValueOnce(gate.promise);
    f.v.contentPosted();
    const queued = f.v.handle(text("too late"));
    deleteView(f.v.sessionId);
    await queued;
    gate.resolve({ ts: "late-sink" });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(f.posted).toHaveLength(1);
    expect(f.deps.update).not.toHaveBeenCalled();
    expect(f.deps.dm).not.toHaveBeenCalled();
    expect(f.deps.delete).toHaveBeenCalledWith("C", "late-sink");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a delayed initial acknowledgement is cleaned up after disposal", async () => {
    const f = fixture();
    const gate = deferred<{ ts: string }>();
    vi.mocked(f.deps.post).mockReturnValueOnce(gate.promise);
    const start = f.v.beginPrompt("user");
    deleteView(f.v.sessionId);
    gate.resolve({ ts: "late-ack" });
    await start;
    expect(f.deps.delete).toHaveBeenCalledWith("C", "late-ack");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deleteView cancels watch polling and rejects a snapshot already in flight", async () => {
    const f = fixture();
    const gate = deferred<{ data: Message[] }>();
    f.client.session.messages.mockReturnValueOnce(gate.promise);
    await f.v.attach();
    deleteView(f.v.sessionId);
    gate.resolve({ data: [f.done([{ id: "late", type: "text", text: "late watch answer", time: { end: 1 } }])] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.client.session.messages).toHaveBeenCalledTimes(1);
    expect(f.posted).toHaveLength(1); // watching acknowledgement only
    expect(vi.getTimerCount()).toBe(0);
  });

  it("independent asks keep waiting state, suppress stalls, and resolve by kind and ID", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    f.v.setWaiting("same", "question", true);
    f.v.setWaiting("second", "question", true);
    f.v.setWaiting("same", "permission", true);
    f.v.setWaiting("same", "question", false);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-1", expect.stringContaining("your answer and permission"));
    expect(f.deps.dm).not.toHaveBeenCalled();
    f.v.setWaiting("second", "question", false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-1", expect.stringContaining("Waiting for permission"));
    await f.v.handle({ type: "session.idle" });
    expect(f.v.isActive).toBe(true);
    f.v.setWaiting("same", "permission", false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-1", expect.not.stringContaining("Waiting"));
  });

  it("canonical project connection states are rendered without stall paging", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    for (const [state, label] of [["connecting", "Connecting"], ["reconnecting", "Reconnecting"], ["disconnected", "Disconnected"]] as const) {
      setProjectConnectionState("/renderer-reliability/../renderer-reliability/", state);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-1", expect.stringContaining(label));
    }
    expect(f.deps.dm).not.toHaveBeenCalled();
    setProjectConnectionState("/renderer-reliability", "connected");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.deps.update).toHaveBeenLastCalledWith("C", "ts-1", expect.stringContaining("starting"));
    expect(f.posted.join("\n")).not.toContain(":hourglass");
  });
});

describe("conservative completion reconciliation", () => {
  it.each(["busy", "retry"])("does not finalize for status %s", async (status) => {
    const f = fixture();
    await f.v.beginPrompt("user");
    f.messages([f.done()]);
    f.status(status);
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(false);
    expect(f.deps.react).not.toHaveBeenCalled();
  });

  it("a missing idle entry with verified session identity finalizes a completed transcript", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    f.messages([f.done()]);
    f.status(undefined);
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(true);
    expect(f.client.session.get).toHaveBeenCalledWith({ path: { id: f.v.sessionId }, signal: undefined });
    expect(f.deps.react).toHaveBeenCalledWith("C", "user", "white_check_mark");
  });

  it.each(["status HTTP error", "session HTTP error", "wrong session", "missing session", "malformed map", "malformed entry", "malformed retry"])("fails closed on %s", async (failure) => {
    const f = fixture();
    await f.v.beginPrompt("user");
    f.messages([f.done()]);
    f.status(undefined);
    if (failure === "status HTTP error") f.client.session.status.mockRejectedValue(new Error("HTTP 503"));
    if (failure === "session HTTP error") f.client.session.get.mockRejectedValue(new Error("HTTP 404"));
    if (failure === "wrong session") f.client.session.get.mockResolvedValue({ data: { id: "different-session" } });
    if (failure === "missing session") f.client.session.get.mockResolvedValue({ data: null });
    if (failure === "malformed map") f.client.session.status.mockResolvedValue({ data: [] });
    if (failure === "malformed entry") f.client.session.status.mockResolvedValue({ data: { unrelated: null } });
    if (failure === "malformed retry") f.client.session.status.mockResolvedValue({ data: { unrelated: { type: "retry" } } });
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(false);
    expect(f.v.isActive).toBe(true);
    expect(f.deps.react).not.toHaveBeenCalled();
  });

  it.each(["incomplete assistant", "newer user", "pending tool", "tool step", "waiting"])("blocks %s despite an older completed assistant and an absent idle entry", async (kind) => {
    const f = fixture();
    await f.v.beginPrompt("user");
    f.status(undefined);
    const done = f.done();
    const next = f.done();
    next.info.id = "newer";
    next.info.time!.created += 1;
    if (kind === "incomplete assistant") delete next.info.time!.completed;
    if (kind === "newer user") next.info.role = "user";
    if (kind === "pending tool") next.parts.push({ id: "pending", type: "tool", state: { status: "running" } });
    if (kind === "tool step") next.info.finish = "tool-calls";
    if (kind === "waiting") f.v.setWaiting("q", "question", true);
    f.messages([done, next]);
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(false);
    expect(f.v.isActive).toBe(true);
  });

  it("lost terminal SSE events cannot block a proven idle transcript forever", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    await f.v.handle(tool("lost"));
    f.messages([f.done([{ id: "lost", callID: "lost", type: "tool", state: { status: "completed" } }])]);
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(true);
    expect(f.deps.react).toHaveBeenCalledWith("C", "user", "white_check_mark");
  });

  it("singleflights polls and rejects a snapshot invalidated by a newer prompt", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    const gate = deferred<{ data: Message[] }>();
    f.client.session.messages.mockReturnValueOnce(gate.promise);
    const one = f.v.reconcileIfStale(Date.now(), 0);
    const two = f.v.reconcileIfStale(Date.now(), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.session.messages).toHaveBeenCalledTimes(1);
    await f.v.beginPrompt("new user");
    gate.resolve({ data: [f.done()] });
    expect(await one).toBe(false);
    expect(await two).toBe(false);
    expect(f.deps.react).not.toHaveBeenCalled();
  });

  it("rechecks the generation inside the tail behind pending events", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    const status = deferred<{ data: Record<string, { type: string }> }>();
    f.messages([f.done()]);
    f.client.session.status.mockReturnValueOnce(status.promise);
    const reconciliation = f.v.reconcileIfStale(Date.now(), 0);
    await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<{ ts: string }>();
    vi.mocked(f.deps.post).mockReturnValueOnce(gate.promise);
    const event = f.v.handle(text("streaming"));
    status.resolve({ data: { [f.v.sessionId]: { type: "idle" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.deps.react).not.toHaveBeenCalled();
    gate.resolve({ ts: "streaming" });
    await event;
    expect(await reconciliation).toBe(false);
  });

  it("polled user infos reconcile uncertain prompt receipts even while busy", async () => {
    const f = fixture();
    await f.v.beginPrompt("user");
    const info = { id: "accepted-user-id", sessionID: f.v.sessionId, role: "user", time: { created: Date.now() } };
    f.messages([{ info, parts: [] }]);
    f.status("busy");
    const spy = vi.spyOn(f.state, "reconcilePromptAcceptance");
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(false);
    expect(spy).toHaveBeenCalledWith("/renderer-reliability", info);
  });

  it("watch polls serialize terminal tools before their response and deduplicate full output", async () => {
    const f = fixture("full");
    const gate = deferred<{ ts: string }>();
    f.status("busy");
    f.messages([f.done([
      { id: "tool", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/renderer-reliability/a.ts" }, output: "x".repeat(500) } },
      { id: "answer", type: "text", text: "watch answer", time: { end: 1 } },
    ])]);
    await f.v.attach();
    vi.mocked(f.deps.post).mockReturnValueOnce(gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const event = f.v.handle(text("event answer"));
    expect(f.posted.join("\n")).not.toContain("event answer");
    gate.resolve({ ts: "tools" });
    await event;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(f.deps.upload).toHaveBeenCalledTimes(1);
    const answers = f.posted.filter((p) => p.includes("answer"));
    expect(answers[0]).toContain("watch answer");
    expect(answers[1]).toContain("event answer");
    expect(f.v.isActive).toBe(true); // completed transcript alone isn't sufficient
  });

  it.each(["HTTP error", "malformed map"])("unknown status (%s) does not quietly detach an idle-looking watch", async (failure) => {
    const f = fixture();
    if (failure === "HTTP error") f.client.session.status.mockRejectedValue(new Error("HTTP 503"));
    else f.client.session.status.mockResolvedValue({ data: null });
    await f.v.attach();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getView(f.v.sessionId)).toBe(f.v);
    expect(f.v.isActive).toBe(true);
  });

  it("a silent watch with only completed tools settles when the verified status map omits idle", async () => {
    const f = fixture("off");
    f.status(undefined);
    f.messages([f.done([{ id: "finished", type: "tool", state: { status: "completed" } }])]);
    await f.v.attach();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(getView(f.v.sessionId)).toBeUndefined();
    expect(f.posted.at(-1)).toContain("Silent Tools");
  });

  it("a locally idle watch cannot finalize an external runner's incomplete latest step", async () => {
    const f = fixture();
    f.status(undefined); // this server cannot see the external runner's busy status
    const latest = f.done([{ id: "tool-step", type: "tool", state: { status: "completed" } }]);
    latest.info.finish = "tool-calls";
    f.messages([f.done(), latest]);
    await f.v.attach();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getView(f.v.sessionId)).toBe(f.v);
    expect(await f.v.reconcileIfStale(Date.now(), 0)).toBe(false);
    expect(f.v.isActive).toBe(true);
  });
});

describe("consistent safe tool formatter", () => {
  const format = (tool: string, input: Record<string, unknown>, title?: string) => formatTool({ id: "t", type: "tool", tool, state: { input, title } }, "/p");
  it("uses shell descriptions and known targets even when titles vary", () => {
    expect(format("bash", { description: "Run the checks", command: "huge command" }, "unhelpful")).toBe("🔧 Run the checks");
    expect(format("functions.read", { filePath: "/p/src/x.ts" }, "different read title")).toBe("📄 read `src/x.ts`");
    expect(format("skill", { name: "review" }, "irrelevant")).toBe("⚡ skill `review`");
    expect(format("task", { subagent_type: "review", description: "Check parser" })).toBe("🤖 task review: Check parser");
  });
  it("derives apply_patch paths and normalizes MCP wrappers", () => {
    expect(format("functions.apply_patch", { patchText: "*** Begin Patch\n*** Update File: /p/a.ts\n-secret content\n*** Add File: /p/b.ts\n+private payload\n*** End Patch" })).toBe("🩹 patch `a.ts, b.ts`");
    expect(format("mcp__notion__fetch", {}, "Read notes")).toBe("🔧 `notion/fetch` · Read notes");
    expect(format("functions.notion_notion-fetch", {})).toBe("🔧 `notion/fetch`");
  });
  it("escapes all variable payloads and prevents code or mention injection", () => {
    const line = format("read", { filePath: "/p/`<!channel>` & <@U123>\nmore" });
    expect(line).toBe("📄 read `ˋ&lt;!channel&gt;ˋ &amp; &lt;@U123&gt;`");
    expect(line.match(/`/g)).toHaveLength(2); // only the intended enclosing code span
    expect(line).not.toMatch(/<!|<@|\n/);
  });
  it("keeps underscore paths, glob operators, and shell commands copyable as ASCII code", () => {
    expect(format("read", { filePath: "/p/src/foo_bar.ts" })).toBe("📄 read `src/foo_bar.ts`");
    expect(format("glob", { pattern: "**/foo_*.ts", path: "/p/src_dir" })).toBe("🔍 glob `**/foo_*.ts` in `src_dir`");
    expect(format("bash", { command: "ls ~/src_dir/*.ts" })).toBe("🔧 `ls ~/src_dir/*.ts`");
  });
});
