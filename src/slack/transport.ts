import { AsyncLocalStorage } from "node:async_hooks";
import type { AppOptions } from "@slack/bolt";
import { abortableFetch, HTTP_TIMEOUT_MS } from "../http.js";

export const SLACK_UPLOAD_TIMEOUT_MS = 120_000;
type WebClientOptions = NonNullable<AppOptions["clientOptions"]>;
const operation = new AsyncLocalStorage<{ signal: AbortSignal; timeoutMs: number }>();

/** Covers every filesUploadV2 stage, whose SDK methods do not forward signals. */
export function withSlackOperation<T>(signal: AbortSignal, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  return operation.run({ signal, timeoutMs }, run);
}

export const slackFetch: NonNullable<WebClientOptions["fetch"]> = (url, init) => {
  const context = operation.getStore();
  return abortableFetch(url, init, {
    signal: context?.signal,
    timeoutMs: context?.timeoutMs ?? HTTP_TIMEOUT_MS,
  });
};

/** Pass as Bolt's clientOptions AND to any separately constructed WebClient. */
export const slackWebClientOptions: WebClientOptions = {
  fetch: slackFetch,
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  // Our fetch bounds headers + body and clears its timer. SDK timeout is redundant.
  timeout: 0,
  // The bridge already schedules calls. A second queue can lose the caller's ALS context.
  maxRequestConcurrency: Infinity,
};

/** The Socket Mode client's own web client (apps.connections.open only).
 * A few quick SDK retries absorb a DNS blip right after wake; SocketSupervisor
 * owns the longer backoff. Never share slackWebClientOptions here — its
 * `retries: 0` is what made one failed lookup end Socket Mode for good. */
export const slackSocketClientOptions: WebClientOptions = {
  ...slackWebClientOptions,
  retryConfig: { retries: 3, factor: 2, minTimeout: 1_000, maxTimeout: 8_000 },
  rejectRateLimitedCalls: false,
};
