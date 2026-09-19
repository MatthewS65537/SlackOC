/** Bounded, fair recovery from retained Slack threads; live observations never confirm history. */
import type { StateStore } from "../state.js";
import { logErr } from "../log.js";
import type { IncomingOutcome, SlackMsg } from "./router.js";

export interface RepliesPage {
  /** Contiguous ascending history after oldest; do not return only the newest page. */
  messages: SlackMsg[];
  /** More history remains. The next sweep continues after the last confirmed message. */
  hasMore: boolean;
  pagesUsed: number;
}

export interface CatchupDeps {
  state: StateStore;
  ownerSlackUserId: string;
  /**
   * The callback owns Slack pagination, honoring maxPages (including empty pages).
   * On a page failure, throw or return only the contiguous successful prefix.
   * Arrays remain supported for a SINGLE page. Never silently fetch unbounded pages.
   */
  fetchReplies(channel: string, rootTs: string, oldest: string, budget: { maxPages: number }): Promise<RepliesPage | SlackMsg[]>;
  /** Return the real router outcome, or persist its receipt before resolving. */
  dispatch(msg: SlackMsg): Promise<IncomingOutcome | void>;
}

export const MAX_THREADS_PER_SWEEP = 10;
export const MAX_PAGES_PER_SWEEP = 20;
export const MAX_PAGES_PER_THREAD = 2;
const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;

interface Scheduler {
  flight?: Promise<number>;
  requested: boolean;
  sequence: number;
  polled: Map<string, number>;
  fetchFailed: Set<string>;
}
const schedulers = new WeakMap<StateStore, Scheduler>();

/** Boot/timer/reconnect can all call request; concurrent triggers share one coalesced flight. */
export function createCatchupCoordinator(deps: CatchupDeps): { request: () => Promise<number> } {
  return { request: () => sweepMissedMessages(deps) };
}

/** Single-flight even when callers do not explicitly use the coordinator. */
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
  const all = state.threadsForCatchup().filter(({ thread }) => thread.historyCursorTs);
  const retained = new Set(all.map((c) => c.key));
  for (const key of scheduler.polled.keys()) if (!retained.has(key)) scheduler.polled.delete(key);
  for (const key of scheduler.fetchFailed) if (!retained.has(key)) scheduler.fetchFailed.delete(key);
  all.sort((a, b) => (scheduler.polled.get(a.key) ?? 0) - (scheduler.polled.get(b.key) ?? 0) || a.key.localeCompare(b.key));
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = all.filter(({ thread }) => (thread.lastUsedAt ?? thread.createdAt ?? 0) >= cutoff);
  const older = all.filter(({ thread }) => (thread.lastUsedAt ?? thread.createdAt ?? 0) < cutoff);
  const candidates = [...recent.splice(0, 8), ...older.splice(0, 2)];
  candidates.push(...[...recent, ...older].slice(0, MAX_THREADS_PER_SWEEP - candidates.length));

  let replayed = 0;
  let pagesLeft = MAX_PAGES_PER_SWEEP;
  for (const { key } of candidates) {
    if (!pagesLeft) break;
    // Advance even on failure/blocked receipts: bad threads cannot starve others.
    scheduler.polled.set(key, ++scheduler.sequence);
    const oldest = state.getThread(key)?.historyCursorTs;
    if (!oldest) continue;
    const [channel, rootTs] = key.split(":") as [string, string];
    const maxPages = Math.min(MAX_PAGES_PER_THREAD, pagesLeft);
    let replies: SlackMsg[];
    try {
      const page = await fetchReplies(channel, rootTs, oldest, { maxPages });
      const used = Array.isArray(page) ? 1 : page.pagesUsed;
      if (!Number.isInteger(used) || used < 1 || used > maxPages) throw new Error("fetchReplies exceeded/omitted its page budget");
      pagesLeft -= used;
      replies = Array.isArray(page) ? page : page.messages;
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
    for (const m of [...replies].sort((a, b) => a.ts.localeCompare(b.ts))) {
      if (m.ts <= (state.getThread(key)?.historyCursorTs ?? oldest)) continue;
      const relevant = !m.bot_id && (!m.subtype || m.subtype === "file_share") && m.user === ownerSlackUserId;
      if (relevant) {
        const receipt = state.getReceipt(key, m.ts);
        if (receipt?.disposition === "processing" || receipt?.disposition === "uncertain") break;
        if (!receipt) {
          try {
            const outcome = await dispatch({ ...m, channel, thread_ts: rootTs });
            const disposition = state.getReceipt(key, m.ts)?.disposition;
            if (disposition !== "accepted" && outcome !== "accepted" && outcome !== "ignored") break;
            replayed += 1;
          } catch (err) {
            // Only the router can decide whether effects happened. Never release its claim here.
            logErr(`catch-up replay failed (${key} ${m.ts}): ${String(err)} — disposition retained`);
            break;
          }
        }
      }
      if (!state.confirmHistory(key, m.ts)) break;
    }
  }
  if (replayed) logErr(`catch-up: replayed ${replayed} missed message(s) from Slack history`);
  return replayed;
}
