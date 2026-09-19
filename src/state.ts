import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalDir } from "./paths.js";
import { logErr } from "./log.js";

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
  createdAt: number;
  lastUsedAt: number;
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

  constructor(private path: string) {
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
      // Existing lastSeen is the migration boundary; never replay from epoch.
      t.historyCursorTs ??= t.lastSeenTs;
    }
    for (const r of Object.values(this.state.receipts ?? {})) {
      // A process died with the claim held: effects may already have happened.
      if (r.disposition === "processing") r.disposition = "uncertain";
    }
  }

  get currentProjectDir(): string | undefined {
    return this.state.currentProjectDir;
  }

  threadKey(channel: string, ts: string): string {
    return `${channel}:${ts}`;
  }

  getThread(key: string): ThreadState | null {
    const t = this.state.threads[key];
    return t ? { ...t } : null;
  }

  setThread(key: string, thread: ThreadState): void {
    const old = this.state.threads[key];
    this.state.threads[key] = {
      ...thread, projectDir: canonicalDir(thread.projectDir), lastUsedAt: Date.now(),
      lastSeenTs: maxTs(old?.lastSeenTs, thread.lastSeenTs),
      historyCursorTs: old ? old.historyCursorTs : maxTs(thread.historyCursorTs ?? thread.lastSeenTs, this.state.unboundReceiptFloorTs),
    };
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
      .map(([key, t]) => ({ key, thread: { ...t } }));
  }

  /**
   * Record observation only, leaving the history cursor untouched (Slack ts
   * strings are zero-padded to a fixed integer width, so lexical order ==
   * chronological order). No-op without a binding — bindings created later
   * seed the watermark themselves.
   */
  markThreadSeen(key: string, ts: string): void {
    const t = this.state.threads[key];
    if (!t) return;
    if (t.lastSeenTs && t.lastSeenTs >= ts) return;
    t.lastSeenTs = ts;
    this.save();
  }

  /**
   * One-time watermark migration for threads that predate catch-up: seed each
   * missing watermark from the thread's last known-good activity so the sweep
   * replays only messages sent AFTER the bridge last demonstrably heard the
   * thread — the genuinely lost ones, never anything already handled. Slack ts
   * strings are fixed-width (lexical order == chronological order), so the
   * fraction must be zero-padded to 6 digits. Idempotent: fills gaps only.
   * Returns how many threads were seeded. (The save's 60d-idle prune applies
   * as always — truly ancient bindings age out here rather than seed; a
   * pendingRun tombstone keeps one alive, so degenerate bindings missing
   * lastUsedAt still get a sane boundary instead of epoch-zero.)
   */
  seedMissingWatermarks(): number {
    let n = 0;
    for (const t of Object.values(this.state.threads)) {
      const missing = !t.lastSeenTs || !t.historyCursorTs;
      if (!t.lastSeenTs) {
        const ms = t.lastUsedAt || t.createdAt || Date.now();
        t.lastSeenTs = `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`;
      }
      t.historyCursorTs ??= t.lastSeenTs;
      if (missing) n += 1;
    }
    if (n) this.save();
    return n;
  }

  /** Catch-up sweep candidates: threads used within `sinceMs`, most recent first. */
  threadsForCatchup(sinceMs = 0): Array<{ key: string; thread: ThreadState }> {
    return Object.entries(this.state.threads)
      .filter(([, t]) => (t.lastUsedAt ?? 0) >= sinceMs)
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .map(([key, t]) => ({ key, thread: { ...t } }));
  }

  /** Clear a thread's interrupted-run tombstone after the boot sweep handled it. */
  clearPendingRun(key: string): void {
    const t = this.state.threads[key];
    if (!t) return;
    delete t.pendingRun;
    this.save();
  }

  setCurrentProject(dir: string): void {
    this.state.currentProjectDir = canonicalDir(dir);
    this.touchProject(dir);
    this.save();
  }

  touchProject(dir: string): void {
    this.state.projects[canonicalDir(dir)] = { lastUsedAt: Date.now() };
  }

  listProjects(): Array<{ dir: string; lastUsedAt: number }> {
    this.normalizeProjects();
    return Object.entries(this.state.projects)
      .map(([dir, p]) => ({ dir, lastUsedAt: p.lastUsedAt }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  findThreadBySession(sessionId: string): { key: string; thread: ThreadState } | null {
    for (const [key, t] of Object.entries(this.state.threads)) {
      if (t.sessionId === sessionId) return { key, thread: { ...t } };
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
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((r) => ({ ...r, ...(r.submission ? { submission: { ...r.submission } } : {}) }));
  }

  /** New command-created bindings need a boundary too; never move an existing cursor. */
  initializeHistory(threadKey: string, ts: string): void {
    const t = this.state.threads[threadKey];
    if (!t || t.historyCursorTs) return;
    t.historyCursorTs = maxTs(ts, this.state.unboundReceiptFloorTs);
    this.save();
  }

  /** Synchronous durable claim shared by live and history delivery, before any await/effect. */
  claimMessage(threadKey: string, ts: string, options: { recoveryCommand?: boolean } = {}): "claimed" | MessageDisposition | "paused" {
    this.pruneAcceptedUnboundReceipts();
    const existing = this.getReceipt(threadKey, ts);
    if (existing) return existing.disposition;
    if (ts <= (this.state.threads[threadKey]?.historyCursorTs ?? "")) return "accepted";
    if (!this.state.threads[threadKey] && ts <= (this.state.unboundReceiptFloorTs ?? "")) return "accepted";
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
    receipts[this.receiptKey(threadKey, ts)] = { threadKey, ts, disposition: "processing", updatedAt: Date.now() };
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
    r.updatedAt = Date.now();
    this.save();
  }

  /** Pin correlation before sending. Failure to persist must prevent submission. */
  associatePrompt(threadKey: string, ts: string, submission: PromptSubmission): void {
    const r = this.state.receipts?.[this.receiptKey(threadKey, ts)];
    if (!r || r.disposition !== "processing") throw new Error("prompt submission requires a processing receipt");
    r.submission = { ...submission, projectDir: canonicalDir(submission.projectDir) };
    r.updatedAt = Date.now();
    this.save();
  }

  isMessageAccepted(threadKey: string, ts: string): boolean {
    const receipt = this.getReceipt(threadKey, ts);
    if (receipt) return receipt.disposition === "accepted";
    return ts <= (this.state.threads[threadKey]?.historyCursorTs ?? "");
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
      r.updatedAt = Date.now();
      matched.push({ ...r, submission: { ...s } });
    }
    if (matched.length) this.save();
    return matched;
  }

  /** Accepted, never-bound command traffic has a durable 24h dedup horizon. */
  pruneAcceptedUnboundReceipts(now = Date.now()): number {
    const cutoff = now - UNBOUND_RECEIPT_HORIZON_MS;
    const floor = `${Math.floor(cutoff / 1000)}.${String(cutoff % 1000).padStart(3, "0")}000`;
    let removed = 0;
    for (const [key, r] of Object.entries(this.state.receipts ?? {})) {
      if (r.disposition !== "accepted" || this.state.threads[r.threadKey] || r.updatedAt > cutoff) continue;
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
    if (receipts.some(([, r]) => r.threadKey === threadKey && r.ts <= ts && r.disposition !== "accepted")) return false;
    t.historyCursorTs = maxTs(t.historyCursorTs, ts);
    for (const [key, r] of receipts) {
      if (r.threadKey === threadKey && r.ts <= ts) delete this.state.receipts![key];
    }
    if (Object.keys(this.state.receipts ?? {}).length < MAX_MESSAGE_RECEIPTS) this.state.recoveryPaused = false;
    this.save();
    return true;
  }

  recoveryStatus(): { paused: boolean; receipts: number; uncertain: number } {
    const receipts = Object.values(this.state.receipts ?? {});
    return { paused: !!this.state.recoveryPaused, receipts: receipts.length,
      uncertain: receipts.filter((r) => r.disposition === "uncertain").length };
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
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const protectedKeys = new Set(Object.values(this.state.receipts ?? {}).map((r) => r.threadKey));
    const protectedThreads = Object.entries(this.state.threads).filter(([k, t]) => t.pendingRun || protectedKeys.has(k));
    const rest = Object.entries(this.state.threads)
      .filter(([k, t]) => !t.pendingRun && !protectedKeys.has(k) && (t.lastUsedAt ?? 0) >= cutoff)
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
    this.state.threads = Object.fromEntries([...protectedThreads, ...rest.slice(0, Math.max(0, 1000 - protectedThreads.length))]);
  }
}

function maxTs(a: string | undefined, b: string | undefined): string | undefined {
  return a && b ? (a > b ? a : b) : a ?? b;
}
