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

const slackFetch: NonNullable<WebClientOptions["fetch"]> = (url, init) => {
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

type SlackFailure = { code?: string; statusCode?: number; retryAfter?: number; data?: { error?: string; retry_after?: number } } | undefined;

/** The Slack API error (`channel_not_found`), else the SDK/transport code. */
export function slackErrorCode(err: unknown): string | undefined {
  const e = err as SlackFailure;
  return e?.data?.error ?? e?.code;
}

/** Retry-After seconds from the SDK error or the response body; undefined when absent or invalid. */
export function retryAfterSeconds(err: unknown): number | undefined {
  const e = err as SlackFailure;
  const value = e?.retryAfter ?? e?.data?.retry_after;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The SDK's rejectRateLimitedCalls error or a bare HTTP 429. Callers add their own extra signals. */
export function isRateLimited(err: unknown): boolean {
  const e = err as SlackFailure;
  return e?.code === "slack_webapi_rate_limited_error" || e?.statusCode === 429;
}

/** Slack refused the destination or credentials: the call had no effect and will not succeed on retry. */
export const SLACK_ACCESS_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth", "not_authed", "token_revoked", "account_inactive", "missing_scope",
  "channel_not_found", "not_in_channel", "is_archived", "no_permission", "restricted_action",
  "org_login_required", "team_access_not_granted", "ekm_access_denied", "user_not_found",
  "user_disabled", "method_not_supported_for_channel", "cannot_reply_to_message", "thread_not_found",
  "restricted_action_read_only_channel", "restricted_action_thread_only_channel",
]);

/** Slack refused the message body itself. */
export const SLACK_PAYLOAD_ERRORS: ReadonlySet<string> = new Set(["invalid_blocks", "msg_too_long"]);
