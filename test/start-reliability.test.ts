import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/start.js";
import { StateStore } from "../src/state.js";
import { SessionView, deleteView, type RenderDeps } from "../src/slack/render.js";
import { _resetQueueForTests } from "../src/slack/queue.js";
import type { OcQuestionRequest } from "../src/opencode/api.js";

// Real startBridge, state/receipts, router, queue, renderer, and boundedShutdown.
// Only external Slack/OpenCode/service boundaries are replaced. No child processes.
const f = vi.hoisted(() => ({
  root: `${process.cwd()}/test/.fixtures/start-reliability`,
  app: undefined as any,
  receiver: undefined as any,
  pool: undefined as any,
  questions: vi.fn(), permissions: vi.fn(), reply: vi.fn(), permReply: vi.fn(),
  runtimeClose: vi.fn(), auth: vi.fn(), appStart: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  CONFIG_DIR: f.root, CONFIG_PATH: `${f.root}/config.json`,
  STATE_PATH: `${f.root}/state.json`, PID_PATH: `${f.root}/slackoc.pid`,
  loadConfig: () => ({ slackBotToken: "xoxb-fixture", slackAppToken: "xapp-fixture", ownerSlackUserId: "UOWNER" }),
}));
vi.mock("../src/log.js", () => ({
  enableFileLog: vi.fn(), pushLog: vi.fn(), logErr: vi.fn(), ringLogger: () => ({}),
}));
vi.mock("../src/service.js", async original => ({
  ...await original<typeof import("../src/service.js")>(),
  startManagedRuntime: () => ({ close: f.runtimeClose }),
}));
vi.mock("../src/opencode/client.js", async original => ({
  ...await original<typeof import("../src/opencode/client.js")>(),
  pendingQuestions: f.questions, pendingPermissions: f.permissions, questionReply: f.reply, permRespond: f.permReply,
}));
vi.mock("@slack/bolt", () => ({
  LogLevel: { INFO: "info" },
  SocketModeReceiver: class {
    client = new EventEmitter();
    constructor(public options: unknown) { f.receiver = this; }
  },
  App: class {
    events = new Map<string, any>();
    actions = new Map<string, any>();
    views = new Map<string, any>();
    client = {
      auth: { test: f.auth },
      conversations: {
        open: vi.fn(async () => ({ channel: { id: "DOWNER" } })),
        replies: vi.fn(async () => ({ messages: [] })),
      },
      chat: {
        postMessage: vi.fn(async (_args: any) => ({ ts: "200.000001" })),
        update: vi.fn(async () => ({})), delete: vi.fn(async () => ({})),
      },
      reactions: { add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
      filesUploadV2: vi.fn(async () => ({})),
      views: { open: vi.fn(async () => ({})) },
    };
    start = f.appStart;
    stop = vi.fn(async () => {});
    event(name: string, handler: any) { this.events.set(name, handler); }
    action(name: string, handler: any) { this.actions.set(name, handler); }
    view(name: string, handler: any) { this.views.set(name, handler); }
    constructor(public options: unknown) { f.app = this; }
  },
}));
vi.mock("../src/opencode/server.js", () => ({
  ServerPool: class {
    entry = {
      dir: resolve(f.root), url: "http://fixture.invalid", baseUrl: "http://fixture.invalid", status: "ready",
      client: { session: { promptAsync: vi.fn(async () => ({ data: undefined })) } },
    };
    ensure = vi.fn(async () => this.entry);
    killAll = vi.fn(async () => {});
    close = vi.fn(async () => {});
    reapIdle = vi.fn(() => 0);
    list = vi.fn((): any[] => []);
    get = vi.fn(() => this.entry);
    constructor(public onEvent: any, _log: any, public onDeath: any, public onResume: any, public onReady: any, public hooks: any) {
      f.pool = this;
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const request: OcQuestionRequest = {
  id: "question-fixture", sessionID: "session-fixture",
  questions: [{ header: "Choose", question: "Which option?", options: [{ label: "A", description: "First" }] }],
};
const permission = { id: "permission-fixture", sessionID: request.sessionID, type: "bash", title: "Run tests" };
const rejected = () => Object.assign(new Error("missing_scope"), {
  code: "slack_webapi_platform_error", data: { error: "missing_scope" },
});
const processEvents = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
const processEmitter: EventEmitter = process;
let listeners: Map<string, Function[]>;
let exitCode: typeof process.exitCode;
let state: StateStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  listeners = new Map(processEvents.map(name => [name, processEmitter.listeners(name)]));
  exitCode = process.exitCode;
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network access in start integration test"); }));
  f.questions.mockReset().mockResolvedValue([]);
  f.permissions.mockReset().mockResolvedValue([]);
  f.reply.mockReset().mockResolvedValue({});
  f.permReply.mockReset().mockResolvedValue({});
  f.auth.mockReset().mockResolvedValue({ user_id: "UBOT", url: "https://fixture.slack.com/" });
  f.appStart.mockReset().mockResolvedValue(undefined);
  f.runtimeClose.mockClear();
  _resetQueueForTests();
  mkdirSync(f.root, { recursive: true });
  state = new StateStore(`${f.root}/state.json`);
  state.setThread("C:100.000000", {
    sessionId: request.sessionID, projectDir: f.root, verbose: "on",
    createdAt: Date.now(), lastUsedAt: Date.now(), lastSeenTs: "100.000000",
  });
});
afterEach(async () => {
  deleteView(request.sessionID);
  // Invoke only this bridge's signal handler, never signal the test runner/other services.
  stop();
  await vi.advanceTimersByTimeAsync(0);
  for (const name of processEvents) {
    for (const listener of processEmitter.listeners(name)) {
      if (!listeners.get(name)!.includes(listener)) processEmitter.removeListener(name, listener as (...args: any[]) => void);
    }
  }
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.exitCode = exitCode;
  _resetQueueForTests();
  rmSync(f.root, { force: true, recursive: true });
});
function stop() {
  const handler = processEmitter.listeners("SIGTERM").find(fn => !listeners.get("SIGTERM")!.includes(fn));
  handler?.();
}
async function boot() {
  await startBridge({ cwd: f.root });
  await vi.advanceTimersByTimeAsync(0);
}
async function clickQuestion() {
  const respond = vi.fn(async () => {});
  await f.app.actions.get("question")({
    ack: async () => {}, body: { user: { id: "UOWNER" } }, respond,
    action: { value: JSON.stringify({ s: request.sessionID, q: request.id, i: 0, a: 0 }) },
  });
  return respond;
}
function waitingSpy() {
  const noop = async () => {};
  const deps: RenderDeps = {
    post: async () => ({ ts: "view" }), update: noop, delete: noop,
    react: noop, unreact: noop, upload: noop,
  };
  const view = new SessionView({
    sessionId: request.sessionID, projectDir: f.root, channel: "C", threadTs: "100.000000",
    threadKey: "C:100.000000", client: {} as never, deps, state,
    threadState: state.getThread("C:100.000000")!,
  });
  return vi.spyOn(view, "setWaiting");
}

describe("startBridge reliability wiring", () => {
  it("delivers a question through both Slack destinations and forwards its answer", async () => {
    await boot();
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    const answer = clickQuestion();
    await vi.advanceTimersByTimeAsync(1_100);
    await answer;
    expect(f.reply).toHaveBeenCalledExactlyOnceWith("http://fixture.invalid", request.id, [["A"]]);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "DOWNER", blocks: expect.any(Array) }));
  });

  it("allows answering a delivered thread ask while its DM mirror is delayed", async () => {
    await boot();
    const dm = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : { ts: "ask" });
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C", blocks: expect.any(Array) }));
    const answering = clickQuestion();
    await vi.advanceTimersByTimeAsync(1_100);
    const response = await answering;
    dm.resolve({ ts: "dm" });
    await vi.advanceTimersByTimeAsync(0);
    expect(response).not.toHaveBeenCalledWith(expect.objectContaining({ text: "That question is no longer tracked here." }));
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it.each(["question", "permission"] as const)("retries a still-pending %s after missing_scope is fixed", async kind => {
    await boot();
    const req = kind === "question" ? request : permission;
    f.app.client.chat.postMessage.mockRejectedValue(rejected());
    f.pool.onEvent(f.root, `${kind}.asked`, req);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
    f.app.client.chat.postMessage.mockClear().mockResolvedValue({ ts: "recovered" });
    (kind === "question" ? f.questions : f.permissions).mockResolvedValue([req]);
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.receiver.client.emit("connected");
    await vi.advanceTimersByTimeAsync(2_200);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ blocks: expect.any(Array) }));
  });

  it.each(["question", "permission"] as const)("does not resurrect %s waiting from a snapshot older than the reply", async kind => {
    await boot();
    const req = kind === "question" ? request : permission;
    const pending = kind === "question" ? f.questions : f.permissions;
    const waiting = waitingSpy();
    f.pool.onEvent(f.root, `${kind}.asked`, req);
    await vi.advanceTimersByTimeAsync(1_100);
    const snapshot = deferred<Array<typeof request | typeof permission>>();
    pending.mockReturnValueOnce(snapshot.promise);
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.receiver.client.emit("connected");
    await vi.advanceTimersByTimeAsync(0);
    f.pool.onEvent(f.root, `${kind}.replied`, { requestID: req.id, sessionID: req.sessionID });
    await vi.advanceTimersByTimeAsync(1_100);
    snapshot.resolve([req]);
    await vi.advanceTimersByTimeAsync(1_100);
    // A second, empty authoritative poll should also be able to heal this race.
    pending.mockResolvedValue([]);
    f.receiver.client.emit("connected");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(waiting).toHaveBeenLastCalledWith(req.id, kind, false);
  });

  it("does not register live asks or nudges when their delivery finishes during shutdown", async () => {
    await boot();
    const dm = deferred<{ ts: string }>();
    const close = deferred<void>();
    f.app.stop.mockReturnValue(close.promise);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : { ts: "ask" });
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    dm.resolve({ ts: "dm" });
    await vi.advanceTimersByTimeAsync(0);
    close.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves permission copies, including a DM that finishes after the owner answers", async () => {
    await boot();
    const waiting = waitingSpy();
    const dm = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : { ts: "perm-thread" });
    f.pool.onEvent(f.root, "permission.asked", permission);
    await vi.advanceTimersByTimeAsync(1_100);
    f.permReply.mockImplementation(async () => {
      f.pool.onEvent(f.root, "permission.replied", { requestID: permission.id, sessionID: request.sessionID });
    });
    const answering = f.app.actions.get("perm")({
      ack: async () => {}, body: { user: { id: "UOWNER" } }, respond: vi.fn(), client: f.app.client,
      action: { value: JSON.stringify({ s: permission.sessionID, p: permission.id, r: "once" }) },
    });
    await vi.advanceTimersByTimeAsync(2_200);
    await answering;
    dm.resolve({ ts: "perm-dm" });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.permReply).toHaveBeenCalledOnce();
    expect(waiting).toHaveBeenLastCalledWith(permission.id, "permission", false);
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "DOWNER", ts: "perm-dm", text: expect.stringContaining("Approved (once)"),
      blocks: [expect.objectContaining({ type: "section" })],
    }));
    // Even repeated stale pending-list results and SSE asks cannot revive it.
    f.permissions.mockResolvedValue([permission]);
    f.pool.onEvent(f.root, "permission.asked", permission);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(waiting).toHaveBeenLastCalledWith(permission.id, "permission", false);
  });

  it.each(["question", "permission"] as const)("does not retry an uncertain %s destination or duplicate a delivered copy", async kind => {
    await boot();
    const req = kind === "question" ? request : permission;
    const pending = kind === "question" ? f.questions : f.permissions;
    pending.mockResolvedValue([req]);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C") throw Object.assign(new Error("post timed out"), { name: "TimeoutError" });
      return { ts: "delivered-dm" };
    });
    f.pool.onEvent(f.root, `${kind}.asked`, req);
    await vi.advanceTimersByTimeAsync(1_100);
    for (let i = 0; i < 4; i++) {
      f.pool.onReady(f.root, f.pool.entry.baseUrl);
      await vi.advanceTimersByTimeAsync(2_200);
    }
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["question", "permission"] as const)("bounds definitely rejected %s posts to three attempts per destination", async kind => {
    await boot();
    const req = kind === "question" ? request : permission;
    (kind === "question" ? f.questions : f.permissions).mockResolvedValue([req]);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C") throw rejected();
      return { ts: "delivered-dm" };
    });
    f.pool.onEvent(f.root, `${kind}.asked`, req);
    await vi.advanceTimersByTimeAsync(1_100);
    for (let i = 0; i < 5; i++) {
      f.pool.onReady(f.root, f.pool.entry.baseUrl);
      await vi.advanceTimersByTimeAsync(2_200);
    }
    const calls = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args.channel);
    expect(calls.filter((channel: string) => channel === "C")).toHaveLength(3);
    expect(calls.filter((channel: string) => channel === "DOWNER")).toHaveLength(1);
  });

  it("coalesces boot/resume polls and discards results from a replaced pool entry", async () => {
    await boot();
    const oldSnapshot = deferred<OcQuestionRequest[]>();
    f.questions.mockReturnValueOnce(oldSnapshot.promise);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(0);
    f.pool.onResume(f.root, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.questions).toHaveBeenCalledOnce();
    f.pool.entry = { ...f.pool.entry, baseUrl: "http://replacement.invalid", url: "http://replacement.invalid" };
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    oldSnapshot.resolve([request]);
    await vi.advanceTimersByTimeAsync(2_200);
    expect(f.questions.mock.calls.map(([url]) => url)).toEqual(["http://fixture.invalid", "http://replacement.invalid"]);
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("ignores an empty poll started before a new ask event", async () => {
    await boot();
    const snapshot = deferred<OcQuestionRequest[]>();
    f.questions.mockReturnValueOnce(snapshot.promise);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(0);
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    snapshot.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    const answering = clickQuestion();
    await vi.advanceTimersByTimeAsync(1_100);
    await answering;
    expect(f.reply).toHaveBeenCalledExactlyOnceWith("http://fixture.invalid", request.id, [["A"]]);
  });

  it("restores waiting on a later view for a boot-recovered ask without reposting it", async () => {
    await boot();
    f.questions.mockResolvedValue([request]);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(1_100);
    const waiting = waitingSpy();
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(waiting).toHaveBeenLastCalledWith(request.id, "question", true);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("preserves multi-select submission and custom-modal answers across recovery polls", async () => {
    await boot();
    const req: OcQuestionRequest = { ...request, questions: [
      { ...request.questions[0]!, multiple: true, options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] },
      { header: "Other", question: "Anything else?", options: [], custom: true },
    ] };
    f.questions.mockResolvedValue([req]);
    f.pool.onEvent(f.root, "question.asked", req);
    await vi.advanceTimersByTimeAsync(1_100);
    const action = (name: string, i: number, a?: number) => f.app.actions.get(name)({
      ack: async () => {}, body: { user: { id: "UOWNER" }, trigger_id: "trigger" }, respond: vi.fn(), client: f.app.client,
      action: { value: JSON.stringify({ s: req.sessionID, q: req.id, i, a }) },
    });
    await action("question", 0, 0);
    await action("question", 0, 1);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(0);
    await action("qsubmit", 0);
    expect(f.reply).not.toHaveBeenCalled();
    await action("qtext", 1);
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    const submitting = f.app.views.get("qtext_submit")({
      ack: async () => {}, body: { user: { id: "UOWNER" } }, respond: vi.fn(),
      view: { private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "custom answer" } } } } },
    });
    await vi.advanceTimersByTimeAsync(2_200);
    await submitting;
    expect(f.reply).toHaveBeenCalledExactlyOnceWith("http://fixture.invalid", req.id, [["A", "B"], ["custom answer"]]);
  });

  it("cancels both bot and Socket Mode HTTP transports when shutdown begins", async () => {
    await boot();
    const bot = f.app.options.clientOptions;
    const socket = f.receiver.options.installerOptions.clientOptions;
    expect(socket).toBe(bot);
    expect(bot.retryConfig.retries).toBe(0);
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const first = expect(bot.fetch("https://slack.com/api/auth.test", {})).rejects.toThrow("bridge stopping");
    const second = expect(socket.fetch("https://slack.com/api/apps.connections.open", {})).rejects.toThrow("bridge stopping");
    stop();
    await Promise.all([first, second]);
    expect(signals).toHaveLength(2);
    expect(signals.every(s => s.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    for (const name of processEvents) expect(processEmitter.listeners(name)).toEqual(listeners.get(name));
    expect(f.pool.close).toHaveBeenCalledOnce();
  });

  it("stops accepting Slack messages while app.stop is still draining", async () => {
    await boot();
    const close = deferred<void>();
    f.app.stop.mockReturnValue(close.promise);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    const incoming = f.app.events.get("message")({ event: {
      channel: "CNEW", ts: "200.000000", channel_type: "im", user: "UOWNER", text: "",
    } });
    await vi.advanceTimersByTimeAsync(0);
    await incoming;
    close.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ channel: "CNEW" }));
  });

  it("does not continue startup when auth completes after shutdown begins", async () => {
    const auth = deferred<{ user_id: string }>();
    const close = deferred<void>();
    f.auth.mockReturnValue(auth.promise);
    const starting = startBridge({ cwd: f.root });
    f.app.stop.mockReturnValue(close.promise);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    auth.resolve({ user_id: "UBOT" });
    await starting;
    await vi.advanceTimersByTimeAsync(0);
    close.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.start).not.toHaveBeenCalled();
  });

  it("does not label a newly accepted live prompt as an interrupted prior-boot run", async () => {
    f.appStart.mockImplementation(async () => {
      await f.app.events.get("message")({ event: {
        channel: "C", thread_ts: "100.000000", ts: "200.000000", user: "UOWNER", text: "fresh prompt",
      } });
    });
    const starting = startBridge({ cwd: f.root });
    await vi.advanceTimersByTimeAsync(6_000);
    await starting;
    expect(f.pool.entry.client.session.promptAsync).toHaveBeenCalledOnce();
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Bridge restarted during this run"),
    }));
  });
});
