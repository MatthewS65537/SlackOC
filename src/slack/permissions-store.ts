/** Single bridge writer; deliberately separate from prompt/receipt state. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../config.js";
import type { OcPermission } from "../opencode/api.js";
import { validPermissionId, type PermButtonValue } from "./blocks.js";

export const PERMISSION_STORE_PATH = join(CONFIG_DIR, "permissions.json");
export type PermissionChoice = PermButtonValue["r"];
export interface PermissionIdentity {
  projectDir: string;
  sessionId: string;
  requestId: string;
  generation: number;
}
export interface PermissionDelivery {
  channel?: string;
  ts?: string;
  format: "card" | "text";
  status: "new" | "in-flight" | "delivered" | "rejected" | "uncertain";
  attempts: number;
  /** Result text replaced the interactive copy; retry failed collapses after restart. */
  collapsed?: boolean;
  error?: string;
}
export interface PermissionRecord extends PermissionIdentity {
  threadKey: string;
  permission: OcPermission;
  /** Original owner timestamp, never refreshed by delivery retries. */
  ownerActivityTs?: string;
  firstObservedAt: number;
  updatedAt: number;
  thread: PermissionDelivery;
  dm: PermissionDelivery;
  response: {
    status: "pending" | "answering" | "uncertain" | "resolved";
    choice?: PermissionChoice;
    actor?: string;
    text?: string;
    error?: string;
    confirmed?: boolean;
  };
}

export function permissionKey(identity: PermissionIdentity): string {
  return JSON.stringify([identity.projectDir, identity.sessionId, identity.requestId, identity.generation]);
}

/** Include this in post text/metadata; recovery must also verify the bot author. */
export function permissionDeliveryMarker(identity: PermissionIdentity, destination: "thread" | "dm"): string {
  return `slackoc-permission-${createHash("sha256").update(permissionKey(identity)).digest("hex").slice(0, 24)}-${destination}`;
}

function validate(record: PermissionRecord): void {
  const r = record;
  if (!r || !validPermissionId(r.requestId) || !validPermissionId(r.sessionId) ||
      typeof r.projectDir !== "string" || !r.projectDir || typeof r.threadKey !== "string" || !r.threadKey ||
      !Number.isSafeInteger(r.generation) || r.generation < 0 ||
      !Number.isFinite(r.firstObservedAt) || !Number.isFinite(r.updatedAt) ||
      (r.ownerActivityTs !== undefined && !/^\d+\.\d{1,6}$/.test(r.ownerActivityTs)) ||
      r.permission?.id !== r.requestId || r.permission?.sessionID !== r.sessionId ||
      typeof r.permission.type !== "string" || typeof r.permission.title !== "string" ||
      !["pending", "answering", "uncertain", "resolved"].includes(r.response?.status)) {
    throw new Error("Invalid permission delivery record");
  }
  if (r.response.choice !== undefined && !["once", "always", "reject"].includes(r.response.choice)) throw new Error("Invalid permission response choice");
  for (const d of [r.thread, r.dm]) {
    if (!d || !["new", "in-flight", "delivered", "rejected", "uncertain"].includes(d.status) ||
        !["card", "text"].includes(d.format) || !Number.isSafeInteger(d.attempts) || d.attempts < 0 ||
        (d.ts !== undefined && (typeof d.ts !== "string" || !/^\d+\.\d+$/.test(d.ts))) ||
        (d.channel !== undefined && typeof d.channel !== "string") ||
        (d.status === "delivered" && (!d.channel || !d.ts))) throw new Error("Invalid permission destination");
  }
  if (Buffer.byteLength(JSON.stringify(r)) > 32 * 1024) throw new Error("Permission record exceeds 32 KiB");
}

export interface PermissionStoreOptions {
  now?: () => number;
  maxRecords?: number;
  resolvedRetentionMs?: number;
}

export class PermissionDeliveryStore {
  private records = new Map<string, PermissionRecord>();
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly retention: number;

  constructor(readonly path = PERMISSION_STORE_PATH, options: PermissionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? 512;
    this.retention = options.resolvedRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || !Number.isFinite(this.retention) || this.retention < 0) throw new Error("Invalid permission retention settings");
    if (!existsSync(path)) return;
    // Corrupt/oversized state must not silently erase response uncertainty.
    if (statSync(path).size > 20 * 1024 * 1024) throw new Error("Permission store exceeds 20 MiB");
    const data = JSON.parse(readFileSync(path, "utf8")) as { version: number; records: PermissionRecord[] };
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > this.maxRecords) throw new Error("Invalid permission store");
    for (const r of data.records) {
      validate(r);
      if (this.records.has(permissionKey(r))) throw new Error("Duplicate permission identity in store");
      // A crash could occur after either server accepted but before local commit.
      if (r.response.status === "answering") r.response.status = "uncertain";
      for (const d of [r.thread, r.dm]) if (d.status === "in-flight") d.status = "uncertain";
      this.records.set(permissionKey(r), r);
    }
  }

  get(identity: PermissionIdentity): PermissionRecord | undefined {
    const value = this.records.get(permissionKey(identity));
    return value && structuredClone(value);
  }

  list(): PermissionRecord[] { return structuredClone([...this.records.values()]); }

  /** Merge delivery changes against the latest response/copies, not an awaited snapshot. */
  update(identity: PermissionIdentity, change: (record: PermissionRecord) => void): PermissionRecord | undefined {
    const record = this.get(identity);
    if (!record) return;
    change(record);
    if (permissionKey(record) !== permissionKey(identity)) throw new Error("Permission identity cannot change");
    this.put(record);
    return this.get(identity);
  }

  /** Commit before any external effect. Failed writes leave the memory view intact. */
  put(record: PermissionRecord): void {
    validate(record);
    const next = new Map(this.records);
    const key = permissionKey(record);
    const prior = next.get(key);
    const value = structuredClone(record);
    if (prior) {
      if (value.threadKey !== prior.threadKey) throw new Error("Permission scope cannot change");
      value.firstObservedAt = prior.firstObservedAt;
      value.ownerActivityTs = prior.ownerActivityTs;
    }
    value.updatedAt = this.now();
    next.set(key, value);
    for (const [k, r] of next) if (k !== key && r.response.status === "resolved" && this.now() - r.updatedAt > this.retention) next.delete(k);
    if (next.size > this.maxRecords) {
      for (const r of [...next.values()].filter(r => r.response.status === "resolved" && permissionKey(r) !== key).sort((a, b) => a.updatedAt - b.updatedAt)) {
        next.delete(permissionKey(r));
        if (next.size <= this.maxRecords) break;
      }
    }
    // Pending/uncertain decisions are never evicted to make room for another ask.
    if (next.size > this.maxRecords) throw new Error("Permission store full; unresolved requests retained");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, records: [...next.values()] }));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      this.records = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
