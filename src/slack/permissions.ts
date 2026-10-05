import type { OcPermission } from "../opencode/api.js";
import { permissionResultText, validPermissionId, type PermButtonValue } from "./blocks.js";
import { permissionKey, type PermissionChoice, type PermissionDeliveryStore, type PermissionIdentity, type PermissionRecord } from "./permissions-store.js";

export { PermissionDeliveryStore, permissionKey, permissionDeliveryMarker, PERMISSION_STORE_PATH } from "./permissions-store.js";
export type { PermissionChoice, PermissionDelivery, PermissionIdentity, PermissionRecord } from "./permissions-store.js";

function isChoice(choice: unknown): choice is PermissionChoice {
  return choice === "once" || choice === "always" || choice === "reject";
}

export function parsePermissionButton(actionId: string, raw: unknown): PermButtonValue | undefined {
  if (typeof raw !== "string" || raw.length > 2000) return;
  try {
    const v = JSON.parse(raw) as PermButtonValue;
    if (!v || !validPermissionId(v.s) || !validPermissionId(v.p) || !isChoice(v.r) ||
        (v.g !== undefined && (!Number.isSafeInteger(v.g) || v.g < 0)) ||
        (actionId !== "perm" && actionId !== `perm_${v.r}`)) return;
    return { s: v.s, p: v.p, r: v.r, ...(v.g === undefined ? {} : { g: v.g }) };
  } catch { return; }
}

/** Pass the argument string AFTER \\permission. No aliases or natural language. */
export function parsePermissionCommand(args: string): { requestId: string; response: PermissionChoice } | undefined {
  const match = /^\s*([A-Za-z0-9_-]{1,255})\s+(once|deny|always)\s*$/.exec(args);
  if (!match) return;
  return { requestId: match[1]!, response: match[2] === "deny" ? "reject" : match[2] as "once" | "always" };
}

export type PermissionResponseContext = { threadKey: string } | { dm: true };
export interface PermissionResponseInput {
  actor: string;
  requestId: string;
  response: PermissionChoice;
  context: PermissionResponseContext;
  sessionId?: string;
  generation?: number;
  actionId?: string;
  /** Historical approval commands must not acquire fresh authority on replay. */
  source?: "live" | "history";
}
export interface PermissionBinding {
  projectDir: string;
  sessionId: string;
  generation: number;
}
export interface PermissionResponderDeps<Server extends object> {
  ownerSlackUserId: string;
  store: PermissionDeliveryStore;
  /** Synchronous current binding, including any cancellation/age eligibility gate. */
  getBinding(threadKey: string): PermissionBinding | undefined;
  /** ONLY return an already-running server. Never ensure/spawn here. Stable object per generation. */
  getRunning(projectDir: string): Server | undefined;
  /** Authoritative full pending list in this server's project scope. Throw on unavailable/malformed. */
  findPending(server: Server): Promise<OcPermission[]>;
  /** Use a lease if needed, but never acquire a different/new server generation. */
  respond(server: Server, permission: OcPermission, response: PermissionChoice): Promise<void>;
  /** Collapse all known copies and clear waiting state. Record is already durable. */
  resolved(record: PermissionRecord, text: string): Promise<void> | void;
  /** Optional extra synchronous lifecycle gate; checked again after every await. */
  eligible?(record: PermissionRecord): boolean;
  /** Default: all reply errors are uncertain. Only explicit no-effect failures qualify. */
  definitelyRejected?(error: unknown): boolean;
}
export interface PermissionResponseResult {
  status: "resolved" | "busy" | "forbidden" | "invalid" | "missing" | "ambiguous" | "stale" | "unavailable" | "uncertain" | "retry";
  text: string;
  record?: PermissionRecord;
  notificationError?: string;
}

const UNKNOWN_RESULT = "Permission resolved or expired; the requested choice was not confirmed.";

/** One instance shared by native buttons, text commands, and resolution echoes. */
export class PermissionResponder<Server extends object> {
  private readonly locks = new Set<string>();
  constructor(private readonly deps: PermissionResponderDeps<Server>) {}

  private current(record: PermissionRecord, server?: Server): boolean {
    const b = this.deps.getBinding(record.threadKey);
    return !!b && b.projectDir === record.projectDir && b.sessionId === record.sessionId && b.generation === record.generation &&
      (!this.deps.eligible || this.deps.eligible(record)) &&
      (!server || this.deps.getRunning(record.projectDir) === server);
  }

  private async finish(record: PermissionRecord, text: string, confirmed: boolean): Promise<PermissionResponseResult> {
    // Re-read so independently delivered late copies aren't lost by an older snapshot.
    record = this.deps.store.get(record) ?? record;
    record.response = { ...record.response, status: "resolved", confirmed, text, error: undefined };
    this.deps.store.put(record);
    const result: PermissionResponseResult = { status: "resolved", text, record };
    try { await this.deps.resolved(record, text); }
    catch (err) { result.notificationError = String(err); }
    return result;
  }

  /** SSE/poll evidence has no choice proof. Never overwrite an in-flight or confirmed decision. */
  async observeResolved(identity: PermissionIdentity): Promise<PermissionResponseResult | undefined> {
    const record = this.deps.store.get(identity);
    if (!record || !this.current(record)) return;
    if (this.locks.has(permissionKey(record)) && record.response.status === "answering") return;
    if (record.response.status === "resolved") return { status: "resolved", text: record.response.text ?? UNKNOWN_RESULT, record };
    return this.finish(record, UNKNOWN_RESULT, false);
  }

  async respond(input: PermissionResponseInput): Promise<PermissionResponseResult> {
    // Defense in depth: callers must ALSO gate the Slack envelope before calling.
    if (!input || !this.deps.ownerSlackUserId || input.actor !== this.deps.ownerSlackUserId) return { status: "forbidden", text: "Only the paired owner can answer permissions." };
    if (input.source === "history") return { status: "stale", text: "Historical permission decisions are not replayed. Send a fresh explicit decision." };
    if (!validPermissionId(input.requestId) || !isChoice(input.response) ||
        (input.sessionId !== undefined && !validPermissionId(input.sessionId)) ||
        (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 0)) ||
        (input.actionId !== undefined && input.actionId !== "perm" && input.actionId !== `perm_${input.response}`) ||
        !input.context || (!("threadKey" in input.context && typeof input.context.threadKey === "string") && !("dm" in input.context && input.context.dm === true))) {
      return { status: "invalid", text: "Invalid permission response. Use \\permission <request-id> once|deny|always." };
    }
    const candidates = this.deps.store.list().filter(r => r.requestId === input.requestId &&
      (!("threadKey" in input.context) || r.threadKey === input.context.threadKey) &&
      (input.sessionId === undefined || r.sessionId === input.sessionId) &&
      (input.generation === undefined || r.generation === input.generation));
    if (!candidates.length) return { status: "missing", text: "No matching tracked permission in this context. Use \\permissions." };
    if (candidates.length !== 1) return { status: "ambiguous", text: "That request ID is ambiguous. Answer in its original thread." };
    let record = candidates[0]!;
    if (!this.current(record)) return { status: "stale", text: "That permission's session or binding is no longer current." };
    if (record.response.status === "resolved") return { status: "resolved", text: record.response.text ?? UNKNOWN_RESULT, record };
    const key = permissionKey(record);
    if (this.locks.has(key)) return { status: "busy", text: "A reply to this permission is already in progress." };
    this.locks.add(key); // Must precede even the authoritative pending query.
    try {
      const server = this.deps.getRunning(record.projectDir);
      if (!server) return { status: "unavailable", text: "Its OpenCode server is not running; no project was started." };
      let pending: OcPermission[];
      try { pending = await this.deps.findPending(server); }
      catch { return { status: "unavailable", text: "Could not confirm the pending permission. No reply was sent." }; }
      if (!this.current(record, server)) return { status: "stale", text: "The session or server changed while checking this permission." };
      if (!Array.isArray(pending) || pending.some(p => !p || !validPermissionId(p.id) || !validPermissionId(p.sessionID))) {
        return { status: "unavailable", text: "The server returned an invalid pending-permission list." };
      }
      record = this.deps.store.get(record)!;
      if (record.response.status === "resolved") return { status: "resolved", text: record.response.text ?? UNKNOWN_RESULT, record };
      const matches = pending.filter(p => p.id === record.requestId);
      if (!matches.length) return await this.finish(record, UNKNOWN_RESULT, false);
      const permission = matches[0]!;
      if (matches.length !== 1 || permission.sessionID !== record.sessionId ||
          (record.permission.messageID !== undefined && permission.messageID !== record.permission.messageID) ||
          (record.permission.callID !== undefined && permission.callID !== record.permission.callID)) {
        return { status: "stale", text: "The pending request does not match this permission's exact session/context." };
      }
      if (record.response.status === "uncertain" || record.response.status === "answering") {
        // Reconciliation is a separate step; never turn a retry click into a blind resend.
        record.response = { status: "pending" };
        this.deps.store.put(record);
        return { status: "retry", text: "The previous reply was not confirmed. The request is still pending; send a fresh explicit decision to retry.", record };
      }
      record.response = { status: "answering", choice: input.response, actor: input.actor };
      this.deps.store.put(record);
      try { await this.deps.respond(server, permission, input.response); }
      catch (err) {
        record = this.deps.store.get(record)!;
        const rejected = this.deps.definitelyRejected?.(err) === true;
        record.response = { ...record.response, status: rejected ? "pending" : "uncertain", error: String(err).slice(0, 1000) };
        this.deps.store.put(record);
        return { status: rejected ? "retry" : "uncertain", text: rejected
          ? "OpenCode rejected the reply. The permission remains pending; you may retry."
          : "Reply not confirmed. Check the permission again to reconcile before retrying.", record };
      }
      // The accepted response belongs to this exact old request even if binding changed meanwhile.
      return await this.finish(record, permissionResultText(input.response, input.actor), true);
    } finally { this.locks.delete(key); }
  }
}
