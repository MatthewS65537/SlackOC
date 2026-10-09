/** Bounded, fair recovery from retained Slack threads; live observations never confirm history. */
import type { StateStore } from "../state.js";
import { logErr } from "../log.js";
import { cleanMentionText, type IncomingOutcome, type SlackMsg } from "./router.js";
import { classifyRecovery, compareTs, isRecentRecoveryEligibleThread, nextTs, replayAge, replayFloor, timestampFromMs, timestampMicros, type IncomingContext } from "./recovery-policy.js";
import { parseBackslash } from "../commands/parse.js";
import { resolveCommandName } from "../commands/registry.js";
import { slackToPlain } from "../util.js";

export interface RepliesPage {
  /** Contiguous ascending history after oldest; do not return only the newest page. */
  messages: SlackMsg[];
  /** More history remains. The next sweep continues after the last confirmed message. */
  hasMore: boolean;
  pagesUsed: number;
  nextCursor?: string;
}

export interface CatchupDeps {
  state: StateStore;
  ownerSlackUserId: string;
  /**
   * The callback owns Slack pagination, honoring maxPages (including empty pages).
   * On a page failure, throw or return only the contiguous successful prefix.
   * Never silently fetch unbounded pages.
   */
  fetchReplies(channel: string, rootTs: string, oldest: string, budget: { maxPages: number; latest: string; inclusive: boolean; cursor?: string }): Promise<RepliesPage>;
  /** Return the real router outcome, or persist its receipt before resolving. */
  dispatch(msg: SlackMsg, context: IncomingContext): Promise<IncomingOutcome | void>;
}

const MAX_THREADS_PER_SWEEP = 10;
const MAX_PAGES_PER_SWEEP = 20;
const MAX_PAGES_PER_THREAD = 2;
export const MAX_SNAPSHOT_CANDIDATES = 200;

interface Scheduler {
  flight?: Promise<number>;
  requested: boolean;
  sequence: number;
  polled: Map<string, number>;
  fetchFailed: Set<string>;
}
const schedulers = new WeakMap<StateStore, Scheduler>();

/** Boot/timer/reconnect can all call this; concurrent triggers share one coalesced flight. */
export function sweepMissedMessages(deps: CatchupDeps): Promise<number> {
  let scheduler = schedulers.get(deps.state);
  if (!scheduler) {
    scheduler = { requested: false, sequence: 0, polled: new Map(), fetchFailed: new Set() };
    schedulers.set(deps.state, scheduler);
  }
  if (scheduler.flight) { scheduler.requested = true; return scheduler.flight; }
  const s = scheduler;
  s.flight = Promise.resolve().then(async () => {
    let replayed = 0;
    do {
      s.requested = false;
      replayed += await sweep(deps, s);
    } while (s.requested);
    return replayed;
  }).finally(() => { s.flight = undefined; });
  return s.flight;
}

async function sweep(deps: CatchupDeps, scheduler: Scheduler): Promise<number> {
  const { state, ownerSlackUserId, fetchReplies, dispatch } = deps;
  state.pruneAcceptedUnboundReceipts();
  const all = state.threadsForCatchup();
  const retained = new Set(all.map((c) => c.key));
  for (const key of scheduler.polled.keys()) if (!retained.has(key)) scheduler.polled.delete(key);
  for (const key of scheduler.fetchFailed) if (!retained.has(key)) scheduler.fetchFailed.delete(key);
  all.sort((a, b) => (scheduler.polled.get(a.key) ?? 0) - (scheduler.polled.get(b.key) ?? 0) || a.key.localeCompare(b.key));
  const recent = all.filter(({ thread }) => isRecentRecoveryEligibleThread(thread, state.now()));
  const older = all.filter(({ thread }) => !isRecentRecoveryEligibleThread(thread, state.now()));
  const candidates = [...recent.splice(0, 8), ...older.splice(0, 2)];
  candidates.push(...[...recent, ...older].slice(0, MAX_THREADS_PER_SWEEP - candidates.length));

  let replayed = 0;
  let pagesLeft = MAX_PAGES_PER_SWEEP;
  for (const { key } of candidates) {
    if (!pagesLeft) break;
    // Advance even on failure/blocked receipts: bad threads cannot starve others.
    scheduler.polled.set(key, ++scheduler.sequence);
    const thread = state.getThread(key)!;
    const recovery = thread.recovery!;
    let scan = recovery.scan;
    if (scan && (scan.generation !== recovery.bindingGeneration || scan.intentVersion !== recovery.intentVersion)) {
      // Collected rows must be reclassified against current intent, never executed using an old decision.
      for (const m of scan.candidates) state.recordRecoveryDecision(key, m.ts, { decision: "held", reason: "snapshot_invalidated" });
      state.retireHistory(key, scan.upperTs);
      state.setRecoveryScan(key, undefined);
      scan = undefined;
    }
    if (!scan) {
      const oldest = [thread.historyCursorTs, recovery.replayFloorTs, replayFloor(state.now())]
        .filter((ts): ts is string => !!ts).sort(compareTs).at(-1)!;
      scan = { upperTs: timestampFromMs(state.now()), afterTs: oldest, generation: recovery.bindingGeneration,
        intentVersion: recovery.intentVersion, candidates: [], complete: false };
    }
    const ageFloor = replayFloor(state.now());
    if (compareTs(scan.upperTs, ageFloor) < 0) {
      for (const m of scan.candidates) state.recordRecoveryDecision(key, m.ts, { decision: "expired", reason: "older_than_72h" });
      state.retireHistory(key, ageFloor);
      state.setRecoveryScan(key, undefined);
      continue;
    }
    if (compareTs(scan.afterTs, ageFloor) < 0) {
      // Drop an opaque cursor when its query window changes. Ascending timestamp
      // continuation normally avoids this; an empty page must be recollected safely.
      scan.afterTs = ageFloor;
      scan.cursor = undefined;
    }
    const [channel, rootTs] = key.split(":") as [string, string];
    const maxPages = Math.min(MAX_PAGES_PER_THREAD, pagesLeft);
    if (!scan.complete) {
    try {
      const page = await fetchReplies(channel, rootTs, scan.afterTs, { maxPages, latest: scan.upperTs, inclusive: true, cursor: scan.cursor });
      const used = page.pagesUsed;
      if (!Number.isInteger(used) || used < 1 || used > maxPages) throw new Error("fetchReplies exceeded/omitted its page budget");
      pagesLeft -= used;
      const replies = page.messages.filter((m) => timestampMicros(m.ts) !== undefined && compareTs(m.ts, scan!.upperTs) <= 0);
      const owner = replies.filter((m) => !m.bot_id && (!m.subtype || m.subtype === "file_share") && m.user === ownerSlackUserId);
      for (const m of owner) {
        if (compareTs(m.ts, scan.afterTs) < 0 || scan.candidates.some((row) => row.ts === m.ts)) continue;
        scan.candidates.push({ ...m, channel, thread_ts: rootTs });
      }
      scan.candidates.sort((a, b) => compareTs(a.ts, b.ts));
      if (scan.candidates.length > MAX_SNAPSHOT_CANDIDATES || state.threadsForCatchup().reduce((n, row) => n + (row.thread.recovery?.scan?.candidates.length ?? 0), 0) + owner.length > 2000) {
        state.recordRecoveryDecision(key, scan.upperTs, { decision: "held", reason: "backlog_overflow" });
        state.retireHistory(key, nextTs(scan.upperTs));
        state.setRecoveryScan(key, undefined);
        continue;
      }
      scan.complete = !page.hasMore;
      scan.cursor = page.nextCursor;
      if (!scan.complete) {
        // Resume a contiguous ascending prefix by timestamp; empty pages alone
        // need the opaque Slack cursor. This keeps every later read age-clamped.
        const last = replies.map((m) => m.ts).sort(compareTs).at(-1);
        if (last && compareTs(last, scan.afterTs) >= 0) {
          scan.afterTs = nextTs(last);
          scan.cursor = undefined;
        } else if (!scan.cursor) {
          state.recordRecoveryDecision(key, scan.upperTs, { decision: "held", reason: "pagination_incomplete" });
          state.setRecoveryScan(key, scan);
          continue;
        }
      }
      state.setRecoveryScan(key, scan);
      scheduler.fetchFailed.delete(key);
    } catch (err) {
      // A failing callback may have spent the entire reservation.
      pagesLeft -= maxPages;
      if (!scheduler.fetchFailed.has(key)) {
        scheduler.fetchFailed.add(key);
        logErr(`catch-up: replies fetch failed for ${key} (${String(err)}) — retrying on its next rotation`);
      }
      continue;
    }
    }
    if (!scan.complete) {
      state.recordRecoveryDecision(key, scan.upperTs, { decision: "held", reason: "pagination_incomplete" });
      continue;
    }
    // Inspect ALL later owner intent before the first task, including stop on page three.
    for (const m of scan.candidates) {
      if (replayAge(m.ts, state.now()).decision !== "recover") continue;
      state.markThreadSeen(key, m.ts);
      if (state.isMessageAccepted(key, m.ts)) continue;
      const command = historyCommand(m);
      if (command && !["help", "status", "permissions", "stop"].includes(command) && !state.isMessageAccepted(key, m.ts)) state.holdHistoricalContext(key);
      if (["stop", "hush", "new", "cd", "project", "resume", "watch", "unwatch"].includes(command ?? "")) {
        const current = state.getThread(key)?.recovery?.canceledThroughTs;
        const priorIntent = state.getThread(key)!.recovery!.intentVersion;
        if (!current || compareTs(m.ts, current) > 0) state.cancelRecovery(key, m.ts);
        // The history cancellation invalidates earlier candidates but permits later new input.
        if (scan.intentVersion === priorIntent) scan.intentVersion = state.getThread(key)!.recovery!.intentVersion;
      }
    }
    let retired = false;
    while (scan.candidates.length) {
      const m = scan.candidates[0]!;
      const current = state.getThread(key)!;
      const command = historyCommand(m);
      const context: IncomingContext = { source: "history", generation: scan.generation, intentVersion: scan.intentVersion };
      const receipt = state.getReceipt(key, m.ts);
      if (receipt?.disposition === "processing") break; // live HTTP/SSE may still settle it
      let decision = classifyRecovery({ ts: m.ts, thread: current, receipt, now: state.now(), context, command });
      if (state.isMessageAccepted(key, m.ts)) decision = { decision: "already_handled", reason: "confirmed_history" };
      if (decision.decision === "recover" && current.pendingRun?.userMsgTs.length && !command) {
        if (current.pendingRun.userMsgTs.some((ts) => state.getReceipt(key, ts)?.disposition === "uncertain"))
          decision = { decision: "held", reason: "prior_run_unresolved" };
        else break; // One task at a time; renderer completion releases the next batch member.
      }
      if (decision.decision === "recover") {
          try {
            const outcome = await dispatch(m, context);
            const disposition = state.getReceipt(key, m.ts)?.disposition;
            if (disposition !== "accepted" && outcome !== "accepted" && outcome !== "ignored") {
              if (outcome === "held" || outcome === "expired" || outcome === "canceled") decision = { decision: outcome, reason: "dispatch_recheck" };
              else break;
            } else {
              state.markThreadSeen(key, m.ts);
              if (!command) replayed += 1;
            }
          } catch (err) {
            // Only the router can decide whether effects happened. Never release its claim here.
            logErr(`catch-up replay failed (${key} ${m.ts}): ${String(err)} — disposition retained`);
            break;
          }
      }
      if (decision.decision !== "already_handled" && !(command && decision.decision === "recover")) {
        state.recordRecoveryDecision(key, m.ts, decision);
        logErr(`recovery ${key} · ${m.ts} · ageMs=${state.now() - Number(timestampMicros(m.ts)! / 1000n)} · ${decision.decision} · ${decision.reason} · history · generation=${scan.generation}`);
      }
      retired ||= decision.decision !== "recover" && decision.decision !== "already_handled";
      if (!retired) state.confirmHistory(key, m.ts);
      state.retireHistory(key, nextTs(m.ts));
      scan.candidates.shift();
      state.setRecoveryScan(key, scan);
    }
    if (!scan.candidates.length) {
      state.retireHistory(key, nextTs(scan.upperTs));
      state.setRecoveryScan(key, undefined);
    }
  }
  if (replayed) logErr(`catch-up: replayed ${replayed} missed message(s) from Slack history`);
  return replayed;
}

export interface TopLevelCatchupDeps {
  state: StateStore;
  ownerSlackUserId: string;
  /** \listen channels plus the owner DM — where an owner top-level message is itself a prompt. */
  channels: string[];
  /** conversations.history after `oldest`, ascending, up to a bounded page budget. */
  fetchHistory(channel: string, oldest: string): Promise<{ messages: SlackMsg[]; hasMore: boolean }>;
  dispatch(msg: SlackMsg, context: IncomingContext): Promise<IncomingOutcome | void>;
}

/**
 * Thread sweeps only see replies inside bound threads, so a top-level message
 * Socket Mode dropped in a \listen channel or the owner DM needs its own pass.
 * Per-channel watermark: a missing one is seeded at now (nothing older replays);
 * live-handled messages already hold receipts and are skipped; "processing"/"retry"
 * stop the channel so the next sweep retries from there.
 */
export async function sweepTopLevelMessages(deps: TopLevelCatchupDeps): Promise<number> {
  const { state, ownerSlackUserId, dispatch } = deps;
  let replayed = 0;
  for (const channel of deps.channels) {
    const mark = state.topLevelWatermark(channel);
    if (!mark) { state.setTopLevelWatermark(channel, timestampFromMs(state.now())); continue; }
    const floor = replayFloor(state.now());
    let page: Awaited<ReturnType<TopLevelCatchupDeps["fetchHistory"]>>;
    try {
      page = await deps.fetchHistory(channel, compareTs(mark, floor) > 0 ? mark : floor);
    } catch (err) {
      logErr(`catch-up: history fetch failed for ${channel} (${String(err)}) — retrying next sweep`);
      continue;
    }
    const newer = page.messages.filter((m) => timestampMicros(m.ts) !== undefined && compareTs(m.ts, mark) > 0);
    const newest = newer.map((m) => m.ts).sort(compareTs).at(-1);
    if (!newest) continue;
    if (page.hasMore) {
      // Pages arrive newest-first, so an over-budget gap has no contiguous oldest
      // edge. A backlog that large is not something to replay blind.
      logErr(`catch-up: ${channel} top-level backlog exceeds the page budget — held, watermark moved to ${newest}`);
      state.setTopLevelWatermark(channel, newest);
      continue;
    }
    let advanced = mark;
    for (const m of newer) {
      const isOwnerPrompt = !m.bot_id && (!m.subtype || m.subtype === "file_share") && m.user === ownerSlackUserId
        && (!m.thread_ts || m.thread_ts === m.ts);
      const receipt = isOwnerPrompt ? state.getReceipt(state.threadKey(channel, m.ts), m.ts) : undefined;
      if (receipt?.disposition === "processing") break; // live delivery is mid-flight
      if (isOwnerPrompt && !receipt) {
        try {
          const outcome = await dispatch({ ...m, channel }, { source: "history", topLevel: true });
          if (outcome === "retry" || outcome === "processing" || outcome === "paused") break;
          if (outcome === "accepted" && !historyCommand(m)) replayed += 1;
        } catch (err) {
          logErr(`catch-up replay failed (${channel} ${m.ts}): ${String(err)} — disposition retained`);
          break;
        }
      }
      advanced = m.ts;
    }
    if (advanced !== mark) state.setTopLevelWatermark(channel, advanced);
  }
  if (replayed) logErr(`catch-up: replayed ${replayed} missed top-level message(s)`);
  return replayed;
}

/** Canonical (alias-resolved) command name of a history message, if it is one. */
function historyCommand(m: SlackMsg): string | undefined {
  const name = parseBackslash(cleanMentionText(slackToPlain(m.text ?? "")))?.name;
  return name && resolveCommandName(name);
}
