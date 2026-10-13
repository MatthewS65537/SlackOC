import { logErr } from "../log.js";
import { permissionBlocks, permissionFallbackText } from "./blocks.js";
import {
  permissionDeliveryMarker, permissionKey,
  type PermissionDeliveryStore, type PermissionIdentity, type PermissionRecord,
} from "./permissions-store.js";
import { retryAfterSeconds, SLACK_ACCESS_ERRORS, SLACK_PAYLOAD_ERRORS, slackErrorCode } from "./transport.js";
import { markerMetadata, type MarkerMetadata } from "./markers.js";

export type PermissionDestination = "thread" | "dm";

/** Invisible delivery marker for a copy; the visible text carries none (web/slack-message-metadata.md). */
export function permissionMarkerMetadata(record: PermissionRecord, destination: PermissionDestination): MarkerMetadata {
  return markerMetadata("permission", record.requestId, permissionDeliveryMarker(record, destination));
}
export interface PermissionCopy { ts: string; channel: string }
export interface PermissionDeliveryDeps {
  store: PermissionDeliveryStore;
  /** Includes binding generation and authoritative pending/recovery eligibility. */
  isCurrent(record: PermissionRecord): boolean;
  /** Use the bounded interactive Slack queue; it owns timeouts and 429 retries.
   * Recheck eligibility inside the queued operation before its external effect.
   * Must attach `permissionMarkerMetadata(record, destination)`: it is what findCopy matches. */
  post(record: PermissionRecord, destination: PermissionDestination, text: string, blocks?: unknown[]): Promise<PermissionCopy>;
  /** Only bot-authored exact markers qualify (metadata payload, or text on pre-metadata copies).
   * Incomplete/unreadable history is unknown. */
  findCopy(record: PermissionRecord, destination: PermissionDestination, marker: string): Promise<PermissionCopy | "absent" | "unknown">;
  /** Runs after durable adoption, even if the request resolved during the await. */
  onDelivered(record: PermissionRecord, destination: PermissionDestination): Promise<void> | void;
  onState?(record: PermissionRecord): Promise<void> | void;
  now?: () => number;
}

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;
/** Unreadable/incomplete history for a resolved request's copy: search again no sooner than this. */
const TERMINAL_RETRY_MS = 5 * 60_000;
function failure(error: unknown): { text: string; payload: boolean; rejected: boolean; retryAfterMs: number } {
  const e = error as { statusCode?: number; message?: string } | undefined;
  const code = slackErrorCode(error);
  const retryAfterMs = (retryAfterSeconds(error) ?? 0) * 1000;
  // `code` (not isRateLimited's raw SDK code): a body error wins over the SDK code here.
  const limited = code === "ratelimited" || code === "slack_webapi_rate_limited_error" || e?.statusCode === 429 ||
    retryAfterMs > 0 || /^HTTP 429\b/i.test(e?.message ?? "");
  const payload = SLACK_PAYLOAD_ERRORS.has(code ?? "");
  return {
    text: [code, e?.message ?? (code ? undefined : String(error))].filter(Boolean).join(": ").slice(0, 1000),
    payload, rejected: payload || limited || SLACK_ACCESS_ERRORS.has(code ?? ""), retryAfterMs,
  };
}

/** Caller-driven sweeps; no extra timers or transport retry loop. */
export class PermissionDeliveryManager {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, { at: number; rateUntil: number }>();
  private readonly now: () => number;

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

  /**
   * Marker-only recovery for a resolved request's unconfirmed copies: a proven
   * copy is adopted (onDelivered collapses it); proven absence ends the search.
   * Never posts, and unknown history keeps the copy uncertain.
   */
  recoverTerminal(identity: PermissionIdentity): Promise<void> {
    const key = permissionKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = Promise.resolve().then(async () => {
      await Promise.all((["thread", "dm"] as const).map(async destination => {
        const record = this.deps.store.get(identity);
        if (record?.response.status !== "resolved" || !["uncertain", "in-flight"].includes(record[destination].status)) return;
        const retryKey = `${key}:${destination}:terminal`;
        if ((this.retries.get(retryKey)?.at ?? 0) > this.now()) return;
        let found: PermissionCopy | "absent" | "unknown";
        try { found = await this.deps.findCopy(record, destination, permissionDeliveryMarker(record, destination)); }
        catch (error) {
          found = "unknown";
          logErr(`permission ${record.requestId} ${destination} terminal history: ${failure(error).text}`);
        }
        if (found === "unknown") { this.retries.set(retryKey, { at: this.now() + TERMINAL_RETRY_MS, rateUntil: 0 }); return; }
        this.retries.delete(retryKey);
        if (typeof found === "object") return this.adopt(identity, destination, found);
        if (found === "absent") this.deps.store.update(identity, r => {
          if (["uncertain", "in-flight"].includes(r[destination].status)) r[destination].status = "rejected";
        });
      }));
    }).catch(error => this.report(key, error)).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, work);
    return work;
  }

  private eligible(record: PermissionRecord): boolean {
    return record.response.status !== "resolved" && this.deps.isCurrent(record);
  }

  private report(context: string, error: unknown): void {
    const detail = error instanceof AggregateError ? `${error.message}: ${error.errors.map(String).join("; ")}` : String(error);
    // Delivery errors live in store.get(id)[destination].error; this logs persistence/callback failures.
    logErr(`permission delivery ${context}: ${detail}`);
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
