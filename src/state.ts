import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalDir } from "./paths.js";
import { logErr } from "./log.js";
import { compareTs, replayAge, replayFloor, timestampMicros, type RecoveryDecision } from "./slack/recovery-policy.js";
import type { SlackMsg } from "./slack/router.js";

export type VerboseMode = "off" | "on" | "full";

export interface ThreadState {
  sessionId: string;
  projectDir: string;
  verbose: VerboseMode;
  /** provider/model string incl. reasoning-variant suffix, applied to future prompts */
  model?: string;
  agent?: string;
  title?: string;
  /** \hush toggle: when true, plain thread messages are ignored (commands pass; an explicit @mention wakes it) */
  hushed?: boolean;
  /** \notify toggle: when true, run completions are DM'd to the owner */
  notify?: boolean;
  /** Private context owned by a durable scheduled report, not a replayed prompt. */
  scheduledRunId?: string;
  /**
   * \watch mode: the thread mirrors a session driven OUTSIDE Slack (TUI/IDE on
   * the computer). Plain replies are rejected (read-only until \resume takes
   * the session over); \ commands still work.
   */
  watchOnly?: boolean;
  /**
   * Run in flight when the bridge was stopped (persisted so a restart can
   * resolve the orphaned ⏳/✅ lifecycle instead of leaving it frozen forever).
   */
  pendingRun?: { userMsgTs: string[]; statusTs?: string };
  /** Newest observed owner message, NOT proof of consumption or gap-free history. */
  lastSeenTs?: string;
  /** Only the history poll advances this, after verifying contiguous dispositions. */
  historyCursorTs?: string;
  recovery?: ThreadRecovery;
  createdAt: number;
  lastUsedAt: number;
}

export interface ThreadRecovery {
  version: 1;
  ownerActivityTs?: string;
  replayFloorTs: string;
  trustedAfterTs?: string;
  bindingGeneration: number;
  intentVersion: number;
  canceledThroughTs?: string;
  latestAcceptedTs?: string;
  /** A missed state-changing command makes subsequent historical context ambiguous. */
  needsFreshIntent?: boolean;
  lastRun?: { generation: number; sessionId: string; userMsgTs: string[]; messageIds: string[];
    outcome: "active" | "completed" | "stopped" | "failed" | "interrupted"; completedThroughTs?: string };
  scan?: { upperTs: string; afterTs: string; cursor?: string; generation: number; intentVersion: number;
    candidates: SlackMsg[]; complete: boolean };
  counts?: { recovered: number; held: number; expired: number; canceled: number };
  reasons?: Record<string, number>;
  lastDecision?: { ts: string; decision: RecoveryDecision["decision"]; reason: string };
}

interface ProjectInfo {
  lastUsedAt: number;
}

interface SlackocState {
  threads: Record<string, ThreadState>;
  projects: Record<string, ProjectInfo>;
  currentProjectDir?: string;
  receipts?: Record<string, MessageReceipt>;
  recoveryPaused?: boolean;
  /** Expired unbound receipts cannot be resurrected by delayed delivery or a later binding. */
  unboundReceiptFloorTs?: string;
}

export type MessageDisposition = "processing" | "accepted" | "uncertain";
export interface MessageReceipt {
  threadKey: string;
  ts: string;
  disposition: MessageDisposition;
  updatedAt: number;
  /** Persisted before HTTP submission; exact user-message evidence can settle uncertainty. */
  submission?: PromptSubmission;
  recoveryDecision?: RecoveryDecision;
  source?: "live" | "history";
  generation?: number;
  cancellationBoundary?: boolean;
}
export interface PromptSubmission {
  projectDir: string;
  sessionId: string;
  messageId: string;
}
export interface PromptAcceptanceEvidence {
  id: string;
  sessionID: string;
  role: string;
}
export const MAX_MESSAGE_RECEIPTS = 2000;
export const RECOVERY_RECEIPT_RESERVE = 32;
export const UNBOUND_RECEIPT_HORIZON_MS = 24 * 60 * 60_000;

export class StateStore {
  private state: SlackocState;

  constructor(private path: string, readonly now: () => number = Date.now) {
    this.state = { threads: {}, projects: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as SlackocState;
        if (parsed && typeof parsed === "object" && parsed.threads && parsed.projects) {
          this.state = parsed;
        }
      } catch {
        /* corrupt state → start clean */
      }
    }
    this.normalizeProjects();
    for (const t of Object.values(this.state.threads)) {
      // Last-seen is observation, not acceptance. Keep legacy gaps conservative.
      t.recovery ??= this.newRecovery(t);
    }
    for (const r of Object.values(this.state.receipts ?? {})) {
      // A process died with the claim held: effects may already have happened.
      if (r.disposition === "processing") r.disposition = "uncertain";
    }
  }

  private newRecovery(t: ThreadState): ThreadRecovery {
    return { version: 1, ownerActivityTs: replayAge(t.lastSeenTs, this.now()).reason !== "invalid_timestamp" ? t.lastSeenTs : undefined,
      replayFloorTs: maxTs(replayFloor(this.now()), this.state.unboundReceiptFloorTs)!, trustedAfterTs: t.historyCursorTs,
      bindingGeneration: 1, intentVersion: 0 };
  }

  /** Idempotent versioned migration; never seed owner activity from maintenance time. */
  migrateRecovery(): number {
    let changed = 0;
    for (const t of Object.values(this.state.threads)) {
      if (!t.recovery) { t.recovery = this.newRecovery(t); changed++; }
    }
    this.save();
    return changed;
  }

  bindingGeneration(key: string): number { return this.state.threads[key]?.recovery?.bindingGeneration ?? 0; }

  /** Persist before awaiting abort/rebind, including threads with no renderer. */
  cancelRecovery(key: string, ts?: string, replaceBinding = false): void {
    const t = this.state.threads[key];
    const command = ts ? this.state.receipts?.[this.receiptKey(key, ts)] : undefined;
    if (command) command.cancellationBoundary = true;
    if (!t) { if (command) this.save(); return; }
    const r = t.recovery ??= this.newRecovery(t);
    const boundary = ts ?? r.ownerActivityTs;
    if (boundary && r.canceledThroughTs && compareTs(boundary, r.canceledThroughTs) <= 0) return;
    if (timestampMicros(boundary) !== undefined) r.canceledThroughTs = maxTs(r.canceledThroughTs, boundary);
    r.intentVersion++;
    if (replaceBinding) r.bindingGeneration++;
    if (r.lastRun?.outcome === "active") r.lastRun.outcome = "stopped";
    this.save();
  }

  cancellationThrough(key: string): string | undefined {
    return this.messageReceipts(key).filter((r) => r.cancellationBoundary)
      .reduce((latest, r) => maxTs(latest, r.ts), this.state.threads[key]?.recovery?.canceledThroughTs);
  }

  noteLiveIntent(key: string): void {
    const t = this.state.threads[key];
    if (!t) return;
    const r = t.recovery ??= this.newRecovery(t);
    r.intentVersion++;
    r.needsFreshIntent = false;
    this.save();
  }

  holdHistoricalContext(key: string): void {
    const t = this.state.threads[key];
    if (!t) return;
    (t.recovery ??= this.newRecovery(t)).needsFreshIntent = true;
    this.save();
  }

  recordRunOutcome(key: string, sessionId: string, outcome: NonNullable<ThreadRecovery["lastRun"]>["outcome"], userMsgTs?: string[]): void {
    const t = this.state.threads[key];
    if (!t || t.sessionId !== sessionId) return;
    const r = t.recovery ??= this.newRecovery(t);
    const timestamps = userMsgTs ?? t.pendingRun?.userMsgTs ?? r.lastRun?.userMsgTs ?? [];
    if (!timestamps.length) return;
    // An idle/error echo after owner cancellation cannot turn stopped work into completion.
    const stopped = timestamps.every((ts) => r.canceledThroughTs && compareTs(ts, r.canceledThroughTs) <= 0);
    r.lastRun = { generation: r.bindingGeneration, sessionId, userMsgTs: [...timestamps],
      messageIds: timestamps.flatMap((ts) => this.getReceipt(key, ts)?.submission?.messageId ?? []),
      outcome: stopped ? "stopped" : outcome,
      ...(outcome === "completed" && !stopped ? { completedThroughTs: timestamps.reduce((a, b) => maxTs(a, b)!) } : {}) };
    this.save();
  }

  setRecoveryScan(key: string, scan: ThreadRecovery["scan"]): void {
    const t = this.state.threads[key];
    if (!t) return;
    (t.recovery ??= this.newRecovery(t)).scan = scan ? structuredClone(scan) : undefined;
    this.save();
  }

  recordRecoveryDecision(key: string, ts: string, decision: RecoveryDecision): void {
    const t = this.state.threads[key];
    const receipt = this.state.receipts?.[this.receiptKey(key, ts)];
    if (receipt?.recoveryDecision?.reason === decision.reason) return;
    if (receipt && decision.decision !== "recover" && decision.decision !== "already_handled") receipt.recoveryDecision = decision;
    if (t) {
      const r = t.recovery ??= this.newRecovery(t);
      if (r.lastDecision?.ts === ts && r.lastDecision.reason === decision.reason) return;
      const counts = r.counts ??= { recovered: 0, held: 0, expired: 0, canceled: 0 };
      if (decision.decision === "recover") counts.recovered++;
      else if (decision.decision !== "already_handled") counts[decision.decision]++;
      if (decision.decision !== "recover" && decision.decision !== "already_handled") {
        const reasons = r.reasons ??= {};
        reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
      }
      r.lastDecision = { ts, ...decision };
    }
    this.save();
  }

  /** Retirement is scan progress only, never acceptance/completion evidence. */
  retireHistory(key: string, ts: string): void {
    const t = this.state.threads[key];
    if (!t) return;
    const r = t.recovery ??= this.newRecovery(t);
    r.replayFloorTs = maxTs(r.replayFloorTs, ts)!;
    this.save();
  }

  get currentProjectDir(): string | undefined {
    return this.state.currentProjectDir;
  }

  threadKey(channel: string, ts: string): string {
    return `${channel}:${ts}`;
  }

  getThread(key: string): ThreadState | null {
    const t = this.state.threads[key];
    return t ? structuredClone(t) : null;
  }

  setThread(key: string, thread: ThreadState): void {
    const old = this.state.threads[key];
    this.state.threads[key] = {
      ...thread, projectDir: canonicalDir(thread.projectDir), lastUsedAt: old?.lastUsedAt ?? this.now(),
      lastSeenTs: maxTs(old?.lastSeenTs, thread.lastSeenTs),
      historyCursorTs: old ? old.historyCursorTs : thread.historyCursorTs ?? thread.lastSeenTs,
      recovery: old?.recovery ?? thread.recovery ?? this.newRecovery({ ...thread, historyCursorTs: thread.historyCursorTs ?? thread.lastSeenTs }),
    };
    if (old && (old.sessionId !== thread.sessionId || canonicalDir(old.projectDir) !== canonicalDir(thread.projectDir))) {
      this.state.threads[key]!.recovery!.bindingGeneration++;
    }
    this.touchProject(thread.projectDir);
    this.save();
  }

  deleteThread(key: string): void {
    delete this.state.threads[key];
    this.save();
  }

  /** True when another thread (optionally excluding `exceptKey`) binds the same project dir. */
  anyThreadInDir(dir: string, exceptKey?: string): boolean {
    const canonical = canonicalDir(dir);
    return Object.entries(this.state.threads).some(([k, t]) => k !== exceptKey && canonicalDir(t.projectDir) === canonical);
  }

  /** Threads whose last run never finalized (bridge stopped mid-run). */
  threadsWithPendingRun(): Array<{ key: string; thread: ThreadState }> {
    return Object.entries(this.state.threads)
      .filter(([, t]) => t.pendingRun)
      .map(([key, t]) => ({ key, thread: structuredClone(t) }));
  }

  /** Validated owner observation only; neither maintenance nor a replay attempt refreshes its age. */
  markThreadSeen(key: string, ts: string): void {
    const t = this.state.threads[key];
    if (!t) return;
    if (replayAge(ts, this.now()).reason === "invalid_timestamp") return;
    if (t.lastSeenTs && compareTs(t.lastSeenTs, ts) >= 0) return;
    t.lastSeenTs = ts;
    (t.recovery ??= this.newRecovery(t)).ownerActivityTs = ts;
    t.lastUsedAt = Number(timestampMicros(ts)! / 1000n);
    this.save();
  }

  /** Compatibility entry point: persists recovery migration, never invents owner watermarks. */
  seedMissingWatermarks(): number {
    return this.migrateRecovery();
  }

  /** Owner-activity candidates; omit the window for bounded dormant discovery. */
  threadsForCatchup(sinceMs = 0): Array<{ key: string; thread: ThreadState }> {
    return Object.entries(this.state.threads)
      .filter(([, t]) => !sinceMs || Number((timestampMicros(t.recovery?.ownerActivityTs) ?? 0n) / 1000n) >= sinceMs)
      .sort((a, b) => compareTs(b[1].recovery?.ownerActivityTs ?? "0.0", a[1].recovery?.ownerActivityTs ?? "0.0"))
      .map(([key, t]) => ({ key, thread: structuredClone(t) }));
  }

  /** Clear a thread's interrupted-run tombstone after the boot sweep handled it. */
  clearPendingRun(key: string): void {
    const t = this.state.threads[key];
    if (!t?.pendingRun) return;
    if (!t.recovery?.lastRun || t.recovery.lastRun.outcome === "active") this.recordRunOutcome(key, t.sessionId, "interrupted");
    delete t.pendingRun;
    this.save();
  }

  setCurrentProject(dir: string): void {
    this.state.currentProjectDir = canonicalDir(dir);
    this.touchProject(dir);
    this.save();
  }

  touchProject(dir: string): void {
    this.state.projects[canonicalDir(dir)] = { lastUsedAt: this.now() };
  }

  listProjects(): Array<{ dir: string; lastUsedAt: number }> {
    this.normalizeProjects();
    return Object.entries(this.state.projects)
      .map(([dir, p]) => ({ dir, lastUsedAt: p.lastUsedAt }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  findThreadBySession(sessionId: string): { key: string; thread: ThreadState } | null {
    for (const [key, t] of Object.entries(this.state.threads)) {
      if (t.sessionId === sessionId) return { key, thread: structuredClone(t) };
    }
    return null;
  }

  private normalizeProjects(): void {
    const projects: Record<string, ProjectInfo> = {};
    for (const [dir, info] of Object.entries(this.state.projects)) {
      const key = canonicalDir(dir);
      if (!projects[key] || projects[key].lastUsedAt < info.lastUsedAt) projects[key] = { ...info };
    }
    this.state.projects = projects;
    if (this.state.currentProjectDir) this.state.currentProjectDir = canonicalDir(this.state.currentProjectDir);
    for (const t of Object.values(this.state.threads)) t.projectDir = canonicalDir(t.projectDir);
  }

  private receiptKey(threadKey: string, ts: string): string {
    return `${threadKey.split(":")[0]}:${ts}`;
  }

  getReceipt(threadKey: string, ts: string): MessageReceipt | undefined {
    const r = this.state.receipts?.[this.receiptKey(threadKey, ts)];
    return r ? { ...r, ...(r.submission ? { submission: { ...r.submission } } : {}) } : undefined;
  }

  /** Reconciliation/diagnostics can inspect evidence without mutating the store. */
  messageReceipts(threadKey?: string): MessageReceipt[] {
    return Object.values(this.state.receipts ?? {})
      .filter((r) => !threadKey || r.threadKey === threadKey)
      .sort((a, b) => compareTs(a.ts, b.ts))
      .map((r) => ({ ...r, ...(r.submission ? { submission: { ...r.submission } } : {}) }));
  }

  /** New command-created bindings need a boundary too; never move an existing cursor. */
  initializeHistory(threadKey: string, ts: string): void {
    const t = this.state.threads[threadKey];
    if (!t || t.historyCursorTs) return;
    t.historyCursorTs = ts;
    this.save();
  }

  /** Synchronous durable claim shared by live and history delivery, before any await/effect. */
  claimMessage(threadKey: string, ts: string, options: { recoveryCommand?: boolean; source?: "live" | "history" } = {}): "claimed" | MessageDisposition | "paused" | "held" {
    this.pruneAcceptedUnboundReceipts();
    const existing = this.getReceipt(threadKey, ts);
    if (existing) return existing.disposition;
    const floor = this.state.threads[threadKey]?.recovery?.replayFloorTs ?? this.state.unboundReceiptFloorTs;
    if (floor && compareTs(ts, floor) < 0) return "held";
    const cursor = this.state.threads[threadKey]?.historyCursorTs;
    if (cursor && compareTs(ts, cursor) <= 0) return "accepted";
    const receipts = this.state.receipts ??= {};
    const count = Object.keys(receipts).length;
    if (count >= MAX_MESSAGE_RECEIPTS) {
      if (!this.state.recoveryPaused) {
        this.state.recoveryPaused = true;
        this.save();
        logErr(`recovery paused: ${count} message receipts retained; resolve uncertain work / drain history. Status stays available; restart has ${RECOVERY_RECEIPT_RESERVE} reserved receipt slots (no uncertain evidence evicted)`);
      }
      if (!options.recoveryCommand || count >= MAX_MESSAGE_RECEIPTS + RECOVERY_RECEIPT_RESERVE) return "paused";
    }
    receipts[this.receiptKey(threadKey, ts)] = { threadKey, ts, disposition: "processing", updatedAt: this.now(), source: options.source,
      generation: this.bindingGeneration(threadKey) };
    this.save();
    return "claimed";
  }

  /** Only release when definitely no submission/command side effect occurred. */
  releaseMessage(threadKey: string, ts: string): void {
    if (!this.state.receipts) return;
    if (this.getReceipt(threadKey, ts)?.disposition === "accepted") return;
    delete this.state.receipts[this.receiptKey(threadKey, ts)];
    if (Object.keys(this.state.receipts).length < MAX_MESSAGE_RECEIPTS) this.state.recoveryPaused = false;
    this.save();
  }

  settleMessage(threadKey: string, ts: string, disposition: "accepted" | "uncertain"): void {
    const r = this.state.receipts?.[this.receiptKey(threadKey, ts)];
    if (!r) return;
    // Evidence can arrive over SSE before the HTTP request times out. Never downgrade it.
    if (r.disposition === "accepted") return;
    r.disposition = disposition;
    if (disposition === "accepted" && r.submission) this.noteAcceptedPrompt(r);
    r.updatedAt = this.now();
    this.save();
  }

  private noteAcceptedPrompt(receipt: MessageReceipt): void {
    const t = this.state.threads[receipt.threadKey];
    if (!t || t.sessionId !== receipt.submission?.sessionId) return;
    const r = t.recovery ??= this.newRecovery(t);
    r.latestAcceptedTs = maxTs(r.latestAcceptedTs, receipt.ts);
  }

  /** Pin correlation before sending. Failure to persist must prevent submission. */
  associatePrompt(threadKey: string, ts: string, submission: PromptSubmission): void {
    const r = this.state.receipts?.[this.receiptKey(threadKey, ts)];
    if (!r || r.disposition !== "processing") throw new Error("prompt submission requires a processing receipt");
    r.submission = { ...submission, projectDir: canonicalDir(submission.projectDir) };
    r.generation = this.bindingGeneration(threadKey);
    r.updatedAt = this.now();
    this.save();
  }

  isMessageAccepted(threadKey: string, ts: string): boolean {
    const receipt = this.getReceipt(threadKey, ts);
    if (receipt) return receipt.disposition === "accepted";
    const floor = this.state.threads[threadKey]?.recovery?.replayFloorTs;
    if (floor && compareTs(ts, floor) < 0) return false;
    const cursor = this.state.threads[threadKey]?.historyCursorTs;
    return !!cursor && compareTs(ts, cursor) <= 0;
  }

  /**
   * Call with real message.updated.properties.info or transcript entry.info.
   * Exact project + session + generated ID + user role prove acceptance, NOT completion.
   * No text/time matching, assistant-message inference, or missing-message retry.
   */
  reconcilePromptAcceptance(projectDir: string, info: PromptAcceptanceEvidence): MessageReceipt[] {
    if (!info || info.role !== "user" || !info.id || !info.sessionID) return [];
    const dir = canonicalDir(projectDir);
    const matched: MessageReceipt[] = [];
    for (const r of Object.values(this.state.receipts ?? {})) {
      const s = r.submission;
      if (r.disposition === "accepted" || !s || s.messageId !== info.id || s.sessionId !== info.sessionID || canonicalDir(s.projectDir) !== dir) continue;
      r.disposition = "accepted";
      this.noteAcceptedPrompt(r);
      r.updatedAt = this.now();
      matched.push({ ...r, submission: { ...s } });
    }
    if (matched.length) this.save();
    return matched;
  }

  /** Accepted, never-bound command traffic has a durable 24h dedup horizon. */
  pruneAcceptedUnboundReceipts(now = this.now()): number {
    const cutoff = now - UNBOUND_RECEIPT_HORIZON_MS;
    const floor = `${Math.floor(cutoff / 1000)}.${String(cutoff % 1000).padStart(3, "0")}000`;
    let removed = 0;
    for (const [key, r] of Object.entries(this.state.receipts ?? {})) {
      if (r.disposition !== "accepted" || this.state.threads[r.threadKey] || r.updatedAt > cutoff) continue;
      if (r.cancellationBoundary && replayAge(r.ts, now).decision !== "expired") continue;
      // Both receipt age and Slack timestamp must have passed the horizon.
      if (!/^\d+\.\d+$/.test(r.ts) || Number(r.ts) * 1000 > cutoff) continue;
      delete this.state.receipts![key];
      removed++;
    }
    if (removed) {
      this.state.unboundReceiptFloorTs = maxTs(this.state.unboundReceiptFloorTs, floor);
      if (Object.keys(this.state.receipts ?? {}).length < MAX_MESSAGE_RECEIPTS) this.state.recoveryPaused = false;
      this.save();
    }
    return removed;
  }

  /** Caller proves history is contiguous through ts. In-flight/uncertain work blocks it. */
  confirmHistory(threadKey: string, ts: string): boolean {
    const t = this.state.threads[threadKey];
    if (!t) return false;
    const receipts = Object.entries(this.state.receipts ?? {});
    if (receipts.some(([, r]) => r.threadKey === threadKey && compareTs(r.ts, ts) <= 0 && r.disposition !== "accepted")) return false;
    t.historyCursorTs = maxTs(t.historyCursorTs, ts);
    for (const [key, r] of receipts) {
      if (r.threadKey === threadKey && compareTs(r.ts, ts) <= 0 && !t.pendingRun?.userMsgTs.includes(r.ts)) delete this.state.receipts![key];
    }
    if (Object.keys(this.state.receipts ?? {}).length < MAX_MESSAGE_RECEIPTS) this.state.recoveryPaused = false;
    this.save();
    return true;
  }

  recoveryStatus() {
    const receipts = Object.values(this.state.receipts ?? {});
    const threads = Object.entries(this.state.threads).flatMap(([key, t]) => t.recovery?.lastDecision ? [{ key, ...t.recovery.lastDecision,
      reasons: { ...t.recovery.reasons }, recent: replayAge(t.recovery.ownerActivityTs, this.now()).decision === "recover" }] : []);
    const counts = { recovered: 0, held: 0, expired: 0, canceled: 0 };
    for (const t of Object.values(this.state.threads)) for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += t.recovery?.counts?.[key] ?? 0;
    return { paused: !!this.state.recoveryPaused, receipts: receipts.length,
      uncertain: receipts.filter((r) => r.disposition === "uncertain").length, ...counts, threads };
  }

  /** tmp + rename: a crash mid-write can corrupt the tmp file, never the live state.json. */
  save(): void {
    this.normalizeProjects();
    this.prune();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best effort */
    }
  }

  /**
   * Bound state growth: thread bindings untouched for 60 days are stale, and
   * no deployment needs more than a thousand of them (LRU beyond the cap).
   */
  private prune(): void {
    const cutoff = this.now() - 60 * 24 * 60 * 60 * 1000;
    const protectedKeys = new Set(Object.values(this.state.receipts ?? {}).map((r) => r.threadKey));
    const protectedThreads = Object.entries(this.state.threads).filter(([k, t]) => t.pendingRun || protectedKeys.has(k));
    const rest = Object.entries(this.state.threads)
      .filter(([k, t]) => !t.pendingRun && !protectedKeys.has(k) && (t.lastUsedAt ?? 0) >= cutoff)
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
    this.state.threads = Object.fromEntries([...protectedThreads, ...rest.slice(0, Math.max(0, 1000 - protectedThreads.length))]);
  }
}

function maxTs(a: string | undefined, b: string | undefined): string | undefined {
  return a && b ? (compareTs(a, b) > 0 ? a : b) : a ?? b;
}
