import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/start.js";
import { StateStore } from "../src/state.js";
import { SessionView, deleteView, type RenderDeps } from "../src/slack/render.js";
import { _resetQueueForTests } from "../src/slack/queue.js";
import { PermissionDeliveryStore } from "../src/slack/permissions.js";
import type { OcQuestionRequest } from "../src/opencode/api.js";
import { ScheduleStore } from "../src/schedules/store.js";
import { ReportRunner } from "../src/schedules/runner.js";
import { QuestionsStore, questionBindingToken } from "../src/slack/questions-store.js";
import { normalizeForm } from "../src/opencode/v2.js";

// Real startBridge, state/receipts, router, queue, renderer, and boundedShutdown.
// Only external Slack/OpenCode/service boundaries are replaced. No child processes.
const f = vi.hoisted(() => ({
  root: `${process.cwd()}/test/.fixtures/start-reliability`,
  app: undefined as any,
  receiver: undefined as any,
  pool: undefined as any,
  questions: vi.fn(), permissions: vi.fn(), reply: vi.fn(), permReply: vi.fn(), messages: vi.fn(),
  runtimeClose: vi.fn(), auth: vi.fn(), appStart: vi.fn(), sessionList: vi.fn(), sessionGet: vi.fn(),
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
  sessionMessages: f.messages,
  sessionList: f.sessionList, sessionGet: f.sessionGet,
}));
vi.mock("@slack/bolt", () => ({
  LogLevel: { INFO: "info" },
  SocketModeReceiver: class {
    client = new EventEmitter();
    constructor(public options: unknown) { f.receiver = this; }
  },
  App: class {
    events = new Map<string, any>();
    actions = new Map<string | RegExp, any>();
    views = new Map<string, any>();
    client = {
      auth: { test: f.auth },
      conversations: {
        open: vi.fn(async () => ({ channel: { id: "DOWNER" } })),
        replies: vi.fn(async () => ({ messages: [] })),
        history: vi.fn(async () => ({ messages: [] })),
      },
      chat: {
        postMessage: vi.fn(slackPost),
        update: vi.fn(async () => ({})), delete: vi.fn(async () => ({})),
      },
      reactions: { add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) },
      filesUploadV2: vi.fn(async () => ({})),
      views: { open: vi.fn(async ({ view }: any) => {
        if (Array.from(view.title.text).length > 24 || !view.submit || view.blocks.some((b: any) => b.type === "input" && b.label.text.length > 2000)) throw rejected("invalid_arguments");
        return {};
      }) },
    };
    start = f.appStart;
    stop = vi.fn(async () => {});
    event(name: string, handler: any) { this.events.set(name, handler); }
    action(name: string | RegExp, handler: any) { this.actions.set(name, handler); }
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
    acquire = vi.fn(async () => ({ entry: this.entry, release: vi.fn() }));
    acquireExisting = vi.fn(() => ({ entry: this.entry, release: vi.fn() }));
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request: OcQuestionRequest = {
  id: "question-fixture", sessionID: "session-fixture",
  questions: [{ header: "Choose", question: "Which option?", options: [{ label: "A", description: "First" }] }],
};
const permission = { id: "permission-fixture", sessionID: request.sessionID, type: "bash", title: "Run tests" };
const NOW = Date.parse("2026-09-18T12:00:00Z");
const ROOT_TS = `${NOW / 1000 - 60}.000000`;
const THREAD_KEY = `C:${ROOT_TS}`;
const THREAD_CARD_TS = `${NOW / 1000}.000001`;
const DM_CARD_TS = `${NOW / 1000}.000002`;
let messageSequence = 10;
const slackTs = () => `${Math.floor(Date.now() / 1000)}.${String(messageSequence++).padStart(6, "0")}`;
const rejected = (error = "missing_scope") => Object.assign(new Error(error), {
  code: "slack_webapi_platform_error", data: { error },
});
// Slack rejects duplicate action IDs within an actions block. Keep this check
// independent of the builders so old, invalid payloads cannot pass the boundary.
async function slackPost(args: any) {
  for (const block of args.blocks ?? []) {
    const ids = (block.elements ?? []).map((element: any) => element.action_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw rejected("invalid_blocks");
  }
  return { ts: slackTs() };
}
const processEvents = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;
const processEmitter: EventEmitter = process;
let listeners: Map<string, Function[]>;
let exitCode: typeof process.exitCode;
let state: StateStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  listeners = new Map(processEvents.map(name => [name, processEmitter.listeners(name)]));
  exitCode = process.exitCode;
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network access in start integration test"); }));
  f.questions.mockReset().mockResolvedValue([]);
  f.permissions.mockReset().mockResolvedValue([]);
  f.reply.mockReset().mockResolvedValue({});
  f.permReply.mockReset().mockResolvedValue({});
  f.messages.mockReset().mockResolvedValue([]);
  f.sessionList.mockReset().mockResolvedValue([{ id: request.sessionID, directory: f.root, title: "Fixture", time: { created: NOW, updated: NOW } }]);
  f.sessionGet.mockReset().mockResolvedValue({ id: request.sessionID });
  f.auth.mockReset().mockResolvedValue({ user_id: "UBOT", url: "https://fixture.slack.com/" });
  f.appStart.mockReset().mockResolvedValue(undefined);
  f.runtimeClose.mockClear();
  _resetQueueForTests();
  mkdirSync(f.root, { recursive: true });
  state = new StateStore(`${f.root}/state.json`);
  state.setThread(THREAD_KEY, {
    sessionId: request.sessionID, projectDir: f.root, verbose: "on",
    createdAt: Date.now(), lastUsedAt: Date.now(), lastSeenTs: ROOT_TS,
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
  const migration = vi.spyOn(StateStore.prototype, "migrateRecovery");
  await startBridge({ cwd: f.root });
  state = migration.mock.contexts.at(-1) as StateStore;
  migration.mockRestore();
  await vi.advanceTimersByTimeAsync(0);
}
async function drain<T>(work: Promise<T>, milliseconds = 2_200): Promise<T> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  return work;
}
async function postPermission() {
  f.permissions.mockResolvedValue([permission]);
  f.pool.onEvent(f.root, "permission.asked", permission);
  await vi.advanceTimersByTimeAsync(1_100);
}
function actionHandler(id: string) {
  const matches = [...f.app.actions].filter(([pattern]) => typeof pattern === "string" ? pattern === id : pattern.test(id));
  expect(matches, `registered handler for generated action ${id}`).toHaveLength(1);
  return matches[0]![1];
}
function postedButton(id: string, channel = "C") {
  const post = questionCards().find(card => card.args.channel === channel && card.args.blocks?.some((block: any) => block.elements?.some((b: any) => b.action_id === id)))?.args;
  expect(post, `posted ${id} card in ${channel}`).toBeDefined();
  return post.blocks.flatMap((block: any) => block.elements ?? []).find((b: any) => b.action_id === id);
}
function questionCards() {
  return [f.app.client.chat.postMessage, f.app.client.chat.update].flatMap((mock, transport) =>
    mock.mock.calls.map(([args]: any[], index: number) => ({ args, transport, result: mock.mock.results[index].value,
      order: mock.mock.invocationCallOrder[index] }))).sort((a, b) => b.order - a.order);
}
async function clickButton(button: any, channel = "C", actor = "UOWNER", root = ROOT_TS) {
  const respond = vi.fn(async () => {});
  const ack = vi.fn(async () => {});
  const matching = questionCards().filter(card => card.args.channel === channel && card.args.blocks?.some((block: any) =>
    block.elements?.some((b: any) => b.action_id === button.action_id)));
  const card = matching.find(card => card.args.blocks.some((block: any) => block.elements?.some((b: any) => b.value === button.value))) ?? matching[0];
  expect(card).toBeDefined();
  const posted = card!.transport === 0 ? await card!.result : card!.args;
  await actionHandler(button.action_id)({
    ack, body: { user: { id: actor }, channel: { id: channel },
      container: { message_ts: posted.ts },
      message: { ts: posted.ts, ...(channel === "C" ? { thread_ts: root } : {}) }, trigger_id: "trigger" },
    respond, client: f.app.client, action: button,
  });
  expect(ack).toHaveBeenCalledOnce();
  return respond;
}
const clickQuestion = () => clickButton(postedButton("question_0_0"));
function textPermission(channel = "C", actor = "UOWNER", text = `\\permission ${permission.id} once`) {
  return f.app.events.get("message")({ event: { channel, user: actor, text, ts: slackTs(),
    ...(channel === "DOWNER" ? { channel_type: "im" } : { thread_ts: ROOT_TS }) } });
}
function waitingSpy() {
  const noop = async () => {};
  const deps: RenderDeps = {
    post: async () => ({ ts: slackTs() }), update: noop, delete: noop,
    react: noop, unreact: noop, upload: noop,
  };
  const view = new SessionView({
    sessionId: request.sessionID, projectDir: f.root, channel: "C", threadTs: ROOT_TS,
    threadKey: THREAD_KEY, client: {} as never, deps, state,
    threadState: state.getThread(THREAD_KEY)!,
  });
  return vi.spyOn(view, "setWaiting");
}

describe("startBridge message catch-up cadence", () => {
  it("recovers a history-only prompt at ten seconds, not before, without resubmitting it", async () => {
    await boot();
    expect(f.app.client.conversations.replies).toHaveBeenCalledOnce();
    const missedTs = `${NOW / 1000 + 5}.000001`;
    f.app.client.conversations.replies.mockResolvedValue({ messages: [{
      ts: missedTs, user: "UOWNER", text: "missed prompt",
    }] });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.app.client.conversations.replies).toHaveBeenCalledOnce();
    expect(f.pool.entry.client.session.promptAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.app.client.conversations.replies).toHaveBeenCalledTimes(2);
    expect(f.pool.entry.client.session.promptAsync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      path: { id: request.sessionID }, body: expect.objectContaining({ parts: [{ type: "text", text: "missed prompt" }] }),
    }));
    expect(state.getReceipt(THREAD_KEY, missedTs)?.disposition).toBe("accepted");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.app.client.conversations.replies).toHaveBeenCalledTimes(3);
    expect(f.pool.entry.client.session.promptAsync).toHaveBeenCalledOnce();
  });

  it("coalesces timer ticks behind a slow scan and stops polling on shutdown", async () => {
    await boot();
    const page = deferred<{ messages: never[] }>();
    f.app.client.conversations.replies.mockClear().mockReturnValueOnce(page.promise);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(f.app.client.conversations.replies).toHaveBeenCalledOnce();
    page.resolve({ messages: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.client.conversations.replies).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.app.client.conversations.replies).toHaveBeenCalledTimes(2);
  });
});

describe("startBridge reliability wiring", () => {
  it("posts the next question below intervening content and silently deletes both old cards", async () => {
    await boot();
    const req = { ...request, questions: [...request.questions, { ...request.questions[0]!, header: "Second" }] };
    f.questions.mockResolvedValue([req]);
    f.pool.onEvent(f.root, "question.asked", req);
    await vi.advanceTimersByTimeAsync(1_100);
    const initial = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    const old = postedButton("question_skip");
    await f.app.client.chat.postMessage({ channel: "C", thread_ts: ROOT_TS, text: "Intervening thread message" });
    await drain(clickQuestion(), 4_400);
    const moved = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(moved.presentation).toBe(1);
    expect(moved.askTs).not.toBe(initial.askTs); expect(moved.dmTs).not.toBe(initial.dmTs);
    const posts = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args);
    const next = posts.filter((args: any) => args.blocks?.some((block: any) => block.elements?.some((b: any) => b.action_id === "question_1_0")));
    expect(next.map((args: any) => args.channel).sort()).toEqual(["C", "DOWNER"]);
    expect(next.find((args: any) => args.channel === "C").thread_ts).toBe(ROOT_TS);
    expect(next.find((args: any) => args.channel === "DOWNER").thread_ts).toBeUndefined();
    expect(posts.indexOf(next.find((args: any) => args.channel === "C"))).toBeGreaterThan(posts.findIndex((args: any) => args.text === "Intervening thread message"));
    for (const [channel, ts] of [["C", initial.askTs], ["DOWNER", initial.dmTs]]) {
      expect(f.app.client.chat.delete).toHaveBeenCalledWith({ channel, ts });
    }
    expect(f.app.client.chat.update.mock.calls.some(([args]: any[]) => args.text?.includes("Question moved"))).toBe(false);
    const stale = await drain(clickButton(old));
    expect(stale).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral", text: expect.stringContaining("latest") }));
    expect(f.reply).not.toHaveBeenCalled();
    await drain(clickButton(postedButton("question_1_0")));
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, req.id, [["A"], ["A"]], { request: req });
  });

  it("keeps toggles and option pages in place, then moves after Submit selection", async () => {
    await boot();
    const req = { ...request, questions: [{ ...request.questions[0]!, multiple: true,
      options: Array.from({ length: 21 }, (_, i) => ({ label: `Choice ${i}`, description: "" })) }, request.questions[0]!] };
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    const initial = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    await drain(clickQuestion()); await drain(clickButton(postedButton("qpage_next")));
    const toggled = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(toggled.askTs).toBe(initial.askTs); expect(toggled.dmTs).toBe(initial.dmTs);
    expect(toggled.presentation).toBe(0);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
    await drain(clickButton(postedButton("qsubmit")), 4_400);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(req.id)?.askTs).not.toBe(initial.askTs);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it.each(["message_not_found", "cant_delete_message"])("handles %s during old-card cleanup without a replacement notice", async error => {
    await boot();
    const req = { ...request, questions: [...request.questions, request.questions[0]!] };
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    f.app.client.chat.delete.mockRejectedValue(rejected(error));
    await drain(clickQuestion(), 4_400);
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(saved.presentation).toBe(1);
    expect(saved.retiredCopies).toHaveLength(error === "message_not_found" ? 0 : 2);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(4);
    expect(f.app.client.chat.update.mock.calls.some(([args]: any[]) => args.text?.includes("Question moved"))).toBe(false);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("resurfaces questions after command feedback and rejects a popup from the prior card", async () => {
    await boot();
    const req = { ...request, questions: [{ ...request.questions[0]!, custom: true }] };
    f.questions.mockResolvedValue([req]);
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    await clickButton(postedButton("qtext"));
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    const initial = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    await drain(textPermission("C", "UOWNER", "\\questions"), 6_600);
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(saved.askTs).not.toBe(initial.askTs);
    const posts = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args);
    const status = posts.findIndex((args: any) => args.channel === "C" && args.text.includes("*Pending questions:*"));
    const fresh = posts.findIndex((args: any) => args.channel === "C" && args.text.includes(":card:1:thread"));
    expect(fresh).toBeGreaterThan(status);
    const ack = vi.fn(async () => {});
    await f.app.views.get("qtext_submit")({ ack, body: { user: { id: "UOWNER" } }, view: {
      private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "stale" } } } },
    } });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: "errors" }));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("moves to the next question after a custom-answer popup without sending the incomplete form", async () => {
    await boot();
    const req = { ...request, questions: [{ ...request.questions[0]!, custom: true }, request.questions[0]!] };
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    const initial = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    await clickButton(postedButton("qtext"));
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    await drain(f.app.views.get("qtext_submit")({ ack: vi.fn(async () => {}), body: { user: { id: "UOWNER" } }, view: {
      private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "My own answer" } } } },
    } }), 4_400);
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(saved.answers[0]).toEqual(["My own answer"]);
    expect(saved.askTs).not.toBe(initial.askTs);
    expect(JSON.parse(postedButton("question_1_0").value).c).toBe(1);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("reconciles a response-lost replacement using its exact bot-authored presentation marker", async () => {
    await boot();
    const req = { ...request, questions: [...request.questions, request.questions[0]!] };
    f.questions.mockResolvedValue([req]);
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    f.app.client.chat.postMessage.mockRejectedValueOnce(new Error("response lost after posting next question"));
    await drain(clickQuestion(), 4_400);
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(saved.relocation?.thread?.status).toBe("uncertain");
    const attempted = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args)
      .find((args: any) => args.channel === "C" && args.text.includes(":card:1:thread"));
    expect(attempted).toBeDefined();
    const marker = attempted.text.split("\n").at(-1);
    const recoveredTs = slackTs();
    f.app.client.conversations.replies.mockResolvedValue({ messages: [
      { user: "UOTHER", text: marker, ts: slackTs() },
      { user: "UBOT", text: `OpenCode question\n${marker}`, ts: recoveredTs },
    ] });
    const attempts = f.app.client.chat.postMessage.mock.calls.length;
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(30_000);
    const recovered = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(recovered.askTs).toBe(recoveredTs);
    expect(recovered.threadPresentation).toBe(1);
    expect(recovered.relocation?.thread).toBeUndefined();
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(attempts);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("coalesces concurrently requested question resurfacing", async () => {
    await boot(); f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    await drain(Promise.all([textPermission("C", "UOWNER", "\\questions"), textPermission("C", "UOWNER", "\\questions")]), 8_800);
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(request.id)!;
    expect(saved.presentation).toBe(1);
    const newCards = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args).filter((args: any) => args.text.includes(":card:1:"));
    expect(newCards).toHaveLength(2);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("recovers failed old-card deletion without another answer, prompt, or notice", async () => {
    await boot();
    const req = { ...request, questions: [...request.questions, { ...request.questions[0]!, header: "Second" }] };
    f.questions.mockResolvedValue([req]);
    f.pool.onEvent(f.root, "question.asked", req);
    await vi.advanceTimersByTimeAsync(1_100);
    const old = postedButton("question_0_0");
    f.app.client.chat.delete.mockRejectedValue(new Error("card transport failure"));
    await drain(clickQuestion());
    expect(f.reply).not.toHaveBeenCalled();
    expect(new QuestionsStore(`${f.root}/questions.json`).get(req.id)?.retiredCopies).toHaveLength(2);
    f.app.client.chat.delete.mockReset().mockResolvedValue({});
    f.pool.list.mockReturnValue([f.pool.entry]);
    // Retired-copy cleanup uses a 60s cooldown; the next 30s poll retries it.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(postedButton("question_1_0")).toBeDefined();
    expect(f.app.client.chat.delete).toHaveBeenCalledWith(expect.objectContaining({ channel: "DOWNER" }));
    expect(f.app.client.chat.update.mock.calls.some(([args]: any[]) => args.text?.includes("Question moved"))).toBe(false);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(req.id)?.retiredCopies).toEqual([]);
    const response = await drain(clickButton(old));
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("already saved") }));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("adopts a pending form after actual same-session resume despite its stopped old run", async () => {
    await boot();
    f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    const old = postedButton("question_0_0");
    state.recordRunOutcome(THREAD_KEY, request.sessionID, "active", [ROOT_TS]);
    await drain(textPermission("C", "UOWNER", `\\resume ${request.sessionID}`), 4_400);
    expect(state.getThread(THREAD_KEY)?.recovery?.lastRun?.outcome).toBe("stopped");
    expect(JSON.parse(postedButton("question_0_0").value).g).toBe(state.bindingGeneration(THREAD_KEY));
    const stale = await drain(clickButton(old));
    expect(stale).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
    expect(f.reply).not.toHaveBeenCalled();
    await drain(clickQuestion());
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, request.id, [["A"]], { request });
  });

  it("does not let a stale modal overwrite a finalized question", async () => {
    await boot();
    const req = { ...request, questions: [{ ...request.questions[0]!, custom: true }, { ...request.questions[0]!, header: "Second" }] };
    f.pool.onEvent(f.root, "question.asked", req);
    await vi.advanceTimersByTimeAsync(1_100);
    await clickButton(postedButton("qtext"));
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    await drain(clickQuestion());
    const ack = vi.fn(async () => {});
    await f.app.views.get("qtext_submit")({ ack, body: { user: { id: "UOWNER" } },
      view: { private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "overwrite" } } } } } });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: "errors" }));
    expect(new QuestionsStore(`${f.root}/questions.json`).get(req.id)?.answers[0]).toEqual(["A"]);
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("recovers a failed final-card collapse without a second native reply", async () => {
    await boot();
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    f.app.client.chat.update.mockRejectedValue(new Error("transport unavailable"));
    await drain(clickQuestion());
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(request.id)!;
    expect(saved).toMatchObject({ response: "resolved", resolvedText: ":white_check_mark: Answer confirmed." });
    expect(saved.ui!.threadApplied).toBeLessThan(saved.ui!.revision);
    f.app.client.chat.update.mockReset().mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Answer confirmed.") }));
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("restores partial answers and dirty delivered cards after a bridge restart", async () => {
    await boot();
    const req = { ...request, questions: [...request.questions, { ...request.questions[0]!, header: "Second" }] };
    f.questions.mockResolvedValue([req]);
    f.pool.onEvent(f.root, "question.asked", req);
    await vi.advanceTimersByTimeAsync(1_100);
    f.app.client.chat.update.mockRejectedValue(new Error("offline"));
    await drain(clickQuestion());
    stop(); await vi.advanceTimersByTimeAsync(0); _resetQueueForTests();
    await boot();
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(2_200);
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalled();
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(req.id)!;
    expect(saved.answers[0]).toEqual(["A"]);
    expect(saved.threadPresentation).toBe(saved.presentation);
    await drain(actionHandler("question_1_0")({ ack: vi.fn(async () => {}), respond: vi.fn(async () => {}),
      body: { user: { id: "UOWNER" }, channel: { id: "C" }, message: { ts: saved.askTs, thread_ts: ROOT_TS } },
      action: { action_id: "question_1_0", value: JSON.stringify({ s: saved.sessionId, q: saved.id, i: 1, a: 0,
        g: saved.generation, b: questionBindingToken(saved), c: saved.presentation }) } }));
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, req.id, [["A"], ["A"]], { request: req });
  });

  it("restores explicit resume authority after restart without replaying a stopped prompt", async () => {
    await boot();
    f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    state.recordRunOutcome(THREAD_KEY, request.sessionID, "active", [ROOT_TS]);
    await drain(textPermission("C", "UOWNER", `\\resume ${request.sessionID}`), 4_400);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.resumeOwnerTs).toBeDefined();
    stop(); await vi.advanceTimersByTimeAsync(0); _resetQueueForTests();
    await boot(); f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(2_200);
    const saved = new QuestionsStore(`${f.root}/questions.json`).get(request.id)!;
    await drain(actionHandler("question_0_0")({ ack: vi.fn(async () => {}), respond: vi.fn(async () => {}),
      body: { user: { id: "UOWNER" }, channel: { id: "C" }, message: { ts: saved.askTs, thread_ts: ROOT_TS } },
      action: { action_id: "question_0_0", value: JSON.stringify({ s: saved.sessionId, q: saved.id, i: 0, a: 0, g: saved.generation, b: questionBindingToken(saved) }) } }));
    expect(f.reply).toHaveBeenCalledOnce();
    expect(f.pool.entry.client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("resolves an unhydrated stored submission when an authoritative poll proves it is no longer pending", async () => {
    new QuestionsStore(`${f.root}/questions.json`).put({ id: request.id, sessionId: request.sessionID, projectDir: f.root,
      generation: 1, channel: "C", threadTs: ROOT_TS, req: request, answers: [["A"]], finalized: [true],
      response: "answering", askTs: THREAD_CARD_TS, dmTs: DM_CARD_TS, updatedAt: NOW,
      ui: { revision: 2, threadApplied: 2, dmApplied: 2 } });
    await boot(); f.pool.onReady(f.root, f.pool.entry.baseUrl); await vi.advanceTimersByTimeAsync(2_200);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)).toMatchObject({ response: "resolved",
      resolvedText: "Question resolved or expired; the previous answer was not confirmed." });
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: THREAD_CARD_TS, text: expect.stringContaining("not confirmed") }));
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("handles a native resolution event before a persisted question is hydrated", async () => {
    new QuestionsStore(`${f.root}/questions.json`).put({ id: request.id, sessionId: request.sessionID, projectDir: f.root,
      generation: 1, channel: "C", threadTs: ROOT_TS, req: request, answers: [["A"]], finalized: [true],
      response: "uncertain", askTs: THREAD_CARD_TS, dmTs: null, updatedAt: NOW });
    await boot(); f.pool.onEvent(f.root, "question.replied", { requestID: request.id, sessionID: request.sessionID });
    await vi.advanceTimersByTimeAsync(2_200);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.resolvedText).toContain("Answer confirmed");
    expect(f.app.client.chat.update).toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled();
  });

  it("does not let a delayed resume query overtake a later cancellation without a lastRun", async () => {
    await boot();
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const old = postedButton("question_0_0");
    const pending = deferred<OcQuestionRequest[]>(); f.questions.mockReturnValueOnce(pending.promise);
    const resume = textPermission("C", "UOWNER", `\\resume ${request.sessionID}`);
    await vi.advanceTimersByTimeAsync(1_100);
    state.cancelRecovery(THREAD_KEY, slackTs());
    pending.resolve([request]); await drain(resume);
    await drain(clickButton(old));
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.resumeOwnerTs).toBeUndefined();
    expect(f.reply).not.toHaveBeenCalled();
  });

  it("grants validated resume authority to an ask arriving before the query finishes", async () => {
    await boot(); state.recordRunOutcome(THREAD_KEY, request.sessionID, "active", [ROOT_TS]);
    const pending = deferred<OcQuestionRequest[]>(); f.questions.mockReturnValueOnce(pending.promise);
    const resume = textPermission("C", "UOWNER", `\\resume ${request.sessionID}`); await vi.advanceTimersByTimeAsync(1_100);
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.resumeOwnerTs).toBeUndefined();
    pending.resolve([request]); await drain(resume, 4_400);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.resumeOwnerTs).toBeDefined();
    await drain(clickQuestion()); expect(f.reply).toHaveBeenCalledOnce();
  });

  it("recovers questions even when Slack rejects the resume confirmation message", async () => {
    await boot(); f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const old = postedButton("question_0_0"); state.recordRunOutcome(THREAD_KEY, request.sessionID, "active", [ROOT_TS]);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.text.startsWith("↩️ Thread bound")) throw new Error("confirmation lost"); return slackPost(args);
    });
    await drain(textPermission("C", "UOWNER", `\\resume ${request.sessionID}`), 4_400);
    expect(postedButton("question_0_0").value).not.toBe(old.value);
    await drain(clickQuestion()); expect(f.reply).toHaveBeenCalledOnce();
  });

  it("does not let a late obsolete post replace a newer terminal binding with the same generation", async () => {
    await boot(); f.questions.mockResolvedValue([request]);
    const oldPost = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C" && args.thread_ts === ROOT_TS && args.text.includes("slackoc-question:")) return oldPost.promise;
      return slackPost(args);
    });
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const oldDm = postedButton("question_0_0", "DOWNER");
    const previous = new QuestionsStore(`${f.root}/questions.json`).get(request.id)!;
    state.deleteThread(THREAD_KEY);
    const root = `${NOW / 1000 - 30}.000000`;
    await drain(f.app.events.get("message")({ event: { channel: "C2", user: "UOWNER", text: `\\resume ${request.sessionID}`, ts: slackTs(), thread_ts: root } }), 4_400);
    const current = new QuestionsStore(`${f.root}/questions.json`).get(request.id)!;
    expect(current.generation).toBe(previous.generation);
    expect(current.ui!.threadApplied).toBeLessThanOrEqual(current.ui!.revision);
    await drain(clickButton(oldDm, "DOWNER")); expect(f.reply).not.toHaveBeenCalled();
    await drain(clickButton(postedButton("question_0_0", "DOWNER"), "DOWNER"));
    oldPost.resolve({ ts: THREAD_CARD_TS }); await vi.advanceTimersByTimeAsync(4_400);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)).toMatchObject({ channel: "C2", threadTs: root, response: "resolved" });
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("discovers and collapses a response-lost initial DM after the native form resolves", async () => {
    await boot();
    const dm = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : slackPost(args));
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const text = f.app.client.chat.postMessage.mock.calls.find(([args]: any[]) => args.channel === "DOWNER")[0].text;
    await drain(clickQuestion());
    dm.reject(new Error("post response lost")); await vi.advanceTimersByTimeAsync(0);
    f.app.client.conversations.history.mockResolvedValue({ messages: [{ user: "UBOT", ts: DM_CARD_TS, text }] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: "DOWNER", ts: DM_CARD_TS, text: expect.stringContaining("Answer confirmed") }));
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("a failed resume does not authorize pending forms in the invalidated binding", async () => {
    await boot();
    f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    const old = postedButton("question_0_0");
    state.recordRunOutcome(THREAD_KEY, request.sessionID, "active", [ROOT_TS]);
    f.sessionGet.mockRejectedValueOnce(new Error("session unavailable"));
    await drain(textPermission("C", "UOWNER", `\\resume ${request.sessionID}`));
    f.pool.onReady(f.root, f.pool.entry.baseUrl); await vi.advanceTimersByTimeAsync(2_200);
    await drain(clickButton(old));
    expect(f.reply).not.toHaveBeenCalled();
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.resumeOwnerTs).toBeUndefined();
  });

  it("reconciles an uncertain submission before permitting an explicit second send", async () => {
    await boot(); f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const old = postedButton("question_0_0");
    f.reply.mockRejectedValueOnce(new Error("reply timed out"));
    await drain(clickButton(old));
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.response).toBe("uncertain");
    await drain(clickButton(old)); expect(f.reply).toHaveBeenCalledOnce();
    await drain(clickButton(postedButton("qretry")), 4_400);
    expect(f.reply).toHaveBeenCalledOnce();
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.response).toBe("pending");
    await drain(clickButton(postedButton("qretry")));
    expect(f.reply).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a confirmed resolution when the HTTP response later fails", async () => {
    await boot(); f.questions.mockResolvedValue([request]);
    f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const http = deferred<unknown>(); f.reply.mockReturnValueOnce(http.promise);
    const click = clickQuestion(); await vi.advanceTimersByTimeAsync(1_100);
    f.pool.onEvent(f.root, "question.replied", { requestID: request.id, sessionID: request.sessionID });
    await vi.advanceTimersByTimeAsync(2_200);
    http.reject(new Error("response lost")); await drain(click);
    expect(new QuestionsStore(`${f.root}/questions.json`).get(request.id)?.response).toBe("resolved");
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it("keeps the modal retryable when durable draft saving fails", async () => {
    await boot();
    const req = { ...request, questions: [{ ...request.questions[0]!, custom: true }, { ...request.questions[0]!, header: "Second" }] };
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    await clickButton(postedButton("qtext"));
    const view = { private_metadata: f.app.client.views.open.mock.calls[0][0].view.private_metadata,
      state: { values: { qtext_input: { qtext_field: { value: "custom" } } } } };
    const write = vi.spyOn(QuestionsStore.prototype, "put").mockImplementationOnce(() => { throw new Error("disk full"); });
    const ack = vi.fn(async () => {});
    await f.app.views.get("qtext_submit")({ ack, body: { user: { id: "UOWNER" } }, view });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: "errors" }));
    write.mockRestore(); ack.mockClear();
    await drain(f.app.views.get("qtext_submit")({ ack, body: { user: { id: "UOWNER" } }, view }));
    expect(ack).toHaveBeenCalledWith();
    expect(new QuestionsStore(`${f.root}/questions.json`).get(req.id)?.answers[0]).toEqual(["custom"]);
  });

  it("offers a custom-answer text box alongside native form choices and forwards what the owner types", async () => {
    await boot();
    const req = normalizeForm({ id: "frm_custom", sessionID: request.sessionID, title: "Choose a framework", fields: [
      { key: "framework", type: "string", custom: true, options: [{ label: "React", value: "react" }] },
    ] });
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    const button = postedButton("qtext"); expect(button.text.text).toBe("Type your own answer");
    await clickButton(button);
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    expect(modal.blocks.find((b: any) => b.type === "input").element).toMatchObject({ type: "plain_text_input", multiline: true });
    const ack = vi.fn(async () => {});
    await drain(f.app.views.get("qtext_submit")({ ack, body: { user: { id: "UOWNER" } }, view: {
      private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "Svelte instead" } } } },
    } }));
    expect(ack).toHaveBeenCalledWith();
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, req.id, [["Svelte instead"]], { request: req });
  });

  it("preserves selected native values when a custom multiselect answer is typed", async () => {
    await boot();
    const req = normalizeForm({ id: "frm_custom_multi", sessionID: request.sessionID, title: "Features", fields: [
      { key: "features", type: "multiselect", custom: true, options: [{ label: "TypeScript", value: "ts" }] },
    ] });
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    await drain(clickQuestion()); await clickButton(postedButton("qtext"));
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    await drain(f.app.views.get("qtext_submit")({ ack: vi.fn(async () => {}), body: { user: { id: "UOWNER" } }, view: {
      private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "Accessibility" } } } },
    } }));
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, req.id, [["ts", "Accessibility"]], { request: req });
  });

  it("prefills an editable single-answer modal with the saved draft", async () => {
    await boot();
    const req = { ...request, questions: [{ ...request.questions[0]!, custom: true }, { ...request.questions[0]!, header: "Second" }] };
    f.pool.onEvent(f.root, "question.asked", req); await vi.advanceTimersByTimeAsync(1_100);
    f.reply.mockRejectedValueOnce(Object.assign(new Error("native validation rejected"), { _tag: "FormInvalidAnswerError" }));
    await drain(clickQuestion()); await drain(clickButton(postedButton("question_1_0")));
    await drain(clickButton(postedButton("qedit"))); await clickButton(postedButton("qtext"));
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    expect(modal.blocks.find((b: any) => b.type === "input").element.initial_value).toBe("A");
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it.each(["nonowner", "wrong thread", "watch-only", "legacy token"])("rejects a question action with %s", async reason => {
    await boot(); f.pool.onEvent(f.root, "question.asked", request); await vi.advanceTimersByTimeAsync(1_100);
    const button = { ...postedButton("question_0_0") };
    if (reason === "legacy token") { const value = JSON.parse(button.value); delete value.g; button.value = JSON.stringify(value); }
    if (reason === "watch-only") state.setThread(THREAD_KEY, { ...state.getThread(THREAD_KEY)!, watchOnly: true });
    const respond = await drain(clickButton(button, "C", reason === "nonowner" ? "OTHER" : "UOWNER", reason === "wrong thread" ? slackTs() : ROOT_TS));
    expect(f.reply).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
  });

  it("routes scheduled approvals with durable run authority, not an invented owner timestamp", async () => {
    vi.spyOn(ReportRunner.prototype, "tick").mockResolvedValue(undefined);
    const schedules = new ScheduleStore(`${f.root}/schedules.json`, () => NOW);
    const job = schedules.createJob({ name: "Private report", projectDir: f.root, prompt: "Read source files",
      schedule: { time: "18:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] }, destination: { kind: "dm" }, timeoutMs: 900_000 });
    const run = schedules.claim(job.id, NOW, true);
    schedules.updateRun(run.id, r => { r.status = "running"; r.sessionId = request.sessionID; r.context = { channel: "DOWNER", ts: ROOT_TS }; });
    state.deleteThread(THREAD_KEY);
    state.setThread(`DOWNER:${ROOT_TS}`, { sessionId: request.sessionID, projectDir: f.root, verbose: "off",
      scheduledRunId: run.id, createdAt: NOW, lastUsedAt: NOW, historyCursorTs: ROOT_TS });
    await boot();
    const readPermission = { ...permission, type: "read", title: "Read sensitive report source" };
    f.permissions.mockResolvedValue([readPermission]);
    f.pool.onEvent(f.root, "permission.asked", readPermission);
    await vi.advanceTimersByTimeAsync(1_100);
    const record = new PermissionDeliveryStore().list()[0]!;
    expect(record.ownerActivityTs).toBeUndefined();
    expect(record.thread.status).toBe("delivered");
    const posts = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args);
    expect(posts.every((args: any) => args.channel === "DOWNER")).toBe(true);
    await drain(clickButton(postedButton("perm_once", "DOWNER"), "DOWNER"));
    expect(f.permReply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, request.sessionID, permission.id, "once");
  });

  it.each(["dm", "channel"] as const)("delivers a saved %s report without a new prompt or fabricated owner receipt", async destination => {
    const schedules = new ScheduleStore(`${f.root}/schedules.json`, () => NOW);
    const job = schedules.createJob({ name: "Daily fixture report", projectDir: f.root,
      prompt: "Read fixture files and summarize", schedule: { time: "18:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] },
      destination: destination === "dm" ? { kind: "dm" } : { kind: "channel", channelId: "CREPORT" }, timeoutMs: 900_000 });
    const run = schedules.claim(job.id, NOW, true);
    schedules.updateRun(run.id, r => { r.sessionId = request.sessionID; r.status = "ready"; r.output = "**Finished report**";
      r.context = { channel: "DOWNER", ts: ROOT_TS }; });
    state.deleteThread(THREAD_KEY);
    state.setThread(`DOWNER:${ROOT_TS}`, { sessionId: request.sessionID, projectDir: f.root,
      scheduledRunId: run.id, verbose: "off", createdAt: NOW, lastUsedAt: NOW, historyCursorTs: ROOT_TS });
    await boot();
    await vi.advanceTimersByTimeAsync(2_200);
    const saved = new ScheduleStore(`${f.root}/schedules.json`, () => NOW).run(run.id)!;
    expect(saved.status).toBe("delivered");
    expect(f.pool.entry.client.session.promptAsync).not.toHaveBeenCalled();
    const key = `${saved.delivery!.channel}:${saved.delivery!.ts}`;
    expect(state.getThread(key)).toMatchObject({ sessionId: request.sessionID, verbose: "off" });
    expect(state.getThread(key)?.scheduledRunId).toBeUndefined();
    expect(state.getReceipt(key, ROOT_TS)).toBeUndefined();
    if (destination === "channel") {
      const report = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args).find((args: any) => args.channel === "CREPORT");
      expect(report.text).toContain("*Finished report*");
      expect(report.thread_ts).toBeUndefined();
      expect(state.getThread(`DOWNER:${ROOT_TS}`)).toBeNull();
    } else expect(f.app.client.chat.update.mock.calls.some(([args]: any[]) => args.channel === "DOWNER" && args.ts === ROOT_TS && args.text.includes("*Finished report*"))).toBe(true);
  });

  it("adopts a response-lost report post from bot-authored evidence without reposting", async () => {
    const schedules = new ScheduleStore(`${f.root}/schedules.json`, () => NOW);
    const job = schedules.createJob({ name: "Delivery fixture", projectDir: f.root, prompt: "Read source files",
      schedule: { time: "18:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] },
      destination: { kind: "channel", channelId: "CREPORT" }, timeoutMs: 900_000 });
    const run = schedules.claim(job.id, NOW, true);
    schedules.updateRun(run.id, r => { r.status = "ready"; r.sessionId = request.sessionID; r.output = "Saved report";
      r.context = { channel: "DOWNER", ts: ROOT_TS }; });
    state.deleteThread(THREAD_KEY);
    state.setThread(`DOWNER:${ROOT_TS}`, { sessionId: request.sessionID, projectDir: f.root, verbose: "off",
      scheduledRunId: run.id, createdAt: NOW, lastUsedAt: NOW, historyCursorTs: ROOT_TS });
    f.appStart.mockImplementationOnce(async () => {
      f.app.client.chat.postMessage.mockRejectedValueOnce(new Error("response lost after Slack accepted report"));
    });
    await boot();
    await vi.advanceTimersByTimeAsync(2_200);
    expect(new ScheduleStore(`${f.root}/schedules.json`, () => NOW).run(run.id)?.status).toBe("uncertain");
    f.app.client.conversations.history.mockResolvedValue({ messages: [
      { user: "UOTHER", text: `slackoc-schedule-report:${run.id}`, ts: `${NOW / 1000}.000120` },
      { user: "UBOT", text: `Saved report\nslackoc-schedule-report:${run.id}`, ts: `${NOW / 1000}.000123` },
    ] });
    await vi.advanceTimersByTimeAsync(5_000);
    const recovered = new ScheduleStore(`${f.root}/schedules.json`, () => NOW).run(run.id)!;
    expect(recovered.status).toBe("delivered");
    expect(recovered.delivery?.ts).toBe(`${NOW / 1000}.000123`);
    expect(f.app.client.chat.postMessage.mock.calls.filter(([args]: any[]) => args.channel === "CREPORT")).toHaveLength(1);
    expect(f.pool.entry.client.session.promptAsync).not.toHaveBeenCalled();
    expect(state.getThread(`CREPORT:${recovered.delivery!.ts}`)?.sessionId).toBe(request.sessionID);
  });

  it("passes native permission/question cards through Slack's duplicate-action contract, which rejects the old cards", async () => {
    await boot();
    await postPermission();
    f.pool.onEvent(f.root, "question.asked", { ...request, questions: [{ ...request.questions[0]!,
      options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }] });
    await vi.advanceTimersByTimeAsync(1_100);
    const posts = [...f.app.client.chat.postMessage.mock.calls];
    expect(posts).toHaveLength(4);
    for (const result of f.app.client.chat.postMessage.mock.results) {
      await expect(result.value).resolves.toEqual({ ts: expect.stringMatching(/^\d+\.\d{6}$/) });
    }
    expect(new PermissionDeliveryStore().list()[0]).toMatchObject({
      thread: { status: "delivered" }, dm: { status: "delivered" },
    });
    for (const legacyId of ["perm", "question"]) {
      const [post] = posts.find(([args]: any[]) => args.channel === "C" && args.blocks.some((b: any) =>
        b.elements?.some((element: any) => element.action_id.startsWith(`${legacyId}_`))))!;
      const legacy = structuredClone(post);
      const options = legacy.blocks.find((b: any) => b.elements?.length > 1).elements;
      for (const button of options) button.action_id = legacyId;
      await expect(f.app.client.chat.postMessage(legacy)).rejects.toMatchObject({ data: { error: "invalid_blocks" } });
    }
    await drain(clickButton(postedButton("question_0_1")));
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, request.id, [["B"]], { request: expect.objectContaining({ id: request.id }) });
    await drain(clickButton(postedButton("perm_once")));
    expect(f.permReply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, permission.sessionID, permission.id, "once");
  });

  it("falls back from invalid_blocks to executable text without sending a blocks property", async () => {
    await boot();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (Object.hasOwn(args, "blocks")) throw rejected("invalid_blocks");
      return slackPost(args);
    });
    await postPermission();
    await vi.advanceTimersByTimeAsync(1_100);
    const posts = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args);
    expect(posts).toHaveLength(4);
    for (const channel of ["C", "DOWNER"]) {
      const attempts = posts.filter((args: any) => args.channel === channel);
      expect(attempts[0]).toHaveProperty("blocks");
      expect(attempts[1]).not.toHaveProperty("blocks");
      expect(attempts[1].text).toContain(`\\permission ${permission.id} once`);
    }
    const fallback = posts.find((args: any) => args.channel === "C" && !Object.hasOwn(args, "blocks"));
    const command = /`(\\permission [^`]+ once)`/.exec(fallback.text)![1]!;
    await drain(textPermission("C", "UOWNER", command));
    expect(f.permReply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, permission.sessionID, permission.id, "once");
    expect(new PermissionDeliveryStore().list()[0]).toMatchObject({ response: { status: "resolved", confirmed: true } });
  });

  it("delivers an actionable owner DM independently while the permission thread post is stalled", async () => {
    await boot();
    const thread = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "C" ? thread.promise : slackPost(args));
    await postPermission();
    expect(new PermissionDeliveryStore().list()[0]).toMatchObject({ thread: { attempts: 1 }, dm: { status: "delivered" } });
    await drain(clickButton(postedButton("perm_once", "DOWNER"), "DOWNER"));
    expect(f.permReply).toHaveBeenCalledOnce();
    thread.resolve({ ts: THREAD_CARD_TS });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C", ts: THREAD_CARD_TS, text: expect.stringContaining("Approved (once)"),
    }));
  });

  it.each(["C", "DOWNER"])("routes owner text permission in %s through the shared responder", async channel => {
    await boot();
    await postPermission();
    f.pool.ensure.mockClear();
    f.pool.acquire.mockClear();
    await drain(textPermission(channel, "UOWNER", `\\permission ${permission.id} deny`));
    expect(f.permReply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, permission.sessionID, permission.id, "reject");
    const duplicate = await drain(clickButton(postedButton("perm_once")));
    expect(duplicate).not.toHaveBeenCalled();
    expect(f.permReply).toHaveBeenCalledOnce();
    expect(f.pool.ensure).not.toHaveBeenCalled();
    expect(f.pool.acquire).not.toHaveBeenCalled();
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: "C", text: expect.stringContaining("Denied") }));
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ channel: "DOWNER", text: expect.stringContaining("Denied") }));
  });

  it.each(["click", "text"])("sends only one upstream response when %s races the other permission input", async first => {
    await boot();
    await postPermission();
    const preflight = deferred<Array<typeof permission>>();
    f.permissions.mockClear().mockReturnValue(preflight.promise);
    const click = () => clickButton(postedButton("perm_once"));
    const text = () => textPermission("DOWNER");
    const winning = (first === "click" ? click : text)();
    await vi.advanceTimersByTimeAsync(0);
    const losing = (first === "click" ? text : click)();
    await drain(losing);
    expect(f.permissions).toHaveBeenCalledOnce();
    expect(f.permReply).not.toHaveBeenCalled();
    preflight.resolve([permission]);
    await drain(winning);
    expect(f.permReply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, permission.sessionID, permission.id, "once");
    expect(new PermissionDeliveryStore().list()[0]).toMatchObject({ response: { status: "resolved", confirmed: true } });
  });

  it("rejects nonowner click and text before permission preflight", async () => {
    await boot();
    await postPermission();
    f.permissions.mockClear();
    const response = await clickButton(postedButton("perm_once"), "C", "UOTHER");
    await textPermission("C", "UOTHER");
    await textPermission("DOWNER", "UOTHER");
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Only the paired owner") }));
    expect(f.permissions).not.toHaveBeenCalled();
    expect(f.permReply).not.toHaveBeenCalled();
  });

  it.each(["wrong thread", "stale generation", "rebound session", "no current request"])("does not approve a permission with %s", async reason => {
    await boot();
    await postPermission();
    const button = { ...postedButton("perm_once") };
    if (reason === "stale generation") {
      const value = JSON.parse(button.value);
      button.value = JSON.stringify({ ...value, g: value.g + 1 });
    }
    if (reason === "rebound session") state.setThread(THREAD_KEY, { ...state.getThread(THREAD_KEY)!, sessionId: "replacement-session" });
    if (reason === "no current request") f.permissions.mockResolvedValue([]);
    f.pool.ensure.mockClear();
    f.pool.acquire.mockClear();
    const response = await drain(clickButton(button, "C", "UOWNER", reason === "wrong thread" ? slackTs() : ROOT_TS));
    expect(f.permReply).not.toHaveBeenCalled();
    expect(f.pool.ensure).not.toHaveBeenCalled();
    expect(f.pool.acquire).not.toHaveBeenCalled();
    if (reason === "no current request") {
      expect(new PermissionDeliveryStore().list()[0]).toMatchObject({ response: { status: "resolved", confirmed: false } });
    } else expect(response).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
  });

  it("delivers a question through both Slack destinations and forwards its answer", async () => {
    await boot();
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    const answer = clickQuestion();
    await vi.advanceTimersByTimeAsync(1_100);
    await answer;
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, request.id, [["A"]], { request });
    expect(f.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "DOWNER", blocks: expect.any(Array) }));
  });

  it("allows answering a delivered thread ask while its DM mirror is delayed", async () => {
    await boot();
    const dm = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : { ts: THREAD_CARD_TS });
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C", blocks: expect.any(Array) }));
    const answering = clickQuestion();
    await vi.advanceTimersByTimeAsync(1_100);
    const response = await answering;
    dm.resolve({ ts: DM_CARD_TS });
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
    f.app.client.chat.postMessage.mockClear().mockImplementation(slackPost);
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
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : { ts: THREAD_CARD_TS });
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    dm.resolve({ ts: DM_CARD_TS });
    await vi.advanceTimersByTimeAsync(0);
    close.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves permission copies, including a DM that finishes after the owner answers", async () => {
    await boot();
    const waiting = waitingSpy();
    const dm = deferred<{ ts: string }>();
    f.permissions.mockResolvedValue([permission]);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => args.channel === "DOWNER" ? dm.promise : { ts: THREAD_CARD_TS });
    f.pool.onEvent(f.root, "permission.asked", permission);
    await vi.advanceTimersByTimeAsync(1_100);
    f.permReply.mockImplementation(async () => {
      f.pool.onEvent(f.root, "permission.replied", { requestID: permission.id, sessionID: request.sessionID });
    });
    const answering = clickButton(postedButton("perm_once"));
    await vi.advanceTimersByTimeAsync(2_200);
    await answering;
    dm.resolve({ ts: DM_CARD_TS });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.permReply).toHaveBeenCalledOnce();
    expect(waiting).toHaveBeenLastCalledWith(permission.id, "permission", false);
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: "DOWNER", ts: DM_CARD_TS, text: expect.stringContaining("Approved (once)"),
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

  it("does not retry an uncertain question destination or duplicate a delivered copy", async () => {
    await boot();
    f.app.client.conversations.replies.mockResolvedValue({ messages: [], has_more: true });
    f.questions.mockResolvedValue([request]);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C") throw Object.assign(new Error("post timed out"), { name: "TimeoutError" });
      return { ts: DM_CARD_TS };
    });
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    for (let i = 0; i < 4; i++) {
      f.pool.onReady(f.root, f.pool.entry.baseUrl);
      await vi.advanceTimersByTimeAsync(2_200);
    }
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("bounds definitely rejected question posts to three attempts per destination", async () => {
    await boot();
    f.questions.mockResolvedValue([request]);
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C") throw rejected();
      return { ts: DM_CARD_TS };
    });
    f.pool.onEvent(f.root, "question.asked", request);
    await vi.advanceTimersByTimeAsync(1_100);
    for (let i = 0; i < 5; i++) {
      f.pool.onReady(f.root, f.pool.entry.baseUrl);
      await vi.advanceTimersByTimeAsync(2_200);
    }
    const calls = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args.channel);
    expect(calls.filter((channel: string) => channel === "C")).toHaveLength(3);
    expect(calls.filter((channel: string) => channel === "DOWNER")).toHaveLength(1);
  });

  it.each(["C", "DOWNER"])("adopts an uncertain permission copy from %s history instead of duplicating it", async channel => {
    await boot();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === channel) throw new Error("connection lost after Slack accepted the post");
      return slackPost(args);
    });
    await postPermission();
    const attempted = f.app.client.chat.postMessage.mock.calls.find(([args]: any[]) => args.channel === channel)[0];
    const history = channel === "C" ? f.app.client.conversations.replies : f.app.client.conversations.history;
    history.mockResolvedValue({ messages: [
      { user: "UOTHER", text: attempted.text, ts: slackTs() },
      { user: "UBOT", text: attempted.text, ts: channel === "C" ? THREAD_CARD_TS : DM_CARD_TS },
    ] });
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.receiver.client.emit("connected");
    await vi.advanceTimersByTimeAsync(3_300);
    expect(f.app.client.chat.postMessage).toHaveBeenCalledTimes(2);
    const record = new PermissionDeliveryStore().list()[0]!;
    expect(record[channel === "C" ? "thread" : "dm"]).toMatchObject({
      status: "delivered", channel, ts: channel === "C" ? THREAD_CARD_TS : DM_CARD_TS,
    });
    f.app.client.chat.postMessage.mockImplementation(slackPost);
    await drain(textPermission(channel));
    expect(f.permReply).toHaveBeenCalledOnce();
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel, ts: channel === "C" ? THREAD_CARD_TS : DM_CARD_TS, text: expect.stringContaining("Approved (once)"),
    }));
  });

  it("recovers an uncertain permission destination as text when history proves the card absent", async () => {
    await boot();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C") throw new Error("post timed out");
      return slackPost(args);
    });
    await postPermission();
    f.app.client.chat.postMessage.mockImplementation(slackPost);
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.receiver.client.emit("connected");
    await vi.advanceTimersByTimeAsync(3_300);
    const posts = f.app.client.chat.postMessage.mock.calls.map(([args]: any[]) => args);
    expect(posts.filter((args: any) => args.channel === "DOWNER")).toHaveLength(1);
    const thread = posts.filter((args: any) => args.channel === "C");
    expect(thread).toHaveLength(2);
    expect(thread[1]).not.toHaveProperty("blocks");
    expect(thread[1].text).toContain(`\\permission ${permission.id} once`);
    expect(new PermissionDeliveryStore().list()[0]).toMatchObject({ thread: { status: "delivered", format: "text" } });
    await drain(textPermission());
    expect(f.permReply).toHaveBeenCalledOnce();
  });

  it("backs off permission access errors but reconnect can recover beyond three rejected attempts", async () => {
    await boot();
    f.app.client.chat.postMessage.mockImplementation(async (args: any) => {
      if (args.channel === "C") throw rejected();
      return slackPost(args);
    });
    await postPermission();
    const threadPosts = () => f.app.client.chat.postMessage.mock.calls.filter(([args]: any[]) => args.channel === "C");
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(0);
    expect(threadPosts()).toHaveLength(1); // Ordinary recovery honors the initial backoff.
    for (const delay of [2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      f.pool.onReady(f.root, f.pool.entry.baseUrl);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(threadPosts()).toHaveLength(4);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(0);
    expect(threadPosts()).toHaveLength(4);
    f.app.client.chat.postMessage.mockImplementation(slackPost);
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.receiver.client.emit("connected");
    await vi.advanceTimersByTimeAsync(2_200);
    expect(threadPosts()).toHaveLength(5);
    expect(f.app.client.chat.postMessage.mock.calls.filter(([args]: any[]) => args.channel === "DOWNER")).toHaveLength(1);
    expect(new PermissionDeliveryStore().list()[0]).toMatchObject({ thread: { status: "delivered", attempts: 5 } });
  });

  it("periodically recovers interactions while catch-up is still awaiting delayed acceptance reconciliation", async () => {
    const ts = slackTs();
    expect(state.claimMessage(THREAD_KEY, ts)).toBe("claimed");
    state.associatePrompt(THREAD_KEY, ts, { projectDir: f.root, sessionId: request.sessionID, messageId: "msg-unconfirmed" });
    state.settleMessage(THREAD_KEY, ts, "uncertain");
    state.recordRunOutcome(THREAD_KEY, request.sessionID, "active", [ts]);
    const transcript = deferred<never[]>();
    f.messages.mockReturnValueOnce(transcript.promise);
    await boot();
    expect(f.messages).toHaveBeenCalledOnce();
    expect(f.app.client.conversations.replies).not.toHaveBeenCalled();
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.permissions.mockResolvedValue([permission]);
    f.questions.mockResolvedValue([request]);
    f.permissions.mockClear();
    f.questions.mockClear();
    await vi.advanceTimersByTimeAsync(32_200);
    expect(f.permissions).toHaveBeenCalled();
    expect(f.questions).toHaveBeenCalled();
    expect(postedButton("perm_once", "DOWNER")).toBeDefined();
    expect(postedButton("question_0_0", "DOWNER")).toBeDefined();
    expect(f.app.client.conversations.replies).not.toHaveBeenCalled();
    expect(state.getReceipt(THREAD_KEY, ts)?.disposition).toBe("uncertain");
    transcript.resolve([]);
    await vi.advanceTimersByTimeAsync(2_200);
    expect(f.app.client.conversations.replies).toHaveBeenCalled();
    expect(postedButton("perm_once")).toBeDefined();
  });

  it.each(["accepted", "uncertain"] as const)("retires expired pending runs and %s receipts without spawning their project or posting notices", async disposition => {
    const oldDir = resolve(f.root, "old-project");
    const oldTs = `${NOW / 1000 - 4 * 24 * 60 * 60}.000001`;
    const oldRoot = `${NOW / 1000 - 4 * 24 * 60 * 60 - 60}.000000`;
    const key = `COLD:${oldRoot}`;
    // Persist the original input at its original clock, then boot four days later.
    vi.setSystemTime(NOW - 4 * 24 * 60 * 60 * 1000);
    state.setThread(key, { sessionId: "old-session", projectDir: oldDir, verbose: "on",
      createdAt: Date.now(), lastUsedAt: Date.now(), lastSeenTs: oldRoot,
      pendingRun: { userMsgTs: [oldTs] } });
    expect(state.claimMessage(key, oldTs)).toBe("claimed");
    state.associatePrompt(key, oldTs, { projectDir: oldDir, sessionId: "old-session", messageId: "msg-old" });
    state.settleMessage(key, oldTs, disposition);
    state.markThreadSeen(key, oldTs);
    vi.setSystemTime(NOW);
    await boot();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.pool.ensure).toHaveBeenCalledExactlyOnceWith(f.root); // Only normal launch-project prewarm.
    expect(f.pool.acquire).not.toHaveBeenCalled();
    expect(f.pool.entry.client.session.promptAsync).not.toHaveBeenCalled();
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalled();
    expect(f.app.client.chat.update).not.toHaveBeenCalled();
    expect(state.getThread(key)?.pendingRun).toBeUndefined();
    expect(state.getReceipt(key, oldTs)?.recoveryDecision).toMatchObject({ decision: "expired" });
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
    expect(f.questions).toHaveBeenCalledTimes(2);
    expect(f.questions).toHaveBeenLastCalledWith(f.pool.entry.client);
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("does not let a fresh diagnostic command revive an old permission or canceled uncertain receipt", async () => {
    const oldTs = `${NOW / 1000 - 4 * 24 * 60 * 60}.000001`;
    vi.setSystemTime(NOW - 4 * 24 * 60 * 60 * 1000);
    state.setThread(THREAD_KEY, { ...state.getThread(THREAD_KEY)!, lastSeenTs: oldTs });
    state.recordRunOutcome(THREAD_KEY, request.sessionID, "interrupted", [oldTs]);
    vi.setSystemTime(NOW);
    const input = slackTs();
    state.claimMessage(THREAD_KEY, input);
    state.associatePrompt(THREAD_KEY, input, { projectDir: f.root, sessionId: request.sessionID, messageId: "msg-canceled" });
    state.settleMessage(THREAD_KEY, input, "uncertain");
    state.cancelRecovery(THREAD_KEY, slackTs());
    state.markThreadSeen(THREAD_KEY, slackTs()); // Equivalent owner observation from a recent \status.
    await boot();
    f.permissions.mockResolvedValue([permission]);
    f.pool.list.mockReturnValue([f.pool.entry]);
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(32_200);
    expect(f.pool.acquire).not.toHaveBeenCalled();
    expect(f.app.client.chat.postMessage).not.toHaveBeenCalled();
    expect(new PermissionDeliveryStore().list()).toEqual([]);
  });

  it("retries failed permission result updates without sending the decision twice", async () => {
    await boot();
    await postPermission();
    f.app.client.chat.update.mockRejectedValue(rejected());
    await drain(clickButton(postedButton("perm_reject")));
    expect(f.permReply).toHaveBeenCalledOnce();
    expect(new PermissionDeliveryStore().list()[0]?.response).toMatchObject({ status: "resolved", choice: "reject" });
    f.app.client.chat.update.mockClear().mockResolvedValue({});
    f.permissions.mockResolvedValue([]);
    f.pool.list.mockReturnValue([f.pool.entry]);
    await vi.advanceTimersByTimeAsync(32_200);
    expect(f.app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Denied") }));
    const saved = new PermissionDeliveryStore().list()[0]!;
    expect(saved.thread.collapsed).toBe(true);
    expect(saved.dm.collapsed).toBe(true);
    expect(f.permReply).toHaveBeenCalledOnce();
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
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, request.id, [["A"]], { request });
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
    await clickButton(postedButton("question_0_0"));
    await clickButton(postedButton("question_0_1"));
    f.pool.onReady(f.root, f.pool.entry.baseUrl);
    await vi.advanceTimersByTimeAsync(0);
    await drain(clickButton(postedButton("qsubmit")), 4_400);
    expect(f.reply).not.toHaveBeenCalled();
    await clickButton(postedButton("qtext"));
    const modal = f.app.client.views.open.mock.calls[0][0].view;
    const submitting = f.app.views.get("qtext_submit")({
      ack: async () => {}, body: { user: { id: "UOWNER" } }, respond: vi.fn(),
      view: { private_metadata: modal.private_metadata, state: { values: { qtext_input: { qtext_field: { value: "custom answer" } } } } },
    });
    await vi.advanceTimersByTimeAsync(2_200);
    await submitting;
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(f.pool.entry.client, req.id, [["A", "B"], ["custom answer"]], { request: req });
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
      channel: "CNEW", ts: slackTs(), channel_type: "im", user: "UOWNER", text: "",
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

  it("admits warm follow-ups while Slack status delivery is stalled", async () => {
    await boot();
    const post = deferred<{ ts: string }>();
    f.app.client.chat.postMessage.mockReturnValue(post.promise);
    const send = () => f.app.events.get("message")({ event: {
      channel: "C", thread_ts: ROOT_TS, ts: slackTs(), user: "UOWNER", text: "hello",
    } });
    const first = send();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pool.entry.client.session.promptAsync).toHaveBeenCalledOnce();
    const followup = send();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pool.entry.client.session.promptAsync).toHaveBeenCalledTimes(2);
    post.resolve({ ts: THREAD_CARD_TS });
    await vi.advanceTimersByTimeAsync(2_200);
    await Promise.all([first, followup]);
    expect(f.app.client.chat.postMessage.mock.calls.filter(([a]: any[]) => a.text === "⏳ OpenCode is on it…")).toHaveLength(1);
  });

  it("does not label a newly accepted live prompt as an interrupted prior-boot run", async () => {
    f.appStart.mockImplementation(async () => {
      await f.app.events.get("message")({ event: {
        channel: "C", thread_ts: ROOT_TS, ts: slackTs(), user: "UOWNER", text: "fresh prompt",
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
