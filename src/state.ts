import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  /**
   * Slack ts of the newest inbound owner message this thread has processed —
   * the catch-up sweep's watermark. Slack Socket Mode discards envelopes it
   * can't deliver (restart gaps, network flaps, zombie connections) instead of
   * replaying them; the sweep re-reads conversations.replies past this point.
   */
  lastSeenTs?: string;
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
}

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
    this.state.threads[key] = { ...thread, lastUsedAt: Date.now() };
    this.touchProject(thread.projectDir);
    this.save();
  }

  deleteThread(key: string): void {
    delete this.state.threads[key];
    this.save();
  }

  /** True when another thread (optionally excluding `exceptKey`) binds the same project dir. */
  anyThreadInDir(dir: string, exceptKey?: string): boolean {
    const norm = (d: string) => d.replace(/\/+$/, "");
    return Object.entries(this.state.threads).some(([k, t]) => k !== exceptKey && norm(t.projectDir) === norm(dir));
  }

  /** Threads whose last run never finalized (bridge stopped mid-run). */
  threadsWithPendingRun(): Array<{ key: string; thread: ThreadState }> {
    return Object.entries(this.state.threads)
      .filter(([, t]) => t.pendingRun)
      .map(([key, t]) => ({ key, thread: { ...t } }));
  }

  /**
   * Advance a thread's catch-up watermark to an inbound message ts (Slack ts
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
      if (t.lastSeenTs) continue;
      const ms = t.lastUsedAt ?? t.createdAt ?? 0;
      t.lastSeenTs = `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`;
      n += 1;
    }
    if (n) this.save();
    return n;
  }

  /** Catch-up sweep candidates: threads used within `sinceMs`, most recent first. */
  threadsForCatchup(sinceMs: number): Array<{ key: string; thread: ThreadState }> {
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
    this.state.currentProjectDir = dir;
    this.touchProject(dir);
    this.save();
  }

  touchProject(dir: string): void {
    this.state.projects[dir] = { lastUsedAt: Date.now() };
  }

  listProjects(): Array<{ dir: string; lastUsedAt: number }> {
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

  /** tmp + rename: a crash mid-write can corrupt the tmp file, never the live state.json. */
  save(): void {
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
    let kept = Object.entries(this.state.threads).filter(([, t]) => (t.lastUsedAt ?? 0) >= cutoff || t.pendingRun);
    if (kept.length > 1000) {
      kept = kept.sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt).slice(0, 1000);
    }
    this.state.threads = Object.fromEntries(kept);
  }
}
