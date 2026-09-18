/**
 * Per-channel, two-tier FIFO for outbound Slack calls (issues #5/#6, GH
 * round 2). Two facts of Slack rate limits this exploits:
 *
 *  - chat.postMessage is limited to ~1 message/second PER CHANNEL — a busy
 *    thread must never serialize behind traffic to other channels/threads.
 *  - The limit tiers are app+method scoped — a 429 anywhere means everyone
 *    pauses for Retry-After (the global brake below).
 *
 * Every op is keyed by its channel (the owner-DM channel included). Each
 * channel lane has its own ~1.05s pacing clock and drains independently,
 * interactive ops before background ops:
 *
 *  - interactive — things the user is actively waiting on: command replies,
 *    permission/question asks, cold-start acks, button-answer updates.
 *  - background (default) — run streams: ticker re-renders, sink re-homes,
 *    tool flushes, answer chunks, uploads, summaries, DMs, catch-up fetches.
 *
 * A background op pending longer than PROMOTE_AFTER_MS is served ahead of
 * younger interactive ops (anti-starvation). Without this the round-1 blast
 * radius repeats: a 10-thread catch-up sweep (~10 ops at ~1.05s) used to park
 * the single global queue for 10–16s every minute — a `\help` landing behind
 * it felt broken.
 *
 * Two failure guards (unchanged from the single-queue design):
 *
 *  - Rate limits (HTTP 429 / Retry-After) back off 2s→4s→8s and then give up.
 *  - Any single operation that never resolves (stalled upload, hung socket)
 *    times out after 30s so one bad call can't freeze its lane (head-of-line
 *    blocking); other lanes are unaffected.
 */

import { logErr } from "../log.js";

export const SLACK_OP_TIMEOUT_MS = 30_000;
/** Pacing between op starts within one channel lane. */
export const SLACK_PACE_MS = 1_050;
/** Background ops pending longer than this promote ahead of interactive traffic for one round. */
export const PROMOTE_AFTER_MS = 30_000;

export type SlackLane = "interactive" | "background";

export interface EnqueueOpts {
  /** Every outbound Slack call is channel-bound — this drives lane pacing. */
  channel: string;
  /** "interactive" jumps ahead of queued background work in the same channel. */
  lane?: SlackLane;
}

interface QueuedOp {
  run: () => Promise<void>;
  enqueuedAt: number;
  lane: SlackLane;
}

interface ChannelLane {
  interactive: QueuedOp[];
  background: QueuedOp[];
  lastCall: number;
  draining: boolean;
}

const lanes = new Map<string, ChannelLane>();
/** 429 brake: all lanes hold until this time (Slack limits are app+method scoped). */
let globalCooldownUntil = 0;
let droppedOps = 0;

/** Ops that failed permanently (retry exhaustion, timeout, hard error) and were dropped — surfaced in \status. */
export function droppedOpCount(): number {
  return droppedOps;
}

/** Total pending ops across every channel lane (drives the \status queue line). */
export function queueDepth(): number {
  let n = 0;
  for (const lane of lanes.values()) n += lane.interactive.length + lane.background.length;
  return n;
}

/** Pending ops in ONE channel's lane — tick-yield and the sink circuit breaker are channel-local. */
export function laneDepth(channel: string): number {
  const lane = lanes.get(channel);
  return lane ? lane.interactive.length + lane.background.length : 0;
}

/** Age of the oldest pending op across all lanes — queue-health signal for \status. */
export function oldestPendingAgeMs(now = Date.now()): number {
  let oldest = 0;
  for (const lane of lanes.values()) {
    for (const arr of [lane.interactive, lane.background]) {
      for (const op of arr) oldest = Math.max(oldest, now - op.enqueuedAt);
    }
  }
  return oldest;
}

function getLane(channel: string): ChannelLane {
  let lane = lanes.get(channel);
  if (!lane) {
    lane = { interactive: [], background: [], lastCall: 0, draining: false };
    lanes.set(channel, lane);
  }
  return lane;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`slack call timed out (${SLACK_OP_TIMEOUT_MS / 1000}s)`)), SLACK_OP_TIMEOUT_MS),
    ),
  ]);
}

/** Next op to run: starving background first, then interactive, then background FIFO. */
function takeNext(lane: ChannelLane): QueuedOp | undefined {
  const bgOldest = lane.background[0];
  if (bgOldest && Date.now() - bgOldest.enqueuedAt > PROMOTE_AFTER_MS) {
    lane.background.shift();
    return bgOldest;
  }
  if (lane.interactive.length) return lane.interactive.shift()!;
  return lane.background.shift();
}

export function enqueue<T>(op: () => Promise<T>, opts: EnqueueOpts): Promise<T> {
  const lane = getLane(opts.channel);
  const laneKind = opts.lane ?? "background";
  return new Promise<T>((resolve, reject) => {
    (laneKind === "interactive" ? lane.interactive : lane.background).push({
      enqueuedAt: Date.now(),
      lane: laneKind,
      run: async () => {
        // Pacing: this lane starts ops at most once per SLACK_PACE_MS.
        const gap = SLACK_PACE_MS - (Date.now() - lane.lastCall);
        if (gap > 0) await sleep(gap);
        // Brake: a 429 anywhere holds everyone for Retry-After.
        const brake = globalCooldownUntil - Date.now();
        if (brake > 0) await sleep(brake);
        lane.lastCall = Date.now();
        for (let attempt = 0; ; attempt++) {
          try {
            resolve(await withTimeout(op()));
            return;
          } catch (err) {
            const e = err as { data?: { retry_after?: number }; message?: string };
            const retryAfter = e?.data?.retry_after;
            if (attempt < 3 && (retryAfter || /rate.?limit|429/i.test(String(e?.message)))) {
              const waitMs = retryAfter ? retryAfter * 1000 : 2000 * 2 ** attempt;
              globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + waitMs);
              await sleep(waitMs);
              continue;
            }
            // Permanent failure — the op is dropped. NEVER silently: a summary
            // or answer can vanish this way, and from a phone there is no
            // console to notice it in. Log it and count it for \status (RB5).
            droppedOps += 1;
            logErr(`slack op dropped after ${attempt + 1} attempt(s): ${String((err as Error)?.message ?? err)}`);
            reject(err);
            return;
          }
        }
      },
    });
    void drain(lane);
  });
}

async function drain(lane: ChannelLane): Promise<void> {
  if (lane.draining) return;
  lane.draining = true;
  try {
    for (;;) {
      const op = takeNext(lane);
      if (!op) break;
      await op.run();
    }
  } finally {
    lane.draining = false;
  }
}

/** Test hook: reset all lanes/brake/drop state between test cases with fresh fake timers. */
export function _resetQueueForTests(): void {
  lanes.clear();
  globalCooldownUntil = 0;
  droppedOps = 0;
}
