import type { MessageReceipt, ThreadState } from "../state.js";
import { canonicalDir } from "../paths.js";

export const MAX_REPLAY_AGE_MS = 72 * 60 * 60 * 1000;
export const FUTURE_TOLERANCE_MS = 60_000;
export type RecoveryDecision = { decision: "recover" | "already_handled" | "expired" | "canceled" | "held"; reason: string };
export interface IncomingContext { source: "live" | "history"; generation?: number; intentVersion?: number }

/** Slack timestamps are decimal seconds, with at most six microsecond digits. */
export function timestampMicros(ts: string | undefined): bigint | undefined {
  if (!ts || !/^\d{1,12}\.\d{1,6}$/.test(ts)) return undefined;
  const [seconds, fraction] = ts.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0"));
}
export function microsTimestamp(us: bigint): string {
  return `${us / 1_000_000n}.${String(us % 1_000_000n).padStart(6, "0")}`;
}
export function timestampFromMs(ms: number): string { return microsTimestamp(BigInt(Math.floor(ms)) * 1000n); }
export function compareTs(a: string, b: string): number {
  const aa = timestampMicros(a), bb = timestampMicros(b);
  if (aa === undefined || bb === undefined) return a.localeCompare(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}
export function replayAge(ts: string | undefined, now = Date.now()): RecoveryDecision {
  const us = timestampMicros(ts);
  const clock = BigInt(Math.floor(now)) * 1000n;
  if (us === undefined || us > clock + BigInt(FUTURE_TOLERANCE_MS) * 1000n) return { decision: "held", reason: "invalid_timestamp" };
  return clock - us > BigInt(MAX_REPLAY_AGE_MS) * 1000n
    ? { decision: "expired", reason: "older_than_72h" } : { decision: "recover", reason: "recent" };
}
/** Inclusive age boundary: oldest itself must be included by the history adapter. */
export function replayFloor(now = Date.now()): string { return timestampFromMs(now - MAX_REPLAY_AGE_MS); }
export function isRecentRecoveryEligibleReceipt(receipt: MessageReceipt, now = Date.now()): boolean {
  return receipt.recoveryDecision?.decision !== "expired" && receipt.recoveryDecision?.decision !== "canceled"
    && replayAge(receipt.ts, now).decision === "recover";
}
export function isRecentRecoveryEligibleThread(thread: ThreadState, now = Date.now()): boolean {
  return !thread.hushed && !thread.watchOnly && thread.recovery?.lastRun?.outcome !== "stopped"
    && replayAge(thread.recovery?.ownerActivityTs, now).decision === "recover";
}

export function classifyRecovery(input: {
  ts: string; thread: ThreadState | null; receipt?: MessageReceipt; now?: number;
  context: IncomingContext; command?: string; ownClaim?: boolean; canceledThroughTs?: string;
}): RecoveryDecision {
  const { ts, thread: t, receipt: r, context: ctx } = input;
  const age = replayAge(ts, input.now);
  if (age.decision !== "recover") return age;
  if (r?.disposition === "accepted") return { decision: "already_handled", reason: "accepted_receipt" };
  if (r?.recoveryDecision) return r.recoveryDecision;
  if (r && !(input.ownClaim && r.disposition === "processing")) return { decision: "held", reason: "submission_uncertain" };
  const recovery = t?.recovery;
  if (input.canceledThroughTs && compareTs(ts, input.canceledThroughTs) <= 0) return { decision: "canceled", reason: "owner_canceled" };
  if (recovery?.canceledThroughTs && compareTs(ts, recovery.canceledThroughTs) <= 0) return { decision: "canceled", reason: "owner_canceled" };
  if (ctx.generation !== undefined && ctx.generation !== (recovery?.bindingGeneration ?? 0)) return { decision: "canceled", reason: "binding_changed" };
  if (recovery?.lastRun && recovery.lastRun.generation === recovery.bindingGeneration && recovery.lastRun.userMsgTs.includes(ts) && recovery.lastRun.outcome !== "active") return {
    decision: recovery.lastRun.outcome === "completed" ? "already_handled" : "held", reason: `run_${recovery.lastRun.outcome}`,
  };
  if (recovery?.replayFloorTs && compareTs(ts, recovery.replayFloorTs) < 0) return { decision: "held", reason: "retired_history" };
  if (!input.command && recovery?.latestAcceptedTs && compareTs(ts, recovery.latestAcceptedTs) < 0) return { decision: "held", reason: "overtaken_by_accepted_prompt" };
  if (ctx.source === "live") return { decision: "recover", reason: "live_owner_input" };
  if (input.command && !["help", "status", "permissions"].includes(input.command)) return { decision: "held", reason: "historical_command" };
  if (t?.hushed || t?.watchOnly) return { decision: "canceled", reason: t.watchOnly ? "watch_only" : "hushed" };
  if (ctx.intentVersion !== undefined && ctx.intentVersion !== recovery?.intentVersion) return { decision: "held", reason: "live_intent_changed" };
  if (!input.command && recovery?.needsFreshIntent) return { decision: "held", reason: "historical_command_context" };
  if (!t?.historyCursorTs && !recovery?.trustedAfterTs) return { decision: "held", reason: "legacy_without_boundary" };
  return { decision: "recover", reason: "missed_after_boundary" };
}

/** Boot may inspect recent exact receipts, but never synthesizes a continuation. */
export function classifyPendingRun(thread: ThreadState, receipts: MessageReceipt[], now = Date.now()): RecoveryDecision {
  const pending = thread.pendingRun?.userMsgTs ?? [];
  const recent = pending.filter((ts) => replayAge(ts, now).decision === "recover");
  if (!recent.length) return { decision: "expired", reason: "no_recent_pending_input" };
  if (thread.hushed || thread.watchOnly || recent.every((ts) => thread.recovery?.canceledThroughTs && compareTs(ts, thread.recovery.canceledThroughTs) <= 0))
    return { decision: "canceled", reason: "owner_canceled" };
  if (recent.some((ts) => !receipts.some((r) => r.ts === ts && r.disposition === "accepted" && r.submission?.sessionId === thread.sessionId
    && canonicalDir(r.submission.projectDir) === canonicalDir(thread.projectDir)
    && (r.generation === undefined || r.generation === thread.recovery?.bindingGeneration))))
    return { decision: "held", reason: "pending_acceptance_uncertain" };
  return { decision: "recover", reason: "inspect_exact_run" };
}
