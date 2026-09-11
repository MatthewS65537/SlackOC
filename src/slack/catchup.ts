/**
 * Missed-message catch-up sweep — the inbound resilience backstop.
 *
 * Slack Socket Mode delivers each envelope to ONE connection and does NOT
 * store/forward: anything undeliverable (restart gap, network flap, a zombie
 * connection Slack hasn't reaped, a second bridge elsewhere with the same
 * app token) is silently discarded. When that happens mid-conversation the
 * bridge's outbound path keeps working (status ticker, summaries), so the
 * thread just goes quiet with no error anywhere — "the thread died".
 *
 * The sweep makes permanent silence structurally impossible for bound
 * threads: every minute it re-reads each recently-used thread past its
 * watermark (ThreadState.lastSeenTs) and routes any not-yet-processed owner
 * messages through the exact same handler the socket feeds. A lost envelope
 * then costs ≤ ~1 minute of latency instead of the whole message.
 */

import type { StateStore } from "../state.js";
import { logErr } from "../log.js";
import type { SlackMsg } from "./router.js";

export interface CatchupDeps {
  state: StateStore;
  ownerSlackUserId: string;
  /** conversations.replies past the watermark (ascending, parent excluded server-side). */
  fetchReplies(channel: string, rootTs: string, oldest: string): Promise<SlackMsg[]>;
  /** Route a replayed message exactly as if the socket had just delivered it. */
  dispatch(msg: SlackMsg): Promise<void>;
}

/** Threads untouched longer than this aren't swept — a busy box would otherwise burn one API call per ancient thread per minute. */
const SWEEP_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Threads per pass (LRU-first); a bigger backlog drains over subsequent passes. */
const MAX_THREADS_PER_SWEEP = 10;

/** Threads whose replies fetch already failed this process — report once, not every minute. */
const fetchFailed = new Set<string>();

export async function sweepMissedMessages(deps: CatchupDeps): Promise<number> {
  const { state, ownerSlackUserId, fetchReplies, dispatch } = deps;
  const candidates = state.threadsForCatchup(Date.now() - SWEEP_WINDOW_MS).slice(0, MAX_THREADS_PER_SWEEP);
  let replayed = 0;
  for (const { key, thread } of candidates) {
    // Threads that predate watermarking are never swept: without a known-good
    // boundary the sweep could replay their original prompt and double-run it.
    if (!thread.lastSeenTs) continue;
    const [channel, rootTs] = key.split(":") as [string, string];
    let replies: SlackMsg[];
    try {
      replies = await fetchReplies(channel, rootTs, thread.lastSeenTs);
      fetchFailed.delete(key);
    } catch (err) {
      if (!fetchFailed.has(key)) {
        fetchFailed.add(key);
        // logErr (ring + stderr): this line is the tell when a thread's
        // backstop is broken — it must reach bridge.log too, not just \logs.
        logErr(`catch-up: replies fetch failed for ${key} (${String((err as Error)?.message ?? err)}) — retrying every minute`);
      }
      continue;
    }
    for (const m of replies) {
      if (m.ts === rootTs) continue; // parent (belt-and-braces; `oldest` already excludes it)
      if (m.bot_id) continue;
      if (m.subtype && m.subtype !== "file_share") continue; // mirrors the socket handler's own gate
      if (!m.user || m.user !== ownerSlackUserId) continue;
      // Re-check against the LIVE watermark: the copy from threadsForCatchup
      // is frozen at pass start, and the socket may have delivered this same
      // message (advancing the real watermark) while we were fetching.
      if (m.ts <= (state.getThread(key)?.lastSeenTs ?? thread.lastSeenTs)) continue;
      try {
        // The dispatch path advances the watermark (markThreadSeen), so a
        // replayed message is permanently consumed exactly once…
        // NOTE: history-API message objects lack `channel` (socket events have
        // it) — stamp it (and the thread root) so handlers/API calls see the
        // same shape as a live delivery.
        await dispatch({ ...m, channel, thread_ts: m.thread_ts ?? rootTs });
        replayed += 1;
      } catch (err) {
        // …unless it fails: the watermark stays put and the next pass retries
        // it (at-least-once beats silently losing it — the disease this cures).
        logErr(`catch-up replay failed (${key} ${m.ts}): ${String((err as Error)?.message ?? err)} — will retry`);
        break;
      }
    }
  }
  if (replayed)
    // logErr (ring + stderr): a replay means an envelope DIDN'T arrive live —
    // during a ghost-connection incident these lines are the evidence trail.
    logErr(`catch-up: replayed ${replayed} missed message(s) from Slack history`);
  return replayed;
}
