import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionCreateInput, SessionInfo } from "@opencode/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OCClient, OcPart } from "../src/opencode/api.js";
import type { sessionMessages } from "../src/opencode/client.js";
import type { PoolEntry } from "../src/opencode/server.js";
import { hasReportPermissions, MAX_REPORT_BYTES, reportPermissions, ReportRunner, type ReportRunnerOptions } from "../src/schedules/runner.js";
import { Scheduler } from "../src/schedules/scheduler.js";
import { isTerminalRun, ScheduleStore, type NewScheduleJob, type ScheduleRun } from "../src/schedules/store.js";

const dir = resolve("test/.fixtures/schedule-runner");
const projectDir = resolve(dir, "project");
const path = resolve(dir, "schedules.json");
const NOW = Date.parse("2026-10-03T08:00:00Z");
type Transcript = Awaited<ReturnType<typeof sessionMessages>>;

beforeEach(() => {
  mkdirSync(projectDir, { recursive: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in runner tests"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function user(run: ScheduleRun): Transcript[number] {
  return { info: { id: run.messageId!, sessionID: run.sessionId!, role: "user", time: { created: run.startedAt } }, parts: [] };
}
function answer(run: ScheduleRun, text = "Final report"): Transcript[number] {
  return { info: { id: "msg_answer", sessionID: run.sessionId!, role: "assistant", parentID: run.messageId,
    finish: "stop", time: { created: run.startedAt + 1, completed: run.startedAt + 2 } },
    parts: [{ id: "text_1", type: "text", text }] };
}

function setup(jobOverrides: Partial<NewScheduleJob> = {}, optionOverrides: Partial<ReportRunnerOptions> = {}) {
  let time = NOW;
  const now = () => time;
  let store = new ScheduleStore(path, now);
  const job = store.createJob({ name: "Morning report", projectDir, prompt: "Summarize the project", timeoutMs: 60_000,
    schedule: { time: "09:00", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6] }, destination: { kind: "dm" }, ...jobOverrides });
  const run = store.claim(job.id, NOW);
  let transcript: Transcript = [];
  const session = { id: "ses_report", location: { directory: projectDir }, permissions: reportPermissions(), time: { created: NOW, updated: NOW } } as SessionInfo;
  const create = vi.fn(async (_input: SessionCreateInput, _options?: { signal?: AbortSignal }): Promise<SessionInfo> => session);
  const nativeGet = vi.fn(async () => session);
  const permissions = vi.fn(async () => ({ data: [] as Array<Record<string, unknown>> }));
  const questions = vi.fn(async () => ({ data: [] as Array<Record<string, unknown>> }));
  const messages = vi.fn(async () => transcript);
  const get = vi.fn(async () => ({ id: "ses_report", directory: projectDir, title: "Report", time: session.time }));
  const status = vi.fn(async (): Promise<unknown> => ({}));
  const abort = vi.fn(async () => {});
  const fallbackCreate = vi.fn(async () => { throw new Error("Permissive sessionCreate must never be used"); });
  const submit = vi.fn(async (input: { path: { id: string }; body: { messageID: string; parts: OcPart[] }; signal?: AbortSignal }) => {
    const latest = store.run(run.id)!;
    expect(latest.status).toBe("submitting");
    expect(latest.sessionId).toBe(input.path.id);
    expect(latest.messageId).toBe(input.body.messageID);
    expect(latest.context).toEqual({ channel: "D_OWNER", ts: "100.000001" });
    transcript = [user(latest)];
  });
  const client = { v2: { session: { create, get: nativeGet }, permission: { request: { list: permissions } }, form: { list: questions } }, directory: projectDir,
    session: { create: fallbackCreate, get, status, messages, abort, promptAsync: submit } } as unknown as OCClient;
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ entry: { client } as PoolEntry, release }));
  const ensureContext = vi.fn<ReportRunnerOptions["ensureContext"]>(async r => {
    expect(r.sessionId).toBe("ses_report");
    expect(r.messageId).toBeUndefined();
    return r.context ?? { channel: "D_OWNER", ts: "100.000001" };
  });
  const deliver = vi.fn<ReportRunnerOptions["deliver"]>(async r => {
    expect(store.run(r.id)).toMatchObject({ status: "delivering", output: r.output });
    return r.snapshot.destination.kind === "dm" ? r.context! : { channel: r.snapshot.destination.channelId, ts: "200.000001" };
  });
  const findDelivery = vi.fn<ReportRunnerOptions["findDelivery"]>(async () => undefined);
  const notify = vi.fn<ReportRunnerOptions["notify"]>(async r => { expect(store.run(r.id)!.notified).toBe(true); });
  const onDelivered = vi.fn<NonNullable<ReportRunnerOptions["onDelivered"]>>(async r => {
    expect(store.run(r.id)).toMatchObject({ status: "delivered", delivery: r.delivery, deliveryBindingPending: true });
  });
  const options: ReportRunnerOptions = { store, pool: { acquire }, now, ensureContext, deliver, findDelivery, notify, onDelivered, ...optionOverrides };
  let runner = new ReportRunner(options);
  return {
    get store() { return store; }, get runner() { return runner; }, options, job, run, client, session,
    create, nativeGet, permissions, questions, messages, get, status, abort, fallbackCreate, submit, acquire, release,
    ensureContext, deliver, findDelivery, notify, onDelivered, now,
    latest: () => store.run(run.id)!,
    tick: () => runner.tick(store.run(run.id)!),
    advance: (ms: number) => { time += ms; },
    transcript: (rows: Transcript) => { transcript = rows; },
    setRun: (change: (r: ScheduleRun) => void) => store.updateRun(run.id, change),
    restart: (overrides: Partial<ReportRunnerOptions> = {}) => {
      store = new ScheduleStore(path, now);
      Object.assign(options, overrides, { store });
      runner = new ReportRunner(options);
    },
    start: async () => { await runner.tick(store.run(run.id)!); await runner.tick(store.run(run.id)!); },
    ready: async () => {
      await runner.tick(store.run(run.id)!); await runner.tick(store.run(run.id)!);
      transcript = [user(store.run(run.id)!), answer(store.run(run.id)!)];
      await runner.tick(store.run(run.id)!);
      expect(store.run(run.id)!.status).toBe("ready");
    },
  };
}

describe("scheduled report native policy", () => {
  it("denies mutating, delegated, MCP, and unknown actions while asking for sensitive reads", () => {
    const match = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);
    const effect = (action: string, resource = "anything") => reportPermissions().filter(rule => match(rule.action, action) && match(rule.resource, resource)).at(-1)?.effect;
    for (const action of ["edit", "shell", "subagent", "execute", "skill", "write", "bash", "task", "notion_create", "unknown"]) expect(effect(action)).toBe("deny");
    for (const action of ["read", "glob", "grep", "webfetch", "websearch", "question"]) expect(effect(action)).toBe("allow");
    expect(effect("read", "/project/.env")).toBe("ask");
    expect(effect("read", "/project/.env.local")).toBe("ask");
    expect(effect("external_directory")).toBe("ask");
    expect(reportPermissions()[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  });

  it("refuses missing permissions and appended permissive overrides", () => {
    expect(hasReportPermissions(reportPermissions())).toBe(true);
    expect(hasReportPermissions(undefined)).toBe(false);
    expect(hasReportPermissions(reportPermissions().slice(1))).toBe(false);
    expect(hasReportPermissions([...reportPermissions(), { action: "*", resource: "*", effect: "allow" }])).toBe(false);
    const copy = reportPermissions(); copy[0]!.effect = "allow";
    expect(hasReportPermissions(copy)).toBe(false);
    expect(reportPermissions()[0]!.effect).toBe("deny");
  });

  it("sets location, agent/model and restrictive permissions natively, then verifies before context/prompt", async () => {
    const h = setup({ agent: "build", model: "provider/model#variant" });
    h.create.mockImplementation(async input => {
      expect(h.latest().status).toBe("creating");
      expect(input).toMatchObject({ location: { directory: projectDir }, agent: "build", model: { providerID: "provider", id: "model", variant: "variant" }, permissions: reportPermissions() });
      return h.session;
    });
    await h.tick();
    expect(h.latest()).toMatchObject({ status: "creating", sessionId: "ses_report" });
    expect(h.submit).not.toHaveBeenCalled();
    await h.tick();
    expect(h.latest().status).toBe("running");
    expect(h.latest().messageId).toMatch(/^msg_[0-9a-f]{12,}[0-9a-f]{14}$/);
    expect(h.nativeGet.mock.invocationCallOrder[0]).toBeLessThan(h.ensureContext.mock.invocationCallOrder[0]!);
    expect(h.ensureContext.mock.invocationCallOrder[0]).toBeLessThan(h.submit.mock.invocationCallOrder[0]!);
    expect(h.fallbackCreate).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("fails closed without the native V2 client, rather than using the compatibility session creator", async () => {
    const h = setup(); delete h.client.v2;
    await h.tick();
    expect(h.latest().status).toBe("failed");
    expect(h.latest().error).toContain("no permissive fallback");
    expect(h.fallbackCreate).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each(["permissions", "location", "identity"])("withholds prompts if attached %s cannot be verified", async fault => {
    const h = setup(); await h.tick();
    if (fault === "permissions") h.session.permissions = [{ action: "*", resource: "*", effect: "allow" }];
    if (fault === "location") h.session.location = { directory: resolve(dir, "elsewhere") };
    if (fault === "identity") h.session.id = "ses_foreign";
    await h.tick();
    expect(h.latest().status).toBe("failed");
    expect(h.ensureContext).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe("scheduled admission and recovery", () => {
  it("coalesces concurrent ticks and recovers a known session without creating another", async () => {
    const h = setup(); const pending = deferred<SessionInfo>(); h.create.mockReturnValue(pending.promise);
    const first = h.tick(); expect(h.tick()).toBe(first);
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    pending.resolve(h.session); await first;
    h.restart(); await h.tick();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("holds crash-after-creating-before-identity uncertainty without a new session", async () => {
    const h = setup(); h.setRun(r => { r.status = "creating"; }); h.restart();
    await h.tick(); await h.tick(); h.restart(); await h.tick();
    expect(h.latest()).toMatchObject({ status: "uncertain", notified: true });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("never repeats an uncertain native create after a lost response", async () => {
    const h = setup(); h.create.mockRejectedValue(new Error("response lost"));
    await h.tick(); h.restart(); await h.runner.tick(h.run); await h.tick();
    expect(h.latest().status).toBe("uncertain");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("retries idempotent context reconciliation for a known session without an admitted prompt", async () => {
    const h = setup();
    h.ensureContext.mockImplementationOnce(async r => {
      h.store.updateRun(r.id, current => { current.contextAttemptedAt = h.now(); });
      throw new Error("ambiguous context post; marker search found no proof");
    });
    await h.start();
    expect(h.latest()).toMatchObject({ status: "creating", contextAttemptedAt: NOW, sessionId: "ses_report" });
    expect(h.latest().messageId).toBeUndefined();
    h.setRun(r => { r.status = "uncertain"; }); h.restart();
    h.ensureContext.mockImplementation(async r => {
      expect(r.contextAttemptedAt).toBe(NOW);
      return { channel: "D_OWNER", ts: "100.000001" };
    });
    await h.tick();
    expect(h.latest().status).toBe("running");
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.ensureContext).toHaveBeenCalledTimes(2);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("restores an existing private binding through ensureContext before submitting", async () => {
    const h = setup(); await h.tick();
    h.setRun(r => { r.context = { channel: "D_OWNER", ts: "100.000001" }; });
    h.restart(); await h.tick();
    expect(h.ensureContext).toHaveBeenCalledWith(expect.objectContaining({ context: { channel: "D_OWNER", ts: "100.000001" } }));
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("persists the exact prompt ID before submission and recovers inbox admission without resubmitting", async () => {
    const h = setup();
    h.submit.mockImplementation(async input => {
      expect(h.latest()).toMatchObject({ status: "submitting", messageId: input.body.messageID });
      h.transcript([user(h.latest())]);
      throw new Error("HTTP admission response lost");
    });
    await h.start(); const messageId = h.latest().messageId;
    expect(h.latest().status).toBe("uncertain");
    h.restart(); await h.tick();
    expect(h.latest()).toMatchObject({ status: "running", messageId });
    h.transcript([user(h.latest()), answer(h.latest())]); await h.tick();
    expect(h.latest()).toMatchObject({ status: "ready", output: "Final report" });
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("never resubmits a persisted submitting ID when idle and transcript/inbox evidence is absent", async () => {
    const h = setup(); await h.tick();
    h.setRun(r => { r.messageId = "msg_claimed"; r.status = "submitting"; }); h.restart();
    h.notify.mockRejectedValue(new Error("notification response lost"));
    await h.tick(); await h.tick(); h.restart(); await h.tick();
    expect(h.latest()).toMatchObject({ status: "uncertain", notified: true });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
});

describe("scheduled completion proof", () => {
  it("recovers a missed completion event, saves final-only output, and delivers in a later bounded step", async () => {
    const h = setup(); await h.start();
    const final = answer(h.latest());
    final.parts.unshift({ id: "reasoning", type: "reasoning", text: "Private reasoning" }, { id: "tool", type: "tool", state: { status: "completed", output: "Private tool output" } });
    h.transcript([user(h.latest()), final]); h.restart(); await h.tick();
    expect(h.latest()).toMatchObject({ status: "ready", output: "Final report" });
    expect(h.deliver).not.toHaveBeenCalled();
    await h.tick();
    expect(h.latest()).toMatchObject({ status: "delivered", delivery: { channel: "D_OWNER", ts: "100.000001" } });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.onDelivered).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "user-only", "wrong-parent", "tool-call", "unknown-finish", "unfinished", "summary"])("does not accept idle %s transcript as completed output", async scenario => {
    const h = setup(); await h.start(); const final = answer(h.latest());
    if (scenario === "wrong-parent") final.info.parentID = "msg_foreign";
    if (scenario === "tool-call") final.info.finish = "tool-calls";
    if (scenario === "unknown-finish") final.info.finish = "unknown";
    if (scenario === "unfinished") delete final.info.time!.completed;
    if (scenario === "summary") final.info.summary = true;
    h.transcript(scenario === "empty" ? [] : scenario === "user-only" ? [user(h.latest())] : [user(h.latest()), final]);
    await h.tick();
    expect(h.latest().output).toBeUndefined();
    expect(h.latest().status).not.toBe("ready");
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("does not accept an assistant without the exact user/inbox identity", async () => {
    const h = setup(); await h.start(); h.transcript([answer(h.latest())]); await h.tick();
    expect(h.latest().status).toBe("uncertain");
    expect(h.latest().output).toBeUndefined();
  });

  it("allows missing parentID only for the sole exact preceding user prompt", async () => {
    const h = setup(); await h.start(); const final = answer(h.latest()); delete final.info.parentID;
    h.transcript([user(h.latest()), final]); await h.tick();
    expect(h.latest()).toMatchObject({ status: "ready", output: "Final report" });
  });

  it("withholds output if another user prompt appears in the owned session", async () => {
    const h = setup(); await h.start(); const foreign = user(h.latest()); foreign.info.id = "msg_foreign";
    h.transcript([user(h.latest()), foreign, answer(h.latest())]); await h.tick();
    expect(h.latest().status).toBe("failed");
    expect(h.latest().error).toContain("unrelated prompt");
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("requires all tool calls to be terminal, not just a completed assistant timestamp", async () => {
    const h = setup(); await h.start(); const final = answer(h.latest());
    final.parts.push({ id: "tool_1", type: "tool", state: { status: "running", output: "Never deliver this" } });
    h.transcript([user(h.latest()), final]); await h.tick(); expect(h.latest().status).toBe("running");
    final.parts.at(-1)!.state!.status = "completed"; await h.tick();
    expect(h.latest().output).toBe("Final report");
  });

  it.each(["permission", "question"])("marks a pending %s as waiting without final output", async kind => {
    const h = setup(); await h.start(); h.transcript([user(h.latest()), answer(h.latest())]);
    if (kind === "permission") h.permissions.mockResolvedValue({ data: [{ id: "per_1", sessionID: "ses_report", action: "external_directory", resources: ["/elsewhere"] }] });
    else h.questions.mockResolvedValue({ data: [{ id: "form_1", sessionID: "ses_report", fields: [] }] });
    await h.tick();
    expect(h.latest().status).toBe("waiting");
    expect(h.status).not.toHaveBeenCalled();
    expect(h.latest().output).toBeUndefined();
  });

  it("ignores pending interactions owned by other sessions", async () => {
    const h = setup(); await h.start(); h.transcript([user(h.latest()), answer(h.latest())]);
    h.permissions.mockResolvedValue({ data: [{ id: "per_foreign", sessionID: "ses_foreign", action: "read" }] });
    h.questions.mockResolvedValue({ data: [{ id: "form_foreign", sessionID: "ses_foreign", fields: [] }] });
    await h.tick(); expect(h.latest().status).toBe("ready");
  });

  it.each(["missing-session", "malformed-status", "busy"])("requires validated sessionIdle, refusing %s evidence", async fault => {
    const h = setup(); await h.start(); h.transcript([user(h.latest()), answer(h.latest())]);
    if (fault === "missing-session") h.get.mockResolvedValue({ id: "ses_foreign", directory: projectDir, title: "Report", time: h.session.time });
    if (fault === "malformed-status") h.status.mockResolvedValue([]);
    if (fault === "busy") h.status.mockResolvedValue({ ses_report: { type: "busy" } });
    await h.tick();
    expect(h.latest().status).toBe("running");
    expect(h.latest().output).toBeUndefined();
  });

  it("refreshes the transcript after the idle probe instead of using stale completion", async () => {
    const h = setup(); await h.start(); const unfinished = answer(h.latest()); unfinished.info.finish = "tool-calls";
    h.messages.mockResolvedValueOnce([user(h.latest()), answer(h.latest())]).mockResolvedValue([user(h.latest()), unfinished]);
    await h.tick(); expect(h.latest().status).toBe("running"); expect(h.latest().output).toBeUndefined();
  });

  it.each(["empty", "reasoning-only", "assistant-error", "finish-error"])("fails privately for %s final reports and notifies at most once", async fault => {
    const h = setup(); await h.start(); const final = answer(h.latest(), " ");
    if (fault === "reasoning-only") final.parts = [{ id: "reasoning", type: "reasoning", text: "Do not publish" }];
    if (fault === "assistant-error") final.info.error = { name: "ProviderError", data: { message: "Provider refused" } };
    if (fault === "finish-error") final.info.finish = "error";
    h.transcript([user(h.latest()), final]); await h.tick(); h.restart(); await h.tick();
    expect(h.latest()).toMatchObject({ status: "failed", notified: true });
    expect(h.latest().output).toBeUndefined();
    expect(h.deliver).not.toHaveBeenCalled(); expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("bounds saved output by UTF-8 bytes without leaking reasoning/tool text", async () => {
    const h = setup(); await h.start(); h.transcript([user(h.latest()), answer(h.latest(), "a" + "🦖".repeat(MAX_REPORT_BYTES))]);
    await h.tick(); expect(h.latest().status).toBe("ready");
    expect(Buffer.byteLength(h.latest().output!)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(h.latest().output).not.toContain("\uFFFD");
  });

  it("preserves a real replacement character while rejecting unsupported null text", async () => {
    const h = setup(); await h.start(); h.transcript([user(h.latest()), answer(h.latest(), "Valid text �")]);
    await h.tick(); expect(h.latest().output).toBe("Valid text �");
    h.setRun(r => { r.status = "running"; delete r.output; });
    h.transcript([user(h.latest()), answer(h.latest(), "Invalid\0text")]); await h.tick();
    expect(h.latest().status).toBe("failed"); expect(h.latest().output).toBeUndefined(); expect(h.deliver).not.toHaveBeenCalled();
  });
});

describe("saved report delivery", () => {
  it("reconciles a lost channel post by marker evidence, never blindly reposting or regenerating", async () => {
    const h = setup({ destination: { kind: "channel", channelId: "C_REPORT" } }); await h.ready();
    h.deliver.mockRejectedValue(new Error("accepted post, response lost")); await h.tick();
    expect(h.latest()).toMatchObject({ status: "uncertain", output: "Final report" });
    h.restart(); await h.tick(); await h.tick();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.latest().status).toBe("uncertain");
    h.findDelivery.mockResolvedValue({ channel: "C_REPORT", ts: "200.000001" }); await h.tick();
    expect(h.latest()).toMatchObject({ status: "delivered", delivery: { channel: "C_REPORT", ts: "200.000001" } });
    expect(h.create).toHaveBeenCalledTimes(1); expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.onDelivered).toHaveBeenCalledTimes(1);
  });

  it("reconciles an interrupted delivering state and leaves unavailable history uncertain", async () => {
    const h = setup(); await h.ready(); h.setRun(r => { r.status = "delivering"; }); h.restart();
    h.findDelivery.mockRejectedValueOnce(new Error("history unavailable")); await h.tick();
    expect(h.latest().status).toBe("delivering");
    await h.tick(); expect(h.latest().status).toBe("uncertain");
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("retries definite rejections from ready with bounded backoff and the same saved output", async () => {
    const h = setup(); await h.ready();
    h.deliver.mockRejectedValue({ code: "slack_webapi_platform_error", data: { ok: false, error: "not_in_channel" } });
    await h.tick(); expect(h.latest()).toMatchObject({ status: "ready", output: "Final report", notified: true });
    await h.tick(); expect(h.deliver).toHaveBeenCalledTimes(1);
    h.advance(2_000); await h.tick(); expect(h.deliver).toHaveBeenCalledTimes(2);
    h.advance(4_000); h.deliver.mockResolvedValue({ channel: "D_OWNER", ts: "100.000001" }); await h.tick();
    expect(h.latest().status).toBe("delivered");
    expect(h.notify).toHaveBeenCalledTimes(1); expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("stops retrying a permanent channel rejection after 5 attempts and tells the owner", async () => {
    const h = setup(); await h.ready();
    h.deliver.mockRejectedValue({ code: "slack_webapi_platform_error", data: { ok: false, error: "channel_not_found" } });
    for (let i = 0; i < 10; i++) { await h.tick(); h.advance(60_000); }
    expect(h.deliver).toHaveBeenCalledTimes(5);
    expect(h.latest()).toMatchObject({ status: "failed", output: "Final report" });
    expect(h.latest().error).toMatch(/rejected 5 times.*channel_not_found/);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("honors rate-limit Retry-After without adding transport retry loops", async () => {
    const h = setup(); await h.ready();
    h.deliver.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter: 30 });
    await h.tick(); h.advance(29_999); await h.tick(); expect(h.deliver).toHaveBeenCalledTimes(1);
    h.advance(1); await h.tick(); expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it("does not classify arbitrary platform errors or server errors as definitely rejected", async () => {
    const h = setup(); await h.ready(); h.deliver.mockRejectedValue({ code: "slack_webapi_platform_error", data: { ok: false, error: "internal_error" } });
    await h.tick(); await h.tick();
    expect(h.latest().status).toBe("uncertain"); expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("persists a confirmed post before binding and recovers binding failure without another post", async () => {
    const h = setup(); await h.ready(); h.onDelivered.mockRejectedValueOnce(new Error("binding store temporarily unavailable"));
    await h.tick(); expect(h.latest()).toMatchObject({ status: "delivered", deliveryBindingPending: true, delivery: { channel: "D_OWNER", ts: "100.000001" } });
    expect(isTerminalRun(h.latest())).toBe(false);
    h.restart(); await new Scheduler({ store: h.store, tickRun: r => h.runner.tick(r), now: h.now }).poll();
    expect(h.latest().status).toBe("delivered"); expect(isTerminalRun(h.latest())).toBe(true);
    expect(h.latest()).not.toHaveProperty("deliveryBindingPending");
    expect(h.deliver).toHaveBeenCalledTimes(1); expect(h.findDelivery).not.toHaveBeenCalled();
    expect(h.onDelivered).toHaveBeenCalledTimes(2);
  });

  it("recovers crash-after-delivered-before-hook solely through the durable pending flag", async () => {
    const h = setup(); await h.ready(); const pending = deferred<void>(); h.onDelivered.mockReturnValueOnce(pending.promise);
    const work = h.tick(); await vi.waitFor(() => expect(h.onDelivered).toHaveBeenCalled());
    expect(h.latest()).toMatchObject({ status: "delivered", deliveryBindingPending: true });
    pending.reject(new Error("simulated crash boundary")); await work; h.restart(); await h.tick();
    expect(h.latest()).toMatchObject({ status: "delivered", delivery: { channel: "D_OWNER", ts: "100.000001" } });
    expect(h.latest()).not.toHaveProperty("deliveryBindingPending");
    expect(h.deliver).toHaveBeenCalledTimes(1); expect(h.submit).toHaveBeenCalledTimes(1); expect(h.onDelivered).toHaveBeenCalledTimes(2);
  });

  it("keeps saved reports deliverable after the generation deadline without running the model again", async () => {
    const h = setup(); await h.ready(); h.advance(120_000); await h.tick();
    expect(h.latest().status).toBe("delivered"); expect(h.submit).toHaveBeenCalledTimes(1); expect(h.abort).not.toHaveBeenCalled();
  });
});

describe("scheduled cancellation, shutdown, and deadlines", () => {
  it("persists cancellation before interrupt and retains a late created session without prompting", async () => {
    const h = setup(); const pending = deferred<SessionInfo>(); h.create.mockReturnValue(pending.promise);
    const work = h.tick(); await vi.waitFor(() => expect(h.create).toHaveBeenCalled());
    await h.runner.cancel(h.run.id); expect(h.latest().status).toBe("canceled");
    h.abort.mockImplementation(async () => { expect(h.latest().status).toBe("canceled"); });
    pending.resolve(h.session); await work;
    expect(h.latest()).toMatchObject({ status: "canceled", sessionId: "ses_report" });
    expect(h.abort).toHaveBeenCalledTimes(1); expect(h.submit).not.toHaveBeenCalled(); expect(h.ensureContext).not.toHaveBeenCalled();
  });

  it("does not submit after cancellation during context reconciliation", async () => {
    const h = setup(); await h.tick(); const pending = deferred<{ channel: string; ts: string }>();
    h.ensureContext.mockReturnValue(pending.promise); const work = h.tick(); await vi.waitFor(() => expect(h.ensureContext).toHaveBeenCalled());
    await h.runner.cancel(h.run.id); pending.resolve({ channel: "D_OWNER", ts: "100.000001" }); await work;
    expect(h.latest().status).toBe("canceled"); expect(h.submit).not.toHaveBeenCalled(); expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it("does not save or deliver late completion after cancellation during transcript polling", async () => {
    const h = setup(); await h.start(); const pending = deferred<Transcript>(); h.messages.mockReturnValue(pending.promise);
    const work = h.tick(); await vi.waitFor(() => expect(h.messages).toHaveBeenCalled());
    await h.runner.cancel(h.run.id); pending.resolve([user(h.latest()), answer(h.latest())]); await work;
    expect(h.latest().status).toBe("canceled"); expect(h.latest().output).toBeUndefined(); expect(h.deliver).not.toHaveBeenCalled();
  });

  it("does not adopt a late Slack delivery or bind a report after cancellation", async () => {
    const h = setup(); await h.ready(); const pending = deferred<{ channel: string; ts: string }>(); h.deliver.mockReturnValue(pending.promise);
    const work = h.tick(); await vi.waitFor(() => expect(h.deliver).toHaveBeenCalled());
    await h.runner.cancel(h.run.id); pending.resolve({ channel: "D_OWNER", ts: "100.000001" }); await work;
    expect(h.latest().status).toBe("canceled"); expect(h.latest().delivery).toBeUndefined(); expect(h.onDelivered).not.toHaveBeenCalled();
  });

  it("keeps cancellation durable when acquiring the owned-session interrupt handle fails", async () => {
    const h = setup(); await h.start(); h.acquire.mockRejectedValue(new Error("service unavailable"));
    await h.runner.cancel(h.run.id); await h.runner.cancel(h.run.id); await h.tick();
    expect(h.latest().status).toBe("canceled"); expect(h.abort).not.toHaveBeenCalled(); expect(h.deliver).not.toHaveBeenCalled();
  });

  it("shutdown prevents new work while preserving a late session identity for recovery", async () => {
    const stop = new AbortController(); const h = setup({}, { signal: stop.signal });
    const pending = deferred<SessionInfo>(); h.create.mockReturnValue(pending.promise); const work = h.tick();
    await vi.waitFor(() => expect(h.create).toHaveBeenCalled()); stop.abort(); pending.resolve(h.session); await work;
    expect(h.latest()).toMatchObject({ status: "creating", sessionId: "ses_report" });
    expect(h.submit).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
    h.restart({ signal: undefined }); await h.tick(); expect(h.latest().status).toBe("running"); expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("persists a failed hard deadline before interrupting or notifying an admitted session", async () => {
    const h = setup(); await h.start(); h.advance(60_000);
    h.abort.mockImplementation(async () => { expect(h.latest()).toMatchObject({ status: "failed", output: undefined }); });
    await h.tick(); await h.tick();
    expect(h.latest().status).toBe("failed"); expect(h.abort).toHaveBeenCalledTimes(1); expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.deliver).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledTimes(h.acquire.mock.calls.length);
  });

  it("holds unknown admission at deadline, interrupts once, and never publishes a later answer", async () => {
    const h = setup(); await h.tick(); h.setRun(r => { r.status = "submitting"; r.messageId = "msg_unknown"; }); h.advance(60_000);
    await h.tick(); h.restart(); await h.tick();
    expect(h.latest().status).toBe("uncertain"); expect(h.latest().error).toContain("deadline");
    expect(h.abort).toHaveBeenCalledTimes(1); expect(h.submit).not.toHaveBeenCalled();
    h.transcript([user(h.latest()), answer(h.latest())]); await h.tick();
    expect(h.latest().status).toBe("failed"); expect(h.latest().output).toBeUndefined(); expect(h.deliver).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("checks deadline after awaited completion before persisting any output", async () => {
    const h = setup(); await h.start(); const pending = deferred<Transcript>(); h.messages.mockReturnValueOnce(pending.promise);
    const work = h.tick(); await vi.waitFor(() => expect(h.messages).toHaveBeenCalled());
    h.advance(60_000); pending.resolve([user(h.latest()), answer(h.latest())]); await work;
    expect(h.latest().status).toBe("failed"); expect(h.latest().output).toBeUndefined(); expect(h.deliver).not.toHaveBeenCalled();
  });

  it("checks deadline after awaited context creation before prompt admission", async () => {
    const h = setup(); await h.tick(); const pending = deferred<{ channel: string; ts: string }>(); h.ensureContext.mockReturnValue(pending.promise);
    const work = h.tick(); await vi.waitFor(() => expect(h.ensureContext).toHaveBeenCalled()); h.advance(60_000);
    pending.resolve({ channel: "D_OWNER", ts: "100.000001" }); await work;
    expect(h.latest().status).toBe("failed"); expect(h.submit).not.toHaveBeenCalled(); expect(h.abort).toHaveBeenCalledTimes(1);
  });
});
