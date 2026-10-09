import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import type { ServerPool } from "../opencode/server.js";
import { sessionMessages } from "../opencode/client.js";
import { sweepMissedMessages, sweepTopLevelMessages, type CatchupDeps } from "./catchup.js";
import { compareTs, isRecentRecoveryEligibleReceipt, isRecentRecoveryEligibleThread } from "./recovery-policy.js";
import type { SlackMsg } from "./router.js";
import { enqueue } from "./queue.js";
import type { GhostDetector } from "../ghosts.js";
import { logErr, pushLog } from "../log.js";

const MAX_TOP_LEVEL_PAGES = 3;

/** Returns the single-flight catch-up pass (acceptance recovery + missed-message sweep); calls coalesce. */
export function createCatchupRunner(app: App, deps: {
  state: StateStore;
  pool: ServerPool;
  ownerSlackUserId: string;
  ghost: GhostDetector;
  isStopping: () => boolean;
  dispatch: CatchupDeps["dispatch"];
  /** \listen channels + owner DM: swept for missed top-level prompts. */
  topLevelChannels: () => string[];
}): (boot?: boolean) => Promise<void> {
  const { state, pool, ghost, isStopping } = deps;
  // Fair, bounded history recovery for retained threads. Older threads rotate
  // more slowly; a confirmed cursor is distinct from the newest live event.
  const catchupDeps: CatchupDeps = {
    state,
    ownerSlackUserId: deps.ownerSlackUserId,
    fetchReplies: async (channel, rootTs, oldest, { maxPages, latest, inclusive, cursor: startCursor }) => {
      const out: SlackMsg[] = [];
      let cursor: string | undefined = startCursor;
      let pagesUsed = 0;
      let hasMore = false;
      do {
        // Background: a sweep can fan out across ~10 threads — it must
        // never hold up commands/prompts in their channels (issue #5).
        const r = (await enqueue(
          () => app.client.conversations.replies({ channel, ts: rootTs, oldest, latest, inclusive, limit: 100, ...(cursor ? { cursor } : {}) }),
          { channel, method: "conversations.replies", lane: "background" },
        )) as { messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
        out.push(...((r.messages ?? []) as SlackMsg[]));
        pagesUsed++;
        cursor = r.response_metadata?.next_cursor || undefined;
        hasMore = !!cursor || !!r.has_more;
      } while (cursor && pagesUsed < maxPages && !isStopping());
      return { messages: out.sort((a, b) => compareTs(a.ts, b.ts)), hasMore, pagesUsed, nextCursor: cursor };
    },
    dispatch: (m, context) => isStopping() ? Promise.resolve("retry" as const) : deps.dispatch(m, context),
  };
  // Top-level history: newest-first pages, so fetch the whole gap (bounded) and sort.
  const fetchHistory = async (channel: string, oldest: string) => {
    const out: SlackMsg[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = (await enqueue(
        () => app.client.conversations.history({ channel, oldest, limit: 100, ...(cursor ? { cursor } : {}) }),
        { channel, method: "conversations.history", lane: "background" },
      )) as { messages?: unknown[]; response_metadata?: { next_cursor?: string } };
      out.push(...((r.messages ?? []) as SlackMsg[]));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && ++pages < MAX_TOP_LEVEL_PAGES && !isStopping());
    return { messages: out.sort((a, b) => compareTs(a.ts, b.ts)), hasMore: !!cursor };
  };
  let catchupFlight: Promise<void> | undefined;
  let catchupRequested = false;
  let receiptOffset = 0;
  const runCatchup = (boot = false): Promise<void> => {
    if (isStopping()) return Promise.resolve();
    if (catchupFlight) { catchupRequested = true; return catchupFlight; }
    catchupFlight = (async () => {
    do {
    catchupRequested = false;
    try {
      // Exact user-message IDs prove acceptance after an HTTP timeout or crash.
      // Check the stored session, which may differ from the thread's new binding.
      const pending = state.messageReceipts().filter(r => {
        if (r.disposition !== "uncertain" || !r.submission || !isRecentRecoveryEligibleReceipt(r, state.now())) return false;
        const thread = state.getThread(r.threadKey);
        const canceled = state.cancellationThrough(r.threadKey);
        return thread?.sessionId === r.submission.sessionId && thread.projectDir === r.submission.projectDir &&
          isRecentRecoveryEligibleThread(thread, state.now()) && (!canceled || compareTs(r.ts, canceled) > 0) &&
          (r.generation === undefined || r.generation === state.bindingGeneration(r.threadKey));
      });
      const groups = [...new Map(pending.map(r => [r.submission!.sessionId, r.submission!])).values()];
      for (let i = 0; i < Math.min(groups.length, 4) && !isStopping(); i++) {
        const ref = groups[(receiptOffset + i) % groups.length]!;
        try {
          const lease = await pool.acquire(ref.projectDir);
          try {
            for (const m of await sessionMessages(lease.entry.client!, ref.sessionId)) {
              state.reconcilePromptAcceptance(ref.projectDir, m.info);
            }
          } finally { lease.release(); }
        } catch (err) { pushLog(`acceptance recovery (${ref.sessionId}): ${String(err)}`); }
      }
      if (groups.length) receiptOffset = (receiptOffset + 4) % groups.length;
      if (isStopping()) return;
      const n = await sweepMissedMessages(catchupDeps) + (isStopping() ? 0 : await sweepTopLevelMessages({ state,
        ownerSlackUserId: deps.ownerSlackUserId, channels: deps.topLevelChannels(), fetchHistory, dispatch: catchupDeps.dispatch }));
      if (n && !boot) ghost.noteReplayed(n); // boot pass replays are the restart gap, not a ghost
      const warn = ghost.check();
      if (warn) logErr(warn);
    } catch (err) {
      logErr(`catch-up sweep failed: ${String((err as Error)?.message ?? err)}`);
    }
    } while (catchupRequested && !isStopping());
    })().finally(() => { catchupFlight = undefined; });
    return catchupFlight;
  };
  return runCatchup;
}
