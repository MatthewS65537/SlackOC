/**
 * Global FIFO for outbound Slack calls. chat.postMessage is rate limited
 * (~1/s sustained); serializing every call through one queue keeps order and
 * paces bursts. Two failure guards:
 *
 *  - Rate limits (HTTP 429 / Retry-After) back off 2s→4s→8s and then give up.
 *  - Any single operation that never resolves (stalled upload, hung socket)
 *    times out after 30s so one bad call can't freeze every message queued
 *    behind it (head-of-line blocking).
 */

import { logErr } from "../log.js";

export const SLACK_OP_TIMEOUT_MS = 30_000;

export interface SlackQueue {
  enqueue<T>(op: () => Promise<T>): Promise<T>;
}

const queue: Array<() => Promise<unknown>> = [];
let draining = false;
let lastCall = 0;
let droppedOps = 0;

/** Ops that failed permanently (retry exhaustion, timeout, hard error) and were dropped — surfaced in \status. */
export function droppedOpCount(): number {
  return droppedOps;
}

export function queueDepth(): number {
  return queue.length;
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

export function enqueue<T>(op: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(async () => {
      const gap = 1050 - (Date.now() - lastCall);
      if (gap > 0) await sleep(gap);
      lastCall = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          resolve(await withTimeout(op()));
          return;
        } catch (err) {
          const e = err as { data?: { retry_after?: number }; message?: string };
          const retryAfter = e?.data?.retry_after;
          if (attempt < 3 && (retryAfter || /rate.?limit|429/i.test(String(e?.message)))) {
            await sleep(retryAfter ? retryAfter * 1000 : 2000 * 2 ** attempt);
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
    });
    void drain();
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const op = queue.shift()!;
    await op();
  }
  draining = false;
}

/** Test hook: reset pacing/drain/drop state between test cases with fresh fake timers. */
export function _resetQueueForTests(): void {
  queue.length = 0;
  draining = false;
  lastCall = 0;
  droppedOps = 0;
}
