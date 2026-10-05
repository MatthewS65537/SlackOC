import type { OcMessageInfo } from "../opencode/api.js";
import { pendingPermissions, pendingQuestions, sessionIdle, sessionMessages } from "../opencode/client.js";
import type { RequestLease, ServerPool } from "../opencode/server.js";
import { logErr } from "../log.js";
import { canonicalDir } from "../paths.js";
import type { MessageReceipt, StateStore, ThreadState } from "../state.js";
import { compareTs, replayAge, type RecoveryDecision } from "./recovery-policy.js";
import { deleteView, errorMessage, getView, SessionView, type RenderDeps } from "./render.js";

export interface BootRecoveryDeps {
  state: StateStore;
  pool: Pick<ServerPool, "acquire" | "get">;
  render: RenderDeps;
  isStopping: () => boolean;
}

type Outcome = "restored" | "completed" | "interrupted" | "held" | "expired" | "canceled" | "skipped";
/** Outcome counts are per snapshotted thread; errors and notices are additional counters. */
export type BootRecoveryCounts = Record<Outcome | "errors" | "notices", number>;
type Transcript = Awaited<ReturnType<typeof sessionMessages>>;

function sameRun(thread: ThreadState, snapshot: ThreadState): boolean {
  return thread.sessionId === snapshot.sessionId && canonicalDir(thread.projectDir) === canonicalDir(snapshot.projectDir)
    && thread.recovery?.bindingGeneration === snapshot.recovery?.bindingGeneration
    && thread.recovery?.intentVersion === snapshot.recovery?.intentVersion;
}

function exactReceipt(receipt: MessageReceipt | undefined, key: string, thread: ThreadState): receipt is MessageReceipt & { submission: NonNullable<MessageReceipt["submission"]> } {
  return !!receipt?.submission?.messageId && receipt.threadKey === key
    && receipt.submission.sessionId === thread.sessionId
    && canonicalDir(receipt.submission.projectDir) === canonicalDir(thread.projectDir)
    && (receipt.generation === undefined || receipt.generation === thread.recovery?.bindingGeneration);
}

function pendingDecision(state: StateStore, key: string, thread: ThreadState, ts: string): RecoveryDecision {
  const age = replayAge(ts, state.now());
  if (age.decision !== "recover") return age;
  const receipt = state.getReceipt(key, ts);
  const boundary = state.cancellationThrough(key);
  const last = thread.recovery?.lastRun;
  if (thread.hushed || thread.watchOnly || (boundary && compareTs(ts, boundary) <= 0)
    || (last?.outcome === "stopped" && last.userMsgTs.includes(ts))) return { decision: "canceled", reason: "owner_canceled" };
  if (last?.userMsgTs.includes(ts) && (last.sessionId !== thread.sessionId || last.generation !== thread.recovery?.bindingGeneration)) {
    return { decision: "canceled", reason: "binding_changed" };
  }
  if (receipt && ((receipt.generation !== undefined && receipt.generation !== thread.recovery?.bindingGeneration)
    || (receipt.submission && !exactReceipt(receipt, key, thread)))) return { decision: "canceled", reason: "binding_changed" };
  if (receipt?.recoveryDecision?.decision === "expired" || receipt?.recoveryDecision?.decision === "canceled") return receipt.recoveryDecision;
  return age;
}

function terminal(message: Transcript[number], promptId: string): boolean {
  const info = message.info;
  return info.role === "assistant" && info.parentID === promptId && !info.summary && !info.error
    && Number.isFinite(info.time?.completed) && info.time!.completed! >= info.time!.created
    && !!info.finish && info.finish !== "tool-calls" && info.finish !== "unknown";
}

/** Completion covers every pending exact prompt, not just an older answer in this session. */
function completed(messages: Transcript, users: OcMessageInfo[]): boolean {
  const ids = new Set(users.map(user => user.id));
  const newest = messages.filter(message => message.info.role === "user").at(-1)?.info;
  const tail = messages.at(-1);
  if (!newest || !tail || !terminal(tail, newest.id)) return false;
  const tools = new Map<string, string | undefined>();
  for (const message of messages) {
    if (!ids.has(message.info.parentID ?? "")) continue;
    for (const part of message.parts) if (part.type === "tool") tools.set(`${message.info.parentID}:${part.callID ?? part.id}`, part.state?.status);
  }
  if ([...tools.values()].some(status => status !== "completed" && status !== "error")) return false;
  return users.every(user => {
    const tail = messages.filter(message => message.info.parentID === user.id).at(-1);
    return !!tail && tail.info.time!.created >= user.time!.created && terminal(tail, user.id);
  });
}

/**
 * Run once before intake/prewarm. Only reads existing OpenCode runs; never submits a prompt.
 * Pending-interaction delivery hooks must be deferred by the caller until this sweep finishes.
 */
export async function recoverInterruptedRuns(deps: BootRecoveryDeps): Promise<BootRecoveryCounts> {
  const counts: BootRecoveryCounts = { restored: 0, completed: 0, interrupted: 0, held: 0, expired: 0, canceled: 0, skipped: 0, errors: 0, notices: 0 };
  const { state, pool, render, isStopping } = deps;
  const snapshots = state.threadsWithPendingRun();

  async function recover(key: string, snapshot: ThreadState): Promise<Outcome> {
    const timestamps = [...new Set(snapshot.pendingRun!.userMsgTs)];
    let lease: RequestLease | undefined;
    let view: SessionView | undefined;
    let cleared = false;
    let invalidated: Outcome = "skipped";
    const retired = new Set<string>();
    const decisions = () => timestamps.map(ts => ({ ts, ...pendingDecision(state, key, state.getThread(key)!, ts) }));
    const record = (items: Array<{ ts: string }>, decision: RecoveryDecision) => {
      for (const { ts } of items) state.recordRecoveryDecision(key, ts, decision);
    };
    const retire = (items: ReturnType<typeof decisions>): Outcome => {
      for (const { ts, ...decision } of items) state.recordRecoveryDecision(key, ts, decision);
      const outcome = items.some(item => item.decision === "canceled") ? "canceled" : "expired";
      state.recordRunOutcome(key, snapshot.sessionId, outcome === "canceled" ? "stopped" : "interrupted", timestamps);
      state.clearPendingRun(key);
      cleared = true;
      return outcome;
    };
    // Rechecked after EVERY await, including Slack delivery and server acquisition.
    const current = (): boolean => {
      const thread = state.getThread(key);
      if (isStopping() || !thread || !sameRun(thread, snapshot)) return false;
      if (JSON.stringify(thread.pendingRun?.userMsgTs) !== JSON.stringify(cleared ? undefined : snapshot.pendingRun!.userMsgTs)) return false;
      const items = decisions();
      if (items.every(item => item.decision === "expired" || item.decision === "canceled")) {
        if (!cleared) invalidated = retire(items);
        return false;
      }
      // A partial batch can age out while another prompt remains eligible.
      for (const { ts, ...decision } of items) {
        if ((decision.decision === "expired" || decision.decision === "canceled") && !retired.has(ts)) {
          state.recordRecoveryDecision(key, ts, decision);
          retired.add(ts);
        }
      }
      const accepted = thread.recovery?.latestAcceptedTs;
      if (lease && accepted && !timestamps.includes(accepted) && timestamps.every(ts => compareTs(ts, accepted) < 0)) return false;
      if (lease && (pool.get(snapshot.projectDir) !== lease.entry || lease.entry.status !== "ready")) return false;
      const registered = getView(snapshot.sessionId);
      return !registered || registered === view;
    };
    const recent = () => decisions().filter(item => item.decision === "recover");
    const reportError = (operation: string, error: unknown) => {
      counts.errors++;
      logErr(`boot recovery ${operation} (${key}): ${errorMessage(error)}`);
    };

    async function interrupt(reason: string, uncertain: boolean): Promise<Outcome> {
      if (!current()) return invalidated;
      const items = recent();
      const prior = state.getThread(key)!.recovery?.lastRun;
      // Persist before Slack: a timeout/crash must not repeatedly notify on later boots.
      const samePrior = prior?.generation === snapshot.recovery?.bindingGeneration
        && prior?.sessionId === snapshot.sessionId && JSON.stringify(prior.userMsgTs) === JSON.stringify(timestamps);
      // Held receipt evidence survives a successful observation restore (which writes "active").
      const notified = samePrior && (prior?.outcome === "interrupted"
        || timestamps.some(ts => state.getReceipt(key, ts)?.recoveryDecision?.decision === "held"));
      record(items, { decision: "held", reason });
      state.recordRunOutcome(key, snapshot.sessionId, "interrupted", timestamps);
      if (!uncertain) { state.clearPendingRun(key); cleared = true; }
      if (!notified && items.length && current()) {
        const text = uncertain
          ? ":warning: Bridge restarted — this run is held for review; acceptance or progress is uncertain. Check \\status before sending a new instruction."
          : ":warning: Bridge restarted — this run was interrupted. Send a new instruction to continue.";
        try {
          // Replace a frozen progress bar when possible, otherwise post one concise notice.
          if (snapshot.pendingRun?.statusTs) await render.update(key.split(":")[0]!, snapshot.pendingRun.statusTs, text);
          else await render.post(key.split(":")[0]!, key.slice(key.indexOf(":") + 1), text, undefined, { unfurl: false, lane: "interactive" });
          counts.notices++;
          if (!current()) return invalidated;
        } catch (error) {
          reportError("notice failed", error);
          if (!current()) return invalidated;
        }
      }
      return uncertain ? "held" : "interrupted";
    }

    try {
      if (!current()) return invalidated;
      for (const { ts, ...decision } of decisions()) if (decision.decision !== "recover") state.recordRecoveryDecision(key, ts, decision);
      let candidates = recent();
      if (!candidates.length || decisions().some(item => item.decision === "held")) return await interrupt("pending_acceptance_uncertain", true);
      const latestAccepted = state.getThread(key)!.recovery?.latestAcceptedTs;
      if (latestAccepted && candidates.every(item => compareTs(item.ts, latestAccepted) < 0)) return await interrupt("overtaken_by_accepted_prompt", true);
      if (!candidates.some(item => exactReceipt(state.getReceipt(key, item.ts), key, snapshot))) return await interrupt("pending_acceptance_uncertain", true);

      lease = await pool.acquire(snapshot.projectDir);
      if (!current()) return invalidated;
      const { client, url } = lease.entry;
      if (!client || !url) throw new Error("ready server has no client or URL");
      const reconcile = (messages: Transcript) => {
        for (const message of messages) {
          if (candidates.some(item => {
            const receipt = state.getReceipt(key, item.ts);
            return exactReceipt(receipt, key, snapshot) && receipt.submission.messageId === message.info.id;
          })) state.reconcilePromptAcceptance(snapshot.projectDir, message.info);
        }
      };
      // Keep exact acceptance evidence even if a later status/interaction read fails.
      const initial = await sessionMessages(client, snapshot.sessionId);
      if (!current()) return invalidated;
      reconcile(initial);
      const idle = await sessionIdle(client, snapshot.sessionId);
      if (!current()) return invalidated;
      const questions = await pendingQuestions(client);
      if (!current()) return invalidated;
      const permissions = await pendingPermissions(client);
      if (!current()) return invalidated;
      const messages = await sessionMessages(client, snapshot.sessionId);
      if (!current()) return invalidated;
      candidates = recent();
      reconcile(messages);

      if (messages.some(message => message.info.sessionID !== snapshot.sessionId
        || !Number.isFinite(message.info.time?.created) || message.info.time!.created <= 0 || message.info.time!.created > state.now())) {
        return await interrupt("invalid_transcript_evidence", true);
      }
      messages.sort((a, b) => a.info.time!.created - b.info.time!.created);
      const users: OcMessageInfo[] = [];
      for (const item of candidates) {
        const receipt = state.getReceipt(key, item.ts);
        const user = exactReceipt(receipt, key, snapshot) && receipt.disposition === "accepted"
          ? messages.find(message => message.info.role === "user" && message.info.id === receipt.submission.messageId)?.info : undefined;
        if (!user) return await interrupt("pending_acceptance_uncertain", true);
        users.push(user);
      }
      const newestUser = messages.filter(message => message.info.role === "user").at(-1)?.info;
      const tail = messages.at(-1)?.info;
      if (!newestUser || !users.some(user => user.id === newestUser.id) || !tail
        || (tail.id !== newestUser.id && (tail.role !== "assistant" || tail.parentID !== newestUser.id))) {
        return await interrupt("newest_turn_not_correlated", true);
      }
      const matches = (messageID?: string, callID?: string) => messages.some(message =>
        (message.info.id === newestUser.id || message.info.parentID === newestUser.id)
        && message.info.id === messageID && (!callID || message.parts.some(part => part.type === "tool" && part.callID === callID)));
      const sessionQuestions = questions.filter(question => question.sessionID === snapshot.sessionId);
      const sessionPermissions = permissions.filter(permission => permission.sessionID === snapshot.sessionId);
      const matchingQuestions = sessionQuestions.filter(question => matches(question.tool?.messageID, question.tool?.callID));
      const matchingPermissions = sessionPermissions.filter(permission => matches(permission.messageID, permission.callID));

      if (!idle || matchingQuestions.length || matchingPermissions.length) {
        if (!current()) return invalidated;
        view = new SessionView({ sessionId: snapshot.sessionId, projectDir: snapshot.projectDir,
          channel: key.split(":")[0]!, threadTs: key.slice(key.indexOf(":") + 1), threadKey: key,
          client, deps: render, state, threadState: state.getThread(key)!, statusTs: snapshot.pendingRun?.statusTs });
        for (const question of matchingQuestions) view.setWaiting(question.id, "question", true);
        for (const permission of matchingPermissions) view.setWaiting(permission.id, "permission", true);
        const restored = await view.restoreAcceptedRun(candidates.map(item => item.ts), newestUser.time!.created);
        if (!current()) return invalidated;
        if (!restored) return await interrupt("observation_restore_failed", true);
        record(candidates, { decision: "recover", reason: "accepted_run_restored" });
        view = undefined; // The registry now owns observation and its timers.
        return "restored";
      }
      if (sessionQuestions.length || sessionPermissions.length) return await interrupt("pending_interaction_not_correlated", true);
      if (!completed(messages, users)) return await interrupt("accepted_run_incomplete", false);

      record(candidates, { decision: "already_handled", reason: "exact_run_completed" });
      state.recordRunOutcome(key, snapshot.sessionId, "completed", candidates.map(item => item.ts));
      state.clearPendingRun(key);
      cleared = true;
      // Do not feed historical output into the renderer/finalize backstop.
      if (snapshot.pendingRun?.statusTs && current()) {
        try { await render.delete(key.split(":")[0]!, snapshot.pendingRun.statusTs); }
        catch (error) { reportError("status cleanup failed", error); }
        if (!current()) return invalidated;
      }
      return "completed";
    } catch (error) {
      reportError("inspection failed", error);
      return await interrupt("server_evidence_unavailable", true);
    } finally {
      if (view && getView(snapshot.sessionId) === view) deleteView(snapshot.sessionId);
      lease?.release();
    }
  }

  for (const { key, thread } of snapshots) {
    // Persistence failures propagate to the boot caller; they must never look like success.
    counts[await recover(key, thread)]++;
  }
  return counts;
}
