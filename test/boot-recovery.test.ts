import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OCClient, OcMessageInfo, OcPart, OcPermission, OcQuestionRequest } from "../src/opencode/api.js";
import type { PoolEntry } from "../src/opencode/server.js";
import { pendingPermissions, pendingQuestions } from "../src/opencode/client.js";
import { StateStore } from "../src/state.js";
import { recoverInterruptedRuns } from "../src/slack/boot-recovery.js";
import { MAX_REPLAY_AGE_MS, timestampFromMs } from "../src/slack/recovery-policy.js";
import { deleteView, getView, type RenderDeps } from "../src/slack/render.js";
import { logErr } from "../src/log.js";

vi.mock("../src/opencode/client.js", async original => ({
  ...await original<typeof import("../src/opencode/client.js")>(),
  pendingPermissions: vi.fn(), pendingQuestions: vi.fn(),
}));
vi.mock("../src/log.js", () => ({ logErr: vi.fn() }));

const root = `${import.meta.dirname}/.fixtures/boot-recovery`;
const key = "C:100.000000";
const sessionId = "ses_boot";
type Message = { info: OcMessageInfo; parts: OcPart[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(options: { age?: number; evidence?: "accepted" | "uncertain" | "legacy"; statusTs?: string } = {}) {
  let stopping = false;
  const now = Date.now();
  const ts = timestampFromMs(now - (options.age ?? 10_000));
  // Write receipts at original arrival time, including those already expired at boot.
  vi.setSystemTime(now - (options.age ?? 10_000));
  const state = new StateStore(`${root}/state.json`);
  state.setThread(key, { sessionId, projectDir: root, verbose: "on", createdAt: Date.now(), lastUsedAt: Date.now(),
    historyCursorTs: timestampFromMs(Date.now() - 60_000), lastSeenTs: ts,
    pendingRun: { userMsgTs: [ts], statusTs: options.statusTs } });
  function associate(timestamp: string, messageId: string, disposition = options.evidence ?? "uncertain") {
    expect(state.claimMessage(key, timestamp)).toBe("claimed");
    state.associatePrompt(key, timestamp, { projectDir: root, sessionId, messageId });
    state.settleMessage(key, timestamp, disposition === "accepted" ? "accepted" : "uncertain");
  }
  if (options.evidence !== "legacy") associate(ts, "msg_exact");
  vi.setSystemTime(now);
  const user = (id = "msg_exact", created = Date.now() - 9_000): Message => ({
    info: { id, sessionID: sessionId, role: "user", time: { created } }, parts: [],
  });
  const answer = (overrides: Partial<OcMessageInfo> = {}, parts: OcPart[] = []): Message => ({
    info: { id: "msg_answer", sessionID: sessionId, role: "assistant", parentID: "msg_exact", finish: "stop",
      time: { created: Date.now() - 8_000, completed: Date.now() - 7_000 }, ...overrides }, parts,
  });
  let transcript = [user()];
  const client = { session: {
    get: vi.fn(async () => ({ data: { id: sessionId } })),
    status: vi.fn(async (): Promise<{ data: unknown }> => ({ data: { [sessionId]: { type: "busy" } } })),
    messages: vi.fn(async () => ({ data: transcript })),
    promptAsync: vi.fn(async () => { throw new Error("boot must never submit a prompt"); }),
    create: vi.fn(async () => { throw new Error("boot must never create a session"); }),
  } };
  const entry: PoolEntry = { dir: root, url: "http://boot.invalid", baseUrl: "http://boot.invalid", status: "ready",
    client: client as unknown as OCClient, ready: Promise.resolve(), sseAbort: null, proc: null, lastEventAt: Date.now() };
  const release = vi.fn();
  const pool = { acquire: vi.fn(async () => ({ entry, release })), get: vi.fn((): PoolEntry | null => entry) };
  const render: RenderDeps = {
    post: vi.fn(async () => ({ ts: "posted-status" })), update: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}), unreact: vi.fn(async () => {}), upload: vi.fn(async () => {}), dm: vi.fn(async () => ({ ts: "dm" })),
  };
  const deps = { state, pool, render, isStopping: () => stopping };
  return { ts, state, pool, render, client, entry, release, deps, associate, user, answer,
    run: () => recoverInterruptedRuns(deps), stop: () => { stopping = true; },
    messages: (messages: Message[]) => { transcript = messages; },
    idle: () => client.session.status.mockResolvedValue({ data: {} }),
  };
}

function tool(status: string, callID = "call_exact"): OcPart {
  return { id: `part_${callID}`, type: "tool", callID, tool: "bash", state: { status } };
}
function noSlack(render: RenderDeps) {
  for (const method of Object.values(render)) expect(method).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
  vi.mocked(pendingQuestions).mockReset().mockResolvedValue([]);
  vi.mocked(pendingPermissions).mockReset().mockResolvedValue([]);
  vi.mocked(logErr).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network access"); }));
});
afterEach(() => {
  deleteView(sessionId);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("boot eligibility and retained evidence", () => {
  it("silently archives expired runs without acquiring a server or posting a notice", async () => {
    const f = fixture({ age: MAX_REPLAY_AGE_MS + 1, statusTs: "frozen" });
    const result = await f.run();
    expect(result).toMatchObject({ expired: 1, restored: 0, notices: 0 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    noSlack(f.render);
    expect(f.state.getThread(key)?.pendingRun).toBeUndefined();
    expect(f.state.getThread(key)?.recovery).toMatchObject({ lastRun: { outcome: "interrupted", userMsgTs: [f.ts] }, lastDecision: { decision: "expired" } });
    expect(f.state.getReceipt(key, f.ts)).toMatchObject({ disposition: "uncertain", submission: { messageId: "msg_exact" }, recoveryDecision: { decision: "expired" } });
  });

  it.each(["stopped", "hushed", "watch", "rebound"])("silently retires %s input before acquisition", async kind => {
    const f = fixture({ evidence: "accepted", statusTs: "frozen" });
    if (kind === "stopped") f.state.cancelRecovery(key, timestampFromMs(Date.now()));
    else {
      const thread = f.state.getThread(key)!;
      f.state.setThread(key, { ...thread, ...(kind === "hushed" ? { hushed: true } : kind === "watch" ? { watchOnly: true } : { sessionId: "ses_replaced" }) });
    }
    expect(await f.run()).toMatchObject({ canceled: 1, notices: 0 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    noSlack(f.render);
    expect(f.state.getThread(key)?.pendingRun).toBeUndefined();
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe("accepted");
  });

  it("does nothing when the bridge is stopping", async () => {
    const f = fixture();
    f.stop();
    expect(await f.run()).toMatchObject({ skipped: 1, notices: 0 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    noSlack(f.render);
    expect(f.state.getThread(key)?.pendingRun?.userMsgTs).toEqual([f.ts]);
  });

  it("does not let recent owner activity revive an expired pending prompt", async () => {
    const f = fixture({ age: MAX_REPLAY_AGE_MS + 1 });
    f.state.markThreadSeen(key, timestampFromMs(Date.now()));
    expect(await f.run()).toMatchObject({ expired: 1 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    noSlack(f.render);
  });

  it("preserves invalid timestamp uncertainty without acquisition or a notice", async () => {
    const f = fixture({ evidence: "legacy" });
    f.state.setThread(key, { ...f.state.getThread(key)!, pendingRun: { userMsgTs: ["invalid"] } });
    expect(await f.run()).toMatchObject({ held: 1, notices: 0 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    noSlack(f.render);
    expect(f.state.getThread(key)?.pendingRun?.userMsgTs).toEqual(["invalid"]);
    expect(f.state.getThread(key)?.recovery?.lastDecision?.reason).toBe("invalid_timestamp");
  });

  it("holds fresh legacy uncertainty with diagnostics and only one durable notice, without waking a project", async () => {
    const f = fixture({ evidence: "legacy" });
    expect(await f.run()).toMatchObject({ held: 1, notices: 1 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    expect(f.state.getThread(key)?.pendingRun?.userMsgTs).toEqual([f.ts]);
    expect(f.state.recoveryStatus()).toMatchObject({ held: 1, threads: [{ reason: "pending_acceptance_uncertain" }] });
    expect(f.state.getThread(key)?.recovery?.lastRun?.outcome).toBe("interrupted");
    const reloaded = new StateStore(`${root}/state.json`);
    expect(await recoverInterruptedRuns({ ...f.deps, state: reloaded })).toMatchObject({ held: 1, notices: 0 });
    expect(f.render.post).toHaveBeenCalledTimes(1);
  });

  it("does not wake legacy accepted receipts lacking exact submission associations", async () => {
    const f = fixture({ evidence: "legacy" });
    f.state.claimMessage(key, f.ts);
    f.state.settleMessage(key, f.ts, "accepted");
    expect(await f.run()).toMatchObject({ held: 1 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
  });

  it("retains every pending timestamp and exact acceptance diagnostic when another submission is uncertain", async () => {
    const f = fixture();
    const later = timestampFromMs(Date.now() - 5_000);
    f.associate(later, "msg_later");
    f.state.setThread(key, { ...f.state.getThread(key)!, pendingRun: { userMsgTs: [f.ts, later] } });
    expect(await f.run()).toMatchObject({ held: 1, restored: 0 });
    expect(f.state.getReceipt(key, f.ts)).toMatchObject({ disposition: "accepted", submission: { messageId: "msg_exact" } });
    expect(f.state.getReceipt(key, later)).toMatchObject({ disposition: "uncertain", submission: { messageId: "msg_later" } });
    expect(f.state.getThread(key)?.pendingRun?.userMsgTs).toEqual([f.ts, later]);
    expect(f.state.getThread(key)?.recovery?.lastRun?.messageIds).toEqual(["msg_exact", "msg_later"]);
  });
});

describe("exact accepted run observation", () => {
  it("permits exact evidence at the inclusive 72-hour boundary", async () => {
    const f = fixture({ age: MAX_REPLAY_AGE_MS });
    expect(await f.run()).toMatchObject({ restored: 1, expired: 0 });
    expect(f.pool.acquire).toHaveBeenCalledTimes(1);
  });

  it("reconciles uncertain acceptance and restores a busy run without a new prompt or historical output", async () => {
    const f = fixture();
    f.messages([f.user("older", Date.now() - 30_000), f.answer({ parentID: "older", time: { created: Date.now() - 20_000, completed: Date.now() - 19_000 } },
      [{ id: "old-text", type: "text", text: "NEVER REPLAY THIS" }]), f.user()]);
    const reconcile = vi.spyOn(f.state, "reconcilePromptAcceptance");
    const result = await f.run();
    expect(result).toMatchObject({ restored: 1, notices: 0, errors: 0 });
    expect(reconcile).toHaveBeenCalledWith(root, expect.objectContaining({ id: "msg_exact", role: "user" }));
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe("accepted");
    expect(getView(sessionId)?.isActive).toBe(true);
    expect(getView(sessionId)?.currentRunElapsedMs).toBe(9_000);
    expect(f.state.getThread(key)?.recovery?.lastRun).toMatchObject({ outcome: "active", messageIds: ["msg_exact"] });
    expect(f.client.session.promptAsync).not.toHaveBeenCalled();
    expect(f.client.session.create).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(f.render.post).mock.calls)).not.toContain("NEVER REPLAY");
    expect(f.render.post).toHaveBeenCalledTimes(1); // Observation status only.
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["question", "permission"])("restores an idle session with an exactly correlated pending %s", async kind => {
    const f = fixture({ statusTs: "frozen" });
    f.idle();
    f.messages([f.user(), f.answer({ finish: "tool-calls" }, [tool("running")])]);
    const question: OcQuestionRequest = { id: "q", sessionID: sessionId, tool: { messageID: "msg_answer", callID: "call_exact" }, questions: [] };
    const permission: OcPermission = { id: "p", sessionID: sessionId, messageID: "msg_answer", callID: "call_exact", type: "bash", title: "Test" };
    if (kind === "question") vi.mocked(pendingQuestions).mockResolvedValue([question]);
    else vi.mocked(pendingPermissions).mockResolvedValue([permission]);
    expect(await f.run()).toMatchObject({ restored: 1, notices: 0 });
    expect(getView(sessionId)?.isActive).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.render.update).toHaveBeenCalledWith("C", "frozen", expect.stringContaining(kind === "question" ? "Waiting for your answer" : "Waiting for permission"));
    expect(f.client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated busy turn as evidence for the pending prompt", async () => {
    const f = fixture();
    f.messages([f.user(), f.answer(), f.user("unrelated", Date.now() - 1_000)]);
    expect(await f.run()).toMatchObject({ held: 1, restored: 0 });
    expect(getView(sessionId)).toBeUndefined();
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe("accepted");
    expect(f.state.getThread(key)?.recovery?.lastDecision?.reason).toBe("newest_turn_not_correlated");
  });

  it("holds an idle interaction with no exact association instead of reviving a session by ID alone", async () => {
    const f = fixture();
    f.idle();
    f.messages([f.user(), f.answer()]);
    vi.mocked(pendingQuestions).mockResolvedValue([{ id: "q", sessionID: sessionId, questions: [] }]);
    expect(await f.run()).toMatchObject({ held: 1, completed: 0, restored: 0 });
    expect(f.state.getThread(key)?.pendingRun).toBeDefined();
  });

  it.each(["wrong session", "assistant ID", "missing time"])("requires exact user metadata: %s", async kind => {
    const f = fixture();
    const message = f.user();
    if (kind === "wrong session") message.info.sessionID = "ses_other";
    if (kind === "assistant ID") message.info.role = "assistant";
    if (kind === "missing time") delete message.info.time;
    f.messages([message]);
    expect(await f.run()).toMatchObject({ held: 1, restored: 0 });
    expect(getView(sessionId)).toBeUndefined();
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe(kind === "missing time" ? "accepted" : "uncertain");
    expect(f.state.getThread(key)?.pendingRun).toBeDefined();
  });
});

describe("completion is distinct from acceptance", () => {
  it("records exact completed correlation and removes only the stale status, without replaying the answer", async () => {
    const f = fixture({ statusTs: "frozen" });
    f.idle();
    f.messages([f.user(), f.answer({}, [{ id: "answer", type: "text", text: "Already delivered" }])]);
    expect(await f.run()).toMatchObject({ completed: 1, notices: 0, restored: 0 });
    expect(f.state.getThread(key)?.pendingRun).toBeUndefined();
    expect(f.state.getThread(key)?.recovery?.lastRun).toMatchObject({ outcome: "completed", messageIds: ["msg_exact"] });
    expect(f.render.delete).toHaveBeenCalledWith("C", "frozen");
    expect(f.render.post).not.toHaveBeenCalled();
    expect(f.render.update).not.toHaveBeenCalled();
    expect(getView(sessionId)).toBeUndefined();
  });

  it.each(["tool-calls", "unknown", undefined])("does not call an intermediate %s finish completed", async finish => {
    const f = fixture({ statusTs: "frozen" });
    f.idle();
    f.messages([f.user(), f.answer({ finish }, [tool("completed")])]);
    expect(await f.run()).toMatchObject({ interrupted: 1, completed: 0, notices: 1 });
    expect(f.state.getThread(key)?.recovery?.lastRun?.outcome).toBe("interrupted");
    expect(f.state.getThread(key)?.pendingRun).toBeUndefined();
    expect(f.render.update).toHaveBeenCalledWith("C", "frozen", expect.stringContaining("was interrupted"));
  });

  it.each(["pending", "running"])("rejects completion with a %s tool", async status => {
    const f = fixture();
    f.idle();
    f.messages([f.user(), f.answer({}, [tool(status)])]);
    expect(await f.run()).toMatchObject({ interrupted: 1, completed: 0 });
  });

  it("uses the newest transcript, not the completed snapshot from before the status probe", async () => {
    const f = fixture();
    f.idle();
    f.client.session.messages.mockResolvedValueOnce({ data: [f.user(), f.answer()] });
    f.messages([f.user(), f.answer(), f.answer({ id: "new_step", finish: undefined, time: { created: Date.now() - 1_000 } })]);
    expect(await f.run()).toMatchObject({ interrupted: 1, completed: 0 });
  });

  it("does not complete multiple pending prompts from one older final response", async () => {
    const f = fixture();
    const later = timestampFromMs(Date.now() - 5_000);
    f.associate(later, "msg_later");
    f.state.setThread(key, { ...f.state.getThread(key)!, pendingRun: { userMsgTs: [f.ts, later] } });
    f.idle();
    f.messages([f.user(), f.answer(), f.user("msg_later", Date.now() - 4_000)]);
    expect(await f.run()).toMatchObject({ interrupted: 1, completed: 0 });
    expect(f.state.getThread(key)?.recovery?.lastRun?.userMsgTs).toEqual([f.ts, later]);
  });

  it("completes a multi-prompt batch only with terminal evidence for every prompt", async () => {
    const f = fixture();
    const later = timestampFromMs(Date.now() - 5_000);
    f.associate(later, "msg_later");
    f.state.setThread(key, { ...f.state.getThread(key)!, pendingRun: { userMsgTs: [f.ts, later] } });
    f.idle();
    f.messages([f.user(), f.answer(), f.user("msg_later", Date.now() - 4_000),
      f.answer({ id: "later_answer", parentID: "msg_later", time: { created: Date.now() - 3_000, completed: Date.now() - 2_000 } })]);
    expect(await f.run()).toMatchObject({ completed: 1, interrupted: 0 });
    expect(f.state.getThread(key)?.recovery?.lastRun).toMatchObject({ outcome: "completed", userMsgTs: [f.ts, later], messageIds: ["msg_exact", "msg_later"] });
    noSlack(f.render);
  });

  it("does not complete the whole batch when only its newest prompt has an answer", async () => {
    const f = fixture();
    const later = timestampFromMs(Date.now() - 5_000);
    f.associate(later, "msg_later");
    f.state.setThread(key, { ...f.state.getThread(key)!, pendingRun: { userMsgTs: [f.ts, later] } });
    f.idle();
    f.messages([f.user(), f.user("msg_later", Date.now() - 4_000),
      f.answer({ id: "later_answer", parentID: "msg_later", time: { created: Date.now() - 3_000, completed: Date.now() - 2_000 } })]);
    expect(await f.run()).toMatchObject({ interrupted: 1, completed: 0 });
  });
});

describe("await boundaries and failures", () => {
  it.each(["acquire", "transcript", "status", "questions", "permissions", "latest transcript"])("abandons a changed generation during %s without Slack or stale writes", async stage => {
    const f = fixture();
    const wait = deferred<void>();
    const changed = () => { f.state.cancelRecovery(key, timestampFromMs(Date.now()), true); };
    if (stage === "acquire") f.pool.acquire.mockImplementationOnce(async () => { await wait.promise; return { entry: f.entry, release: f.release }; });
    else if (stage === "transcript") f.client.session.messages.mockImplementationOnce(async () => { await wait.promise; return { data: [f.user()] }; });
    else if (stage === "status") f.client.session.status.mockImplementationOnce(async () => { await wait.promise; return { data: {} }; });
    else if (stage === "questions") vi.mocked(pendingQuestions).mockImplementationOnce(async () => { await wait.promise; return []; });
    else if (stage === "permissions") vi.mocked(pendingPermissions).mockImplementationOnce(async () => { await wait.promise; return []; });
    else f.client.session.messages.mockResolvedValueOnce({ data: [f.user()] }).mockImplementationOnce(async () => { await wait.promise; return { data: [f.user()] }; });
    const running = f.run();
    // Drain promises only, without firing renderer/watchdog timers.
    await vi.advanceTimersByTimeAsync(0);
    changed();
    const afterChange = f.state.getThread(key);
    wait.resolve();
    expect(await running).toMatchObject({ skipped: 1, restored: 0, notices: 0 });
    expect(f.state.getThread(key)).toEqual(afterChange);
    noSlack(f.render);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("retires a run that expires during acquisition without querying or notifying", async () => {
    const f = fixture({ age: MAX_REPLAY_AGE_MS });
    f.pool.acquire.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 1);
      return { entry: f.entry, release: f.release };
    });
    expect(await f.run()).toMatchObject({ expired: 1, notices: 0 });
    noSlack(f.render);
    expect(f.client.session.messages).not.toHaveBeenCalled();
    expect(f.state.getThread(key)?.pendingRun).toBeUndefined();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("abandons evidence from a replaced server identity", async () => {
    const f = fixture();
    f.client.session.messages.mockImplementationOnce(async () => {
      f.pool.get.mockReturnValue({ ...f.entry });
      return { data: [f.user()] };
    });
    expect(await f.run()).toMatchObject({ skipped: 1, restored: 0 });
    noSlack(f.render);
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe("uncertain");
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("abandons evidence when a newer accepted prompt overtakes the snapshot while awaiting", async () => {
    const f = fixture();
    f.client.session.messages.mockImplementationOnce(async () => {
      f.associate(timestampFromMs(Date.now() - 1000), "newer_prompt", "accepted");
      return { data: [f.user()] };
    });
    expect(await f.run()).toMatchObject({ skipped: 1, restored: 0 });
    noSlack(f.render);
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe("uncertain");
  });

  it("does not acquire an overtaken pending prompt in the first place", async () => {
    const f = fixture();
    f.associate(timestampFromMs(Date.now() - 1000), "newer_prompt", "accepted");
    expect(await f.run()).toMatchObject({ held: 1, restored: 0 });
    expect(f.pool.acquire).not.toHaveBeenCalled();
    expect(f.state.getThread(key)?.recovery?.lastDecision?.reason).toBe("overtaken_by_accepted_prompt");
  });

  it("halts further reads and delivery when shutdown starts during transcript inspection", async () => {
    const f = fixture();
    f.client.session.messages.mockImplementationOnce(async () => { f.stop(); return { data: [f.user()] }; });
    expect(await f.run()).toMatchObject({ skipped: 1, restored: 0 });
    expect(f.client.session.status).not.toHaveBeenCalled();
    expect(pendingQuestions).not.toHaveBeenCalled();
    expect(pendingPermissions).not.toHaveBeenCalled();
    noSlack(f.render);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("preserves acceptance when a later server query fails and logs the failure", async () => {
    const f = fixture();
    f.client.session.status.mockRejectedValueOnce(new Error("offline"));
    expect(await f.run()).toMatchObject({ held: 1, errors: 1, notices: 1 });
    expect(f.state.getReceipt(key, f.ts)).toMatchObject({ disposition: "accepted", submission: { messageId: "msg_exact" } });
    expect(f.state.getThread(key)?.pendingRun).toBeDefined();
    expect(logErr).toHaveBeenCalledWith(expect.stringContaining("offline"));
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("logs failed acquisition and uncertain Slack delivery without unhandled retries", async () => {
    const f = fixture();
    f.pool.acquire.mockRejectedValue(new Error("cannot start"));
    vi.mocked(f.render.post).mockRejectedValue(new Error("delivery timeout"));
    expect(await f.run()).toMatchObject({ held: 1, errors: 2, notices: 0 });
    expect(f.state.getReceipt(key, f.ts)?.disposition).toBe("uncertain");
    expect(logErr).toHaveBeenCalledTimes(2);
    expect(await f.run()).toMatchObject({ held: 1, errors: 1, notices: 0 });
    expect(f.render.post).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an interruption notice after the same held run was restored and interrupted again", async () => {
    const f = fixture();
    f.client.session.status.mockRejectedValueOnce(new Error("offline"));
    expect(await f.run()).toMatchObject({ held: 1, notices: 1 });
    expect(await f.run()).toMatchObject({ restored: 1, notices: 0 });
    deleteView(sessionId); // Simulate losing only the in-memory observer at a later boot.
    f.idle();
    expect(await f.run()).toMatchObject({ interrupted: 1, notices: 0 });
    expect(vi.mocked(f.render.post).mock.calls.filter(call => call[2].startsWith(":warning:"))).toHaveLength(1);
    expect(f.render.update).not.toHaveBeenCalled();
  });

  it("stops observation if shutdown begins while its Slack status is posting", async () => {
    const f = fixture();
    vi.mocked(f.render.post).mockImplementationOnce(async () => { f.stop(); return { ts: "late-status" }; });
    expect(await f.run()).toMatchObject({ skipped: 1, restored: 0 });
    expect(getView(sessionId)).toBeUndefined();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
