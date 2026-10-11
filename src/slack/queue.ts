/**
 * Per-channel, two-tier queue for outbound Slack calls (issues #5/#6, GH
 * round 2). Two facts of Slack rate limits this exploits:
 *
 *  - chat.postMessage is limited to ~1 message/second PER CHANNEL — a busy
 *    thread must never serialize behind traffic to other channels.
 *  - The limit tiers are app+method scoped — a 429 pauses that method across
 *    channels for Retry-After, without stopping other methods.
 *
 * Writes (posts, updates, deletes, uploads, ephemerals) to one channel share
 * ONE lane that runs a single op at a time, so an op starts only after the
 * previous one went through. Within a thread (`EnqueueOpts.thread`) writes are
 * strictly FIFO — a question card can never land above the paragraph produced
 * before it. Across threads the tiers still apply:
 *
 *  - interactive — things the user is actively waiting on: command replies,
 *    permission/question asks, cold-start acks, button-answer updates.
 *  - background (default) — run streams: ticker re-renders, sink re-homes,
 *    tool flushes, answer chunks, uploads, summaries, DMs, catch-up fetches.
 *
 * An op is eligible only when no older op of its thread is pending; an op
 * without a thread is a barrier (nothing passes it, it passes nothing). Among
 * eligible ops a background op pending longer than PROMOTE_AFTER_MS goes
 * first (anti-starvation), then interactive, then background FIFO.
 * Reads (conversations.*) keep their own per-method lanes with the same tiers
 * and no thread ordering. Only posts use the ~1.05s channel pacing clock;
 * history starts share a 1.5s clock across channels.
 *
 * Failure guards:
 *
 *  - Rate limits (HTTP 429 / Retry-After) back off 2s→4s→8s and then give up.
 *  - Transient network errors (DNS, refused, reset — e.g. right after wake)
 *    retry 1s→2s→4s→8s. Posts and uploads retry only when the request
 *    provably never reached Slack, so a retry cannot duplicate a message.
 *    Repeated network failures engage a shared offline brake so every lane
 *    waits instead of each burning its attempts (and the log) in parallel.
 *  - Any single operation that never resolves (stalled upload, hung socket)
 *    times out after 30s so one bad call can't freeze its lane (head-of-line
 *    blocking); other lanes are unaffected.
 */

import { logErr } from "../log.js";
import { withDeadline } from "../http.js";
import { isRateLimited, retryAfterSeconds, withSlackOperation } from "./transport.js";

export const SLACK_OP_TIMEOUT_MS = 30_000;
/** Pacing between op starts within one channel lane. */
export const SLACK_PACE_MS = 1_050;
/** Shared history spacing: 40 starts/minute, below Slack's internal-app Tier 3 allowance. */
export const SLACK_HISTORY_PACE_MS = 1_500;
/** Background ops pending longer than this promote ahead of interactive traffic for one round. */
export const PROMOTE_AFTER_MS = 30_000;

export type SlackLane = "interactive" | "background";

export interface EnqueueOpts {
  /** Slack rate limits are method/workspace scoped; only posts share the channel clock. */
  method?: string;
  /** Every outbound Slack call is channel-bound — this drives lane pacing. */
  channel: string;
  /** "interactive" jumps ahead of queued background work in OTHER threads of the channel. */
  lane?: SlackLane;
  /** Thread ts ("" = top level) — writes within one thread never reorder. Omitted = barrier. */
  thread?: string;
  /** End-to-end budget per attempt; uploads should use SLACK_UPLOAD_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Multi-stage uploads should disable replay of the entire operation on 429. */
  retryRateLimits?: boolean;
}

interface QueuedOp {
  run: () => Promise<void>;
  enqueuedAt: number;
  lane: SlackLane;
  thread?: string;
}

interface ChannelLane {
  /** Pending ops in enqueue order. */
  ops: QueuedOp[];
  /** Write lanes order by thread; read lanes don't. */
  ordered: boolean;
  lastPost: number;
  draining: boolean;
}

const lanes = new Map<string, ChannelLane>();
/** 429 brakes shared by all channels using the affected method. */
const cooldowns = new Map<string, number>();
let nextHistoryCallAt = 0;
let droppedOps = 0;
/** Shared network brake: consecutive transient failures across all lanes. */
let offlineUntil = 0;
let transientStreak = 0;
const TRANSIENT_RETRIES = 4;
const OFFLINE_BRAKE_AFTER = 3;
const OFFLINE_BRAKE_MAX_MS = 30_000;

/** Error codes proving the request never reached Slack (safe to replay any call). */
const CONNECT_PHASE = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH",
  "ENETDOWN", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT", "CERT_HAS_EXPIRED"]);
/** Error codes where the request may or may not have landed. */
const MID_FLIGHT = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNABORTED"]);

/** "connect": never reached Slack · "ambiguous": network failed mid-request · null: not a network error. */
export function classifyTransport(err: unknown): "connect" | "ambiguous" | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown; original?: unknown }).original ?? (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: string }).code;
    if (code && CONNECT_PHASE.has(code)) return "connect";
    if (code && MID_FLIGHT.has(code)) return "ambiguous";
  }
  const msg = String((err as Error)?.message ?? err);
  return /fetch failed|socket hang up|network/i.test(msg) ? "ambiguous" : null;
}

/** True while repeated network failures have engaged the shared brake (catch-up skips its sweep). */
export function slackOffline(now = Date.now()): boolean {
  return offlineUntil > now;
}

/** Socket reconnected — Slack is reachable again; release the brake immediately. */
export function noteSlackOnline(): void {
  offlineUntil = 0;
  transientStreak = 0;
}

function noteTransient(): void {
  transientStreak += 1;
  if (transientStreak >= OFFLINE_BRAKE_AFTER) {
    const ms = Math.min(OFFLINE_BRAKE_MAX_MS, 2_000 * 2 ** Math.min(transientStreak - OFFLINE_BRAKE_AFTER, 4));
    offlineUntil = Math.max(offlineUntil, Date.now() + ms);
  }
}

/** Ops that failed permanently (retry exhaustion, timeout, hard error) and were dropped — surfaced in \status. */
export function droppedOpCount(): number {
  return droppedOps;
}

/** Total pending ops across every channel lane (drives the \status queue line). */
export function queueDepth(): number {
  let n = 0;
  for (const lane of lanes.values()) n += lane.ops.length;
  return n;
}

/** Pending ops in ONE channel's lane — tick-yield and the sink circuit breaker are channel-local. */
export function laneDepth(channel: string): number {
  let n = 0;
  for (const [key, lane] of lanes) if (key.endsWith(`:${channel}`)) n += lane.ops.length;
  return n;
}

/** Age of the oldest pending op across all lanes — queue-health signal for \status. */
export function oldestPendingAgeMs(now = Date.now()): number {
  let oldest = 0;
  for (const lane of lanes.values()) for (const op of lane.ops) oldest = Math.max(oldest, now - op.enqueuedAt);
  return oldest;
}

function getLane(key: string, ordered: boolean): ChannelLane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { ops: [], ordered, lastPost: 0, draining: false };
    lanes.set(key, lane);
  }
  return lane;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Next op to run among eligible ops: starving background, then interactive, then background FIFO. */
function takeNext(lane: ChannelLane): QueuedOp | undefined {
  const seen = new Set<string>();
  let interactive = -1;
  let background = -1;
  let pick = -1;
  for (let i = 0; i < lane.ops.length; i++) {
    const op = lane.ops[i]!;
    if (lane.ordered) {
      if (op.thread === undefined) { if (i === 0) pick = 0; break; } // barrier
      if (seen.has(op.thread)) continue; // an older op of this thread goes first
      seen.add(op.thread);
    }
    if (op.lane === "interactive") { if (interactive < 0) interactive = i; continue; }
    if (background < 0) {
      background = i;
      if (Date.now() - op.enqueuedAt > PROMOTE_AFTER_MS) { pick = i; break; }
    }
  }
  if (pick < 0) pick = interactive >= 0 ? interactive : background;
  return pick < 0 ? undefined : lane.ops.splice(pick, 1)[0];
}

/** Methods where an ambiguous network failure may already have taken effect. */
const NON_IDEMPOTENT = new Set(["chat.postMessage", "files.upload", "filesUploadV2", "chat.postEphemeral"]);

export function enqueue<T>(op: (signal: AbortSignal) => Promise<T>, opts: EnqueueOpts): Promise<T> {
  const method = opts.method ?? "chat.postMessage";
  const read = method.startsWith("conversations.");
  const lane = getLane(read ? `${method}:${opts.channel}` : `write:${opts.channel}`, !read);
  const pace = method === "chat.postMessage" ? SLACK_PACE_MS : 0;
  const laneKind = opts.lane ?? "background";
  return new Promise<T>((resolve, reject) => {
    lane.ops.push({
      enqueuedAt: Date.now(),
      lane: laneKind,
      thread: opts.thread,
      run: async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            // Re-check after every wake: another lane may have extended the brake.
            for (;;) {
              const wait = Math.max(pace ? lane.lastPost + pace : 0, cooldowns.get(method) ?? 0, offlineUntil,
                method === "conversations.replies" ? nextHistoryCallAt : 0) - Date.now();
              if (wait <= 0) break;
              await sleep(wait);
            }
            if (pace) lane.lastPost = Date.now();
            // Reserve before any await so cross-channel waiters cannot start together.
            if (method === "conversations.replies") nextHistoryCallAt = Date.now() + SLACK_HISTORY_PACE_MS;
            const timeoutMs = opts.timeoutMs ?? SLACK_OP_TIMEOUT_MS;
            const result = await withDeadline(
              (signal) => withSlackOperation(signal, timeoutMs, () => op(signal)),
              { timeoutMs }, "slack call",
            );
            transientStreak = 0;
            offlineUntil = 0;
            resolve(result);
            return;
          } catch (err) {
            const retryAfter = retryAfterSeconds(err);
            const limited = isRateLimited(err) || retryAfter !== undefined || /^HTTP 429\b/i.test((err as Error)?.message ?? "");
            if (limited) {
              const waitMs = retryAfter !== undefined ? retryAfter * 1000 : 2000 * 2 ** Math.min(attempt, 2);
              cooldowns.set(method, Math.max(cooldowns.get(method) ?? 0, Date.now() + waitMs));
              if (attempt < 3 && opts.retryRateLimits !== false) continue;
            }
            const transport = limited ? null : classifyTransport(err);
            if (transport) {
              noteTransient();
              // Posts/uploads only replay when the request never left the machine.
              const replaySafe = transport === "connect" || !NON_IDEMPOTENT.has(method);
              if (replaySafe && attempt < TRANSIENT_RETRIES && opts.retryRateLimits !== false) {
                await sleep(1_000 * 2 ** Math.min(attempt, 3));
                continue;
              }
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
  cooldowns.clear();
  nextHistoryCallAt = 0;
  droppedOps = 0;
  offlineUntil = 0;
  transientStreak = 0;
}
