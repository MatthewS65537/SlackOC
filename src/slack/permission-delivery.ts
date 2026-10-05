import { logErr } from "../log.js";
import { permissionBlocks, permissionFallbackText } from "./blocks.js";
import {
  permissionDeliveryMarker, permissionKey,
  type PermissionDeliveryStore, type PermissionIdentity, type PermissionRecord,
} from "./permissions-store.js";

export type PermissionDestination = "thread" | "dm";
export interface PermissionCopy { ts: string; channel: string }
export interface PermissionDeliveryDeps {
  store: PermissionDeliveryStore;
  /** Includes binding generation and authoritative pending/recovery eligibility. */
  isCurrent(record: PermissionRecord): boolean;
  /** Use the bounded interactive Slack queue; it owns timeouts and 429 retries.
   * Recheck eligibility inside the queued operation before its external effect. */
  post(record: PermissionRecord, destination: PermissionDestination, text: string, blocks?: unknown[]): Promise<PermissionCopy>;
  /** Only bot-authored exact markers qualify. Incomplete/unreadable history is unknown. */
  findCopy(record: PermissionRecord, destination: PermissionDestination, marker: string): Promise<PermissionCopy | "absent" | "unknown">;
  /** Runs after durable adoption, even if the request resolved during the await. */
  onDelivered(record: PermissionRecord, destination: PermissionDestination): Promise<void> | void;
  onState?(record: PermissionRecord): Promise<void> | void;
  now?: () => number;
}

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;
const ACCESS_ERRORS = new Set([
  "invalid_auth", "not_authed", "token_revoked", "account_inactive", "missing_scope",
  "channel_not_found", "not_in_channel", "is_archived", "no_permission", "restricted_action",
  "org_login_required", "team_access_not_granted", "ekm_access_denied", "user_not_found",
  "user_disabled", "method_not_supported_for_channel", "cannot_reply_to_message", "thread_not_found",
  "restricted_action_read_only_channel", "restricted_action_thread_only_channel",
]);

function failure(error: unknown): { text: string; payload: boolean; rejected: boolean; retryAfterMs: number } {
  const e = error as { code?: string; statusCode?: number; retryAfter?: number; message?: string; data?: { error?: string; retry_after?: number } } | undefined;
  const code = e?.data?.error ?? e?.code;
  const retry = e?.retryAfter ?? e?.data?.retry_after;
  const retryAfterMs = typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? retry * 1000 : 0;
  const limited = code === "ratelimited" || code === "slack_webapi_rate_limited_error" || e?.statusCode === 429 ||
    retryAfterMs > 0 || /^HTTP 429\b/i.test(e?.message ?? "");
  const payload = code === "invalid_blocks" || code === "msg_too_long";
  return {
    text: [code, e?.message ?? (code ? undefined : String(error))].filter(Boolean).join(": ").slice(0, 1000),
    payload, rejected: payload || limited || ACCESS_ERRORS.has(code ?? ""), retryAfterMs,
  };
}

/** Caller-driven sweeps; no extra timers or transport retry loop. */
export class PermissionDeliveryManager {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, { at: number; rateUntil: number }>();
  private readonly now: () => number;
  /** Last persistence/callback failure; delivery errors live in store.get(id)[destination].error. */
  error?: string;

  constructor(private readonly deps: PermissionDeliveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Records seed missing state only; existing durable response/copies always win. */
  deliver(identity: PermissionIdentity | PermissionRecord, options: { force?: boolean } = {}): Promise<void> {
    const key = permissionKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    for (const [key, retry] of this.retries) if (retry.at <= this.now()) this.retries.delete(key);
    // Defer work until the coalescing lock is installed, including reentrant callbacks.
    const work = Promise.resolve().then(async () => {
      if (!this.deps.store.get(identity) && "permission" in identity && this.eligible(identity)) this.deps.store.put(identity);
      const outcomes = await Promise.allSettled((["thread", "dm"] as const).map(destination =>
        this.deliverDestination(identity, destination, options.force === true)));
      const errors = outcomes.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(r => r.reason), "Permission delivery state/callback failure");
    }).catch(error => {
      this.report(key, error);
      throw error;
    }).finally(() => {
      this.inFlight.delete(key);
      const record = this.deps.store.get(identity);
      if (!record || record.response.status === "resolved" || !this.deps.isCurrent(record)) {
        for (const destination of ["thread", "dm"] as const) this.retries.delete(`${key}:${destination}`);
      }
    });
    this.inFlight.set(key, work);
    return work;
  }

  private eligible(record: PermissionRecord): boolean {
    return record.response.status !== "resolved" && this.deps.isCurrent(record);
  }

  private report(context: string, error: unknown): void {
    const detail = error instanceof AggregateError ? `${error.message}: ${error.errors.map(String).join("; ")}` : String(error);
    this.error = `${context}: ${detail}`;
    logErr(`permission delivery ${this.error}`);
  }

  private async state(record: PermissionRecord | undefined): Promise<void> {
    if (!record) return;
    try { await this.deps.onState?.(record); }
    catch (error) { this.report(`${permissionKey(record)} diagnostics`, error); }
  }

  private backoff(record: PermissionRecord, destination: PermissionDestination, retryAfterMs = 0): void {
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(5, Math.max(0, record[destination].attempts - 1)));
    const now = this.now();
    this.retries.set(`${permissionKey(record)}:${destination}`, { at: now + Math.max(delay, retryAfterMs), rateUntil: now + retryAfterMs });
  }

  private async adopt(identity: PermissionIdentity, destination: PermissionDestination, copy: PermissionCopy): Promise<void> {
    // Deliberately no eligibility gate here: a late accepted copy still needs collapse.
    const record = this.deps.store.update(identity, r => {
      Object.assign(r[destination], copy, { status: "delivered", error: undefined, collapsed: false });
    });
    this.retries.delete(`${permissionKey(identity)}:${destination}`);
    if (!record) throw new Error("Permission disappeared before copy could be saved");
    await this.state(record);
    // Diagnostics can await while a response completes; give the callback the latest state.
    await this.deps.onDelivered(this.deps.store.get(identity) ?? record, destination);
  }

  private async deliverDestination(identity: PermissionIdentity, destination: PermissionDestination, force: boolean): Promise<void> {
    let record = this.deps.store.get(identity);
    if (!record || !this.eligible(record) || record[destination].status === "delivered") return;
    const retry = this.retries.get(`${permissionKey(identity)}:${destination}`);
    if (retry && (this.now() < retry.rateUntil || (!force && this.now() < retry.at))) return;
    const delivery = record[destination];
    if (delivery.status === "uncertain" || delivery.status === "in-flight") {
      let found: PermissionCopy | "absent" | "unknown";
      let historyError: string | undefined;
      try { found = await this.deps.findCopy(record, destination, permissionDeliveryMarker(record, destination)); }
      catch (error) {
        found = "unknown";
        historyError = failure(error).text;
        logErr(`permission ${record.requestId} ${destination} history: ${historyError}`);
      }
      if (typeof found === "object") return this.adopt(identity, destination, found);
      record = this.deps.store.get(identity);
      if (!record || !this.eligible(record) || record[destination].status === "delivered") return;
      // Persisted text + uncertainty means the one unconfirmed fallback was spent,
      // including a crash after marking it in-flight but before saving its result.
      if (found === "unknown" && record[destination].format === "text") {
        const updated = this.deps.store.update(identity, r => {
          r[destination].status = "uncertain";
          r[destination].error = `Delivery unconfirmed; history unavailable${historyError ? `: ${historyError}` : ""}. Text fallback already attempted.`;
        });
        if (updated) {
          this.backoff(updated, destination);
          logErr(`permission ${updated.requestId} ${destination}: ${updated[destination].error}`);
        }
        await this.state(updated);
        return;
      }
      await this.send(identity, destination, "text", found === "unknown");
      return;
    }
    await this.send(identity, destination, delivery.format, false);
  }

  private async send(identity: PermissionIdentity, destination: PermissionDestination, format: "card" | "text", uncertainPrior: boolean): Promise<void> {
    let record = this.deps.store.get(identity);
    if (!record || !this.eligible(record) || record[destination].status === "delivered") return;
    let blocks: unknown[] | undefined;
    let text: string;
    try {
      if (format === "card") blocks = permissionBlocks(record.permission, record.generation);
      text = permissionFallbackText(record.permission);
    } catch (error) {
      logErr(`permission ${record.requestId} ${destination} render: ${String(error)}`);
      format = "text";
      blocks = undefined;
      // Bad optional metadata/patterns must not break the usable command backup too.
      text = permissionFallbackText({ id: record.requestId, sessionID: record.sessionId,
        type: record.permission.type, title: record.permission.title });
    }
    text += `\n${permissionDeliveryMarker(record, destination)}`;
    record = this.deps.store.update(identity, r => {
      Object.assign(r[destination], { format, status: "in-flight", attempts: r[destination].attempts + 1, error: undefined });
    });
    if (!record) throw new Error("Permission disappeared before post");
    await this.state(record);
    record = this.deps.store.get(identity);
    if (!record || !this.eligible(record)) return;
    let copy: PermissionCopy;
    try {
      // Omit the fourth argument entirely for the text-only API call.
      copy = blocks ? await this.deps.post(record, destination, text, blocks) : await this.deps.post(record, destination, text);
    } catch (error) {
      const f = failure(error);
      logErr(`permission ${record.requestId} ${destination} ${format}: ${f.text}`);
      const updated = this.deps.store.update(identity, r => {
        r[destination].status = f.rejected && !uncertainPrior ? "rejected" : "uncertain";
        r[destination].error = f.text;
      });
      if (updated) this.backoff(updated, destination, f.retryAfterMs);
      await this.state(updated);
      if (f.payload && format === "card") await this.send(identity, destination, "text", false);
      return;
    }
    // Persistence and callback errors are NOT post rejections. Leave the durable
    // in-flight marker for adoption if saving the successful response fails.
    await this.adopt(identity, destination, copy);
  }
}
