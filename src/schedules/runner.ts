import { randomBytes } from "node:crypto";
import type { PermissionRuleset, SessionCreateInput, SessionInfo } from "@opencode/client";
import type { OCClient } from "../opencode/api.js";
import { pendingPermissions, pendingQuestions, promptAsync, sessionAbort, sessionIdle, sessionMessages } from "../opencode/client.js";
import type { ServerPool } from "../opencode/server.js";
import { canonicalDir } from "../paths.js";
import type { ScheduleJob, ScheduleRun, ScheduleStore } from "./store.js";

export const MAX_REPORT_BYTES = 64 * 1024;
const DEADLINE = "Report runtime deadline exceeded";
const TERMINAL = new Set<ScheduleRun["status"]>(["delivered", "failed", "canceled", "skipped"]);

/** Native V2 rules are last-match-wins. Unknown tools/MCP actions stay denied. */
export function reportPermissions(): PermissionRuleset {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "webfetch", "websearch", "question"].map(action => ({ action, resource: "*", effect: "allow" as const })),
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "ask" },
    ...["edit", "shell", "subagent", "execute", "skill"].map(action => ({ action, resource: "*", effect: "deny" as const })),
  ];
}

/** Require the attached policy itself, not agent defaults or prompt assurances. */
export function hasReportPermissions(permissions: unknown): boolean {
  const expected = reportPermissions();
  return Array.isArray(permissions) && permissions.length === expected.length && expected.every((rule, i) => {
    const actual = permissions[i];
    return actual?.action === rule.action && actual?.resource === rule.resource && actual?.effect === rule.effect;
  });
}

export interface ReportRunnerOptions {
  store: Pick<ScheduleStore, "run" | "updateRun">;
  pool: Pick<ServerPool, "acquire">;
  now?: () => number;
  signal?: AbortSignal;
  /** Reconcile/create the private owner-DM root and bind the known session.
   * Must be idempotent, and recheck store cancellation inside queued Slack work. */
  ensureContext(run: ScheduleRun): Promise<{ channel: string; ts: string }>;
  /** Update the DM context root, or post a channel report with a stable run marker.
   * The queue owns transport retries; recheck cancellation immediately before sending. */
  deliver(run: ScheduleRun): Promise<{ channel: string; ts: string }>;
  /** Bounded, bot-authored exact-marker evidence only. Absence never permits reposting. */
  findDelivery(run: ScheduleRun): Promise<{ channel: string; ts: string } | undefined>;
  /** Use the private queue and recheck cancellation before the external effect. */
  notify(run: ScheduleRun, text: string): Promise<void>;
  /** Called after durable delivered transition. Idempotent binding of the confirmed
   * report thread; do not remove unrelated bindings. Pending work survives failure. */
  onDelivered?(run: ScheduleRun): Promise<void>;
}

class Stopped extends Error {}
class DeadlineExceeded extends Error {}
class PolicyError extends Error {}
type Transcript = Awaited<ReturnType<typeof sessionMessages>>;

function errorText(error: unknown): string {
  const e = error as { message?: string; data?: { error?: string }; code?: string } | undefined;
  return [e?.data?.error ?? e?.code, e?.message ?? (typeof error === "string" ? error : undefined)]
    .filter(Boolean).join(": ").slice(0, 1000) || "Report operation failed";
}

const SLACK_REJECTIONS = new Set([
  "invalid_blocks", "msg_too_long", "invalid_arguments", "invalid_arg_name", "invalid_auth", "not_authed",
  "token_revoked", "account_inactive", "missing_scope", "channel_not_found", "not_in_channel", "is_archived",
  "no_permission", "restricted_action", "org_login_required", "team_access_not_granted", "ekm_access_denied",
  "user_not_found", "user_disabled", "method_not_supported_for_channel", "message_not_found", "cant_update_message",
  "cannot_reply_to_message", "thread_not_found", "restricted_action_read_only_channel", "restricted_action_thread_only_channel",
]);

/** A transport error, 5xx, or unfamiliar Slack error is not proof of rejection. */
/** Non-rate-limit rejections are terminal after this many delivery attempts. */
const PERMANENT_REJECTION_ATTEMPTS = 5;

function rateLimited(error: unknown): boolean {
  const e = error as { code?: string; statusCode?: number; data?: { error?: string } } | undefined;
  return e?.code === "slack_webapi_rate_limited_error" || e?.statusCode === 429 || e?.data?.error === "ratelimited";
}

function definiteDeliveryRejection(error: unknown): boolean {
  const e = error as { code?: string; statusCode?: number; data?: { ok?: boolean; error?: string } } | undefined;
  return e?.code === "slack_webapi_rate_limited_error" || e?.statusCode === 429 ||
    (e?.data?.ok === false && (e.data.error === "ratelimited" || SLACK_REJECTIONS.has(e.data.error ?? "")));
}

function admission(messages: Transcript, run: ScheduleRun): boolean {
  return messages.some(row => row.info.role === "user" && row.info.sessionID === run.sessionId && row.info.id === run.messageId);
}

function completedReport(messages: Transcript, run: ScheduleRun): { output?: string; error?: string } | undefined {
  const userIndex = messages.findIndex(row => row.info.role === "user" && row.info.sessionID === run.sessionId && row.info.id === run.messageId);
  if (userIndex < 0) return;
  const users = messages.filter(row => row.info.role === "user");
  if (users.some(row => row.info.id !== run.messageId)) return { error: "The report session contains an unrelated prompt; output withheld" };
  const tail = messages.filter(row => row.info.role === "assistant").at(-1);
  if (!tail || tail.info.sessionID !== run.sessionId || tail.info.summary) return;
  const info = tail.info;
  const user = messages[userIndex]!.info;
  // Older ports may omit parentID: the sole exact prompt and transcript order
  // then establish correlation. Never substitute timestamps for a present parentID.
  if (info.parentID !== undefined ? info.parentID !== run.messageId :
    messages.indexOf(tail) <= userIndex || !Number.isFinite(user.time?.created) || (info.time?.created ?? -1) < user.time!.created) return;
  if (!Number.isFinite(info.time?.created) || !Number.isFinite(info.time?.completed) || info.time!.completed! < info.time!.created) return;
  if (info.error) return { error: String(info.error.data?.message ?? info.error.name ?? "Report generation failed").slice(0, 1000) };
  if (info.finish === "error" || info.finish === "content-filter") return { error: `Report generation ended with ${info.finish}` };
  if (info.finish !== "stop" && info.finish !== "length") return;
  const tools = messages.filter((row, index) => row.info.role === "assistant" && row.info.sessionID === run.sessionId &&
    (row.info.parentID === run.messageId || (row.info.parentID === undefined && index > userIndex)))
    .flatMap(row => row.parts).filter(part => part.type === "tool");
  if (tools.some(part => part.state?.status !== "completed" && part.state?.status !== "error")) return;
  const text = tail.parts.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n").trim();
  if (!text) return { error: "Report completed without a final text response" };
  if (text.includes("\0")) return { error: "Report text contains an unsupported null character" };
  // Drop an incomplete UTF-8 code point rather than exceeding the byte cap.
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, MAX_REPORT_BYTES);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const output = bytes.subarray(0, end).toString("utf8").trimEnd();
  return { output };
}

function creationInput(job: ScheduleJob): SessionCreateInput {
  let model: SessionCreateInput["model"];
  if (job.model) {
    const slash = job.model.indexOf("/");
    const [id, variant] = job.model.slice(slash + 1).split("#");
    if (slash <= 0 || !id) throw new PolicyError("Invalid saved report model");
    model = { providerID: job.model.slice(0, slash), id, ...(variant ? { variant } : {}) };
  }
  return { title: `Scheduled report: ${job.name}`, location: { directory: job.projectDir },
    permissions: reportPermissions(), ...(job.agent ? { agent: job.agent } : {}), ...(model ? { model } : {}) };
}

/** Caller-driven bounded steps. No model wait, timer, SSE dependency, or prompt retry. */
export class ReportRunner {
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly retries = new Map<string, { attempts: number; at: number }>();

  constructor(private readonly options: ReportRunnerOptions) { this.now = options.now ?? Date.now; }

  tick(run: ScheduleRun): Promise<void> {
    const existing = this.inFlight.get(run.id);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const work = Promise.resolve().then(async () => {
      try {
        const current = this.current(run.id);
        if (current.status === "delivered" && current.deliveryBindingPending) { await this.finishBinding(current.id); return; }
        if (current.status === "failed") { await this.notifyFailure(current.id); return; }
        if (TERMINAL.has(current.status)) return;
        this.check(run.id);
        switch (current.status) {
          case "claimed": await this.withClient(run.id, client => this.create(run.id, client)); break;
          case "creating":
            if (!current.sessionId) this.update(run.id, r => { r.status = "uncertain"; r.error = "Session creation outcome is unknown; no replacement session will be created"; });
            else if (current.messageId) await this.withClient(run.id, client => this.poll(run.id, client));
            else await this.withClient(run.id, client => this.submit(run.id, client));
            break;
          case "ready": await this.deliver(run.id); break;
          case "delivering": await this.reconcileDelivery(run.id); break;
          case "uncertain":
            if (current.output !== undefined) await this.reconcileDelivery(run.id);
            else if (current.sessionId && current.messageId) await this.withClient(run.id, client => this.poll(run.id, client));
            else if (current.sessionId) await this.withClient(run.id, client => this.submit(run.id, client));
            break;
          case "submitting": case "running": case "waiting":
            await this.withClient(run.id, client => this.poll(run.id, client)); break;
        }
      } catch (error) {
        if (error instanceof Stopped) return;
        if (error instanceof DeadlineExceeded) await this.expire(run.id);
        else {
          const current = this.options.store.run(run.id);
          if (!current || this.options.signal?.aborted || TERMINAL.has(current.status)) return;
          this.update(run.id, r => {
            if (error instanceof PolicyError) r.status = "failed";
            else if (r.status === "submitting") r.status = "uncertain";
            r.error = errorText(error);
          });
        }
      }
      await this.notifyFailure(run.id);
    }).finally(() => { this.inFlight.delete(run.id); this.controllers.delete(run.id); });
    this.inFlight.set(run.id, work);
    return work;
  }

  /** Cancellation is durable before interrupting, including during an awaited request. */
  async cancel(runId: string): Promise<void> {
    const run = this.options.store.run(runId);
    if (!run || TERMINAL.has(run.status)) return;
    this.update(runId, r => { r.status = "canceled"; r.error = "Canceled by owner"; });
    this.controllers.get(runId)?.abort(new Stopped());
    if (!run.sessionId || this.options.signal?.aborted) return;
    let lease: Awaited<ReturnType<ServerPool["acquire"]>> | undefined;
    try {
      lease = await this.options.pool.acquire(run.snapshot.projectDir);
      const latest = this.options.store.run(runId);
      if (latest?.status !== "canceled" || latest.sessionId !== run.sessionId || this.options.signal?.aborted) return;
      if (lease.entry.client?.v2) await sessionAbort(lease.entry.client, run.sessionId, this.options.signal);
    } catch { /* Cancellation remains authoritative even if interrupt is unavailable. */ }
    finally { lease?.release(); }
  }

  private update(id: string, fn: (run: ScheduleRun) => void): void { this.options.store.updateRun(id, fn); }

  private current(id: string): ScheduleRun {
    const run = this.options.store.run(id);
    if (!run || this.options.signal?.aborted || run.status === "canceled" || run.status === "skipped") throw new Stopped();
    return run;
  }

  private check(id: string): ScheduleRun {
    const run = this.active(id);
    // A saved final report may be delivered/repaired after the generation deadline.
    if (run.output === undefined && this.now() >= run.deadlineAt) throw new DeadlineExceeded();
    return run;
  }

  private active(id: string): ScheduleRun {
    const run = this.current(id);
    if (TERMINAL.has(run.status)) throw new Stopped();
    return run;
  }

  private signal(id: string): AbortSignal {
    const local = this.controllers.get(id)!.signal;
    const run = this.options.store.run(id);
    const deadline = run && run.output === undefined
      ? AbortSignal.timeout(Math.max(1, run.deadlineAt - this.now())) : undefined;
    return AbortSignal.any([local, ...(this.options.signal ? [this.options.signal] : []), ...(deadline ? [deadline] : [])]);
  }

  private async withClient(id: string, fn: (client: OCClient) => Promise<void>): Promise<void> {
    const run = this.check(id);
    const lease = await this.options.pool.acquire(run.snapshot.projectDir);
    try {
      this.check(id);
      if (!lease.entry.client?.v2) throw new PolicyError("Scheduled reports require the authenticated native OpenCode V2 client; no permissive fallback is allowed");
      await fn(lease.entry.client);
      this.current(id);
    } finally { lease.release(); }
  }

  private async create(id: string, client: OCClient): Promise<void> {
    const input = creationInput(this.check(id).snapshot);
    this.update(id, r => { r.status = "creating"; delete r.error; });
    let session: SessionInfo;
    try { session = await client.v2!.session.create(input, { signal: this.signal(id) }); }
    catch (error) {
      this.check(id);
      this.update(id, r => { r.status = "uncertain"; r.error = `Session creation outcome is unknown: ${errorText(error)}`; });
      return;
    }
    if (!session || typeof session.id !== "string" || !session.id) {
      this.check(id);
      this.update(id, r => { r.status = "uncertain"; r.error = "Native session creation returned no usable identity; no replacement session will be created"; });
      return;
    }
    // Retain a late returned identity even after cancellation/shutdown, so the
    // owned session is never silently orphaned or recreated during recovery.
    this.update(id, r => { r.sessionId = session.id; });
    const latest = this.options.store.run(id);
    if (this.options.signal?.aborted) return;
    if (latest?.status === "canceled") {
      try { await sessionAbort(client, session.id); } catch { /* No prompt was submitted. */ }
      return;
    }
    this.check(id);
  }

  private async submit(id: string, client: OCClient): Promise<void> {
    let run = this.check(id);
    const session = await client.v2!.session.get({ sessionID: run.sessionId! }, { signal: this.signal(id) });
    run = this.check(id);
    if (session.id !== run.sessionId || !session.location?.directory || canonicalDir(session.location.directory) !== canonicalDir(run.snapshot.projectDir) || !hasReportPermissions(session.permissions)) {
      throw new PolicyError("The report session's identity, location, or restrictive native permissions could not be verified; prompt withheld");
    }
    const context = await this.options.ensureContext(run);
    run = this.check(id);
    if (!context.channel || !context.ts) throw new PolicyError("A private report interaction context could not be confirmed; prompt withheld");
    const messageId = `msg_${(BigInt(Math.floor(this.now())) * 0x1000n).toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`;
    this.update(id, r => { r.context = context; r.messageId = messageId; r.status = "submitting"; delete r.error; });
    try {
      // Agent/model were set natively at creation, before policy verification.
      await promptAsync(client, run.sessionId!, run.snapshot.prompt, { messageID: messageId, signal: this.signal(id) });
    } catch (error) {
      this.check(id);
      this.update(id, r => { r.status = "uncertain"; r.error = `Prompt admission is unconfirmed; it will not be resubmitted: ${errorText(error)}`; });
      return;
    }
    this.active(id);
    this.update(id, r => { r.status = "running"; delete r.error; });
    this.check(id);
  }

  private async poll(id: string, client: OCClient): Promise<void> {
    let run = this.check(id);
    if (!run.sessionId || !run.messageId) throw new PolicyError("Report recovery is missing its exact session/prompt identity");
    const messages = await sessionMessages(client, run.sessionId, this.signal(id));
    run = this.check(id);
    if (!admission(messages, run)) {
      this.update(id, r => { r.status = "uncertain"; r.error = "Exact prompt admission is unconfirmed; no automatic resubmission"; });
      return;
    }
    const permissions = await pendingPermissions(client, { signal: this.signal(id) });
    run = this.check(id);
    const questions = await pendingQuestions(client, { signal: this.signal(id) });
    run = this.check(id);
    if (permissions.some(p => p.sessionID === run.sessionId) || questions.some(q => q.sessionID === run.sessionId)) {
      this.update(id, r => { r.status = "waiting"; delete r.error; });
      return;
    }
    const idle = await sessionIdle(client, run.sessionId!, { signal: this.signal(id) });
    run = this.check(id);
    if (!idle) { this.update(id, r => { r.status = "running"; delete r.error; }); return; }
    const finalMessages = await sessionMessages(client, run.sessionId!, this.signal(id));
    run = this.check(id);
    const report = completedReport(finalMessages, run);
    if (!report) { this.update(id, r => { r.status = "running"; delete r.error; }); return; }
    this.update(id, r => {
      if (report.error) { r.status = "failed"; r.error = report.error; }
      else { r.output = report.output!; r.status = "ready"; delete r.error; }
    });
  }

  private async deliver(id: string): Promise<void> {
    const run = this.check(id);
    if (!run.output?.trim()) throw new PolicyError("Cannot deliver an empty report");
    if ((this.retries.get(id)?.at ?? 0) > this.now()) return;
    this.update(id, r => { r.status = "delivering"; delete r.error; });
    let copy: { channel: string; ts: string };
    try { copy = await this.options.deliver(this.check(id)); }
    catch (error) {
      this.check(id);
      const rejected = definiteDeliveryRejection(error);
      const attempts = (this.retries.get(id)?.attempts ?? 0) + 1;
      // A channel/auth rejection will not fix itself: stop after a few spaced
      // attempts (time to re-invite the bot) instead of retrying every minute forever.
      if (rejected && !rateLimited(error) && attempts >= PERMANENT_REJECTION_ATTEMPTS) {
        this.retries.delete(id);
        // notified resets so the owner hears that retries stopped, not just the first rejection.
        this.update(id, r => { r.status = "failed"; r.notified = false; r.error = `Saved report delivery was rejected ${attempts} times: ${errorText(error)} — fix the destination, then \\schedule run again`; });
        return;
      }
      this.update(id, r => { r.status = rejected ? "ready" : "uncertain"; r.error = `Saved report delivery ${rejected ? "was rejected" : "is unconfirmed"}: ${errorText(error)}`; });
      if (rejected) {
        const retry = error as { retryAfter?: number; data?: { retry_after?: number } };
        const seconds = retry?.retryAfter ?? retry?.data?.retry_after;
        const rateDelay = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
        this.retries.set(id, { attempts, at: this.now() + Math.max(rateDelay, Math.min(60_000, 2_000 * 2 ** Math.min(attempts - 1, 5))) });
      }
      return;
    }
    this.check(id);
    await this.adopt(id, copy);
  }

  private async reconcileDelivery(id: string): Promise<void> {
    const run = this.check(id);
    if (run.delivery?.ts) { await this.adopt(id, { channel: run.delivery.channel, ts: run.delivery.ts }); return; }
    const copy = await this.options.findDelivery(run);
    this.check(id);
    if (copy) await this.adopt(id, copy);
    else this.update(id, r => { r.status = "uncertain"; r.error = "Saved report delivery remains unconfirmed; no automatic repost"; });
  }

  private async adopt(id: string, copy: { channel: string; ts: string }): Promise<void> {
    this.check(id);
    if (!copy.channel || !copy.ts) {
      this.update(id, r => { r.status = "uncertain"; r.error = "Delivery response did not confirm a message identity; no automatic repost"; });
      return;
    }
    this.update(id, r => {
      r.delivery = copy; r.status = "delivered"; delete r.error;
      if (this.options.onDelivered) r.deliveryBindingPending = true;
      else delete r.deliveryBindingPending;
    });
    this.retries.delete(id);
    if (this.options.onDelivered) await this.finishBinding(id);
  }

  private async finishBinding(id: string): Promise<void> {
    const run = this.current(id);
    if (run.status !== "delivered" || !run.deliveryBindingPending || !run.delivery?.ts) return;
    try {
      if (!this.options.onDelivered) throw new PolicyError("Pending report binding requires the onDelivered adapter");
      await this.options.onDelivered(run);
      const latest = this.current(id);
      if (latest.status !== "delivered" || latest.delivery?.channel !== run.delivery.channel || latest.delivery?.ts !== run.delivery.ts) return;
      this.update(id, r => { delete r.deliveryBindingPending; delete r.error; });
    } catch (error) {
      if (error instanceof Stopped || this.options.signal?.aborted) return;
      const latest = this.current(id);
      if (latest.status === "delivered" && latest.deliveryBindingPending) {
        this.update(id, r => { r.error = `Report delivered; continuation binding is pending: ${errorText(error)}`; });
      }
    }
  }

  private async expire(id: string): Promise<void> {
    let run: ScheduleRun;
    try { run = this.current(id); } catch { return; }
    if (TERMINAL.has(run.status) || run.output !== undefined) return;
    const alreadyExpired = run.error?.startsWith(DEADLINE) === true;
    let admitted = run.status === "running" || run.status === "waiting";
    let lease: Awaited<ReturnType<ServerPool["acquire"]>> | undefined;
    try {
      try {
        if (run.sessionId) {
          lease = await this.options.pool.acquire(run.snapshot.projectDir);
          run = this.active(id);
          if (run.messageId && !admitted && lease.entry.client?.v2) {
            try {
              const messages = await sessionMessages(lease.entry.client, run.sessionId!, this.options.signal);
              run = this.active(id);
              admitted = admission(messages, run);
            } catch (error) { if (error instanceof Stopped || this.options.signal?.aborted) return; }
          }
        }
      } catch (error) { if (error instanceof Stopped || this.options.signal?.aborted) return; }
      run = this.active(id);
      const unknownEffect = !admitted && (!!run.messageId || (!run.sessionId && run.status !== "claimed"));
      this.update(id, r => { r.status = unknownEffect ? "uncertain" : "failed"; r.error = DEADLINE + (unknownEffect ? "; external admission remains unconfirmed, no automatic retry" : ""); });
      if (!alreadyExpired && run.sessionId && lease?.entry.client?.v2) {
        try { await sessionAbort(lease.entry.client, run.sessionId, this.options.signal); } catch { /* Durable deadline forbids late delivery even if interrupt fails. */ }
        this.current(id);
      }
    } catch (error) { if (!(error instanceof Stopped)) throw error; }
    finally { lease?.release(); }
  }

  private async notifyFailure(id: string): Promise<void> {
    const run = this.options.store.run(id);
    if (!run || this.options.signal?.aborted || run.notified || !run.error ||
      !(run.status === "failed" || run.status === "uncertain" || run.status === "ready")) return;
    // Persist the attempt, not just success: a lost response must not cause a DM storm.
    this.update(id, r => { r.notified = true; });
    try { await this.options.notify(this.current(id), `Scheduled report “${run.snapshot.name}”: ${run.error}`); this.current(id); }
    catch { /* Keep the durable attempt even on ambiguous notification failure. */ }
  }
}
