import type { OCClient, OcEvent, OcPart } from "../opencode/api.js";
import { sessionGet, sessionIdle, sessionMessages } from "../opencode/client.js";
import type { ConnectionState } from "../opencode/server.js";
import { canonicalDir } from "../paths.js";
import { formatTool, safeCodePayload, safePayload } from "./tool-format.js";
import type { StateStore, ThreadState, VerboseMode } from "../state.js";
import { viewDiffBlocks } from "./blocks.js";
import { logErr } from "../log.js";
import { chunkText, dur, mdToMrkdwn, money, shortId, shortPath, tok, truncate } from "../util.js";
import { laneDepth } from "./queue.js";
import type { SlackLane } from "./queue.js";

export interface RenderDeps {
  post(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: unknown[],
    opts?: { unfurl?: boolean; lane?: SlackLane },
  ): Promise<{ ts: string }>;
  update(channel: string, ts: string, text: string): Promise<void>;
  delete(channel: string, ts: string): Promise<void>;
  react(channel: string, ts: string, name: string): Promise<void>;
  unreact(channel: string, ts: string, name: string): Promise<void>;
  upload(opts: {
    channelId: string;
    threadTs: string;
    filename: string;
    content?: string;
    /** Binary payloads (images) — takes precedence over `content`. */
    file?: Buffer;
    comment?: string;
    lane?: SlackLane;
  }): Promise<void>;
  /**
   * DM the owner about something that happened in (channel, threadTs) — the
   * remote pager: failures always, completions when \notify is on, permission
   * asks mirrored with their buttons. Absent when DMs are unavailable.
   */
  dm?(channel: string, threadTs: string, text: string, blocks?: unknown[], opts?: { lane?: SlackLane }): Promise<{ ts: string }>;
}

const registry = new Map<string, SessionView>();
const connections = new Map<string, ConnectionState>();

export function setProjectConnectionState(dir: string, state: ConnectionState): void {
  const key = canonicalDir(dir);
  connections.set(key, state);
  for (const view of registry.values()) if (view.projectDir === key) view.setConnectionState(state);
}

let reactionWarned = false;

/**
 * react/unreact that failures can never break a run through — but never
 * silently either (a missing reactions:write scope is fixed by reinstalling
 * the app, so the first failure logs a reinstall hint, once).
 */
export async function reactLogged(deps: RenderDeps, channel: string, ts: string, name: string, add = true): Promise<void> {
  try {
    if (add) await deps.react(channel, ts, name);
    else await deps.unreact(channel, ts, name);
  } catch (err) {
    if (!reactionWarned) {
      reactionWarned = true;
      logErr(
        `slackoc: reaction "${name}" failed (${String((err as Error)?.message ?? err)}) — ` +
          "check that the app has reactions:write; if scopes changed, reinstall the app in Slack.",
      );
    }
  }
}

/**
 * OpenCode's `session.error` carries a structured error object ({name,
 * data:{message,…}}), not a string — String() on it renders "[object
 * Object]" into the user's failure line and pager DM (live-verified). Pull
 * the human-readable message out.
 */
export function errorMessage(err: unknown, fallback = "unknown session error"): string {
  if (typeof err === "string") return err || fallback;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; name?: unknown; data?: { message?: unknown } };
    const msg = e.data?.message ?? e.message ?? e.name;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return fallback;
}

/** Only structured Slack errors prove a missing message; network errors don't. */
function messageNotFound(err: unknown): boolean {
  const e = err as { data?: { error?: string }; code?: string } | undefined;
  return e?.data?.error === "message_not_found" || e?.code === "message_not_found";
}

type Transcript = Awaited<ReturnType<typeof sessionMessages>>;

/** Only the newest relevant turn and its actual tool states prove completion. */
function completedTail(msgs: Transcript, since: number): Transcript[number] | undefined {
  const relevant = msgs.filter((m) => (m.info?.time?.created ?? 0) >= since)
    .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
  const last = relevant.at(-1);
  if (last?.info.role !== "assistant" || !last.info.time?.completed) return;
  // A completed tool-use step is not a completed answer, even if status raced idle.
  const finish = (last.info as typeof last.info & { finish?: string }).finish;
  if (finish === "tool-calls" || finish === "unknown") return;
  const tools = new Map<string, string | undefined>();
  for (const m of relevant) for (const p of m.parts ?? []) {
    if (p.type === "tool") tools.set(p.callID ?? p.id, p.state?.status);
  }
  if ([...tools.values()].some((s) => s !== "completed" && s !== "error")) return;
  return last;
}

export function getView(sessionId: string): SessionView | undefined {
  return registry.get(sessionId);
}

export function deleteView(sessionId: string): void {
  registry.get(sessionId)?.dispose();
  registry.delete(sessionId);
}

/**
 * True while a live view (finalized views leave the registry) is bound to a
 * project dir — the idle reaper spares servers with active work.
 */
export function hasActiveViewForProject(dir: string): boolean {
  dir = canonicalDir(dir);
  for (const v of registry.values()) if (v.projectDir === dir) return true;
  return false;
}

/** Finalize every live view bound to a project dir with a visible reason. */
export async function finalizeViewsForProject(dir: string, reason: string): Promise<void> {
  dir = canonicalDir(dir);
  const targets = [...registry.values()].filter((v) => v.projectDir === dir);
  for (const v of targets) await v.finalize(reason);
}

/**
 * One in-flight run for the `\status` board (RQ1). `elapsedMs` is wall time
 * since the current run began; `queued` counts prompts waiting behind it.
 */
export interface ActiveRunInfo {
  projectDir: string;
  sessionId: string;
  threadKey: string;
  elapsedMs: number;
  queued: number;
}

export function describeActiveRuns(): ActiveRunInfo[] {
  const out: ActiveRunInfo[] = [];
  for (const v of registry.values()) {
    if (!v.isActive) continue;
    out.push({
      projectDir: v.projectDir,
      sessionId: v.sessionId,
      threadKey: v.threadKey,
      elapsedMs: v.currentRunElapsedMs,
      queued: v.queuedCount,
    });
  }
  return out;
}

/**
 * RB2: poll-finalize provably-completed runs whose SSE stream went quiet.
 * `staleMs` gates on time since the view's last event (pass 0 for "check now"
 * on SSE resume); `dir` restricts to one project. Returns how many runs were
 * reconciled. Only server-PROVEN completions finalize — a long-running
 * prompt can never be reaped by this path.
 */
export async function reconcileStaleViews(staleMs = 120_000, dir?: string): Promise<number> {
  let n = 0;
  for (const v of [...registry.values()]) {
    if (dir && v.projectDir !== canonicalDir(dir)) continue;
    try {
      if (await v.reconcileIfStale(Date.now(), staleMs)) n++;
    } catch (err) {
      logErr(`reconcile failed (${v.sessionId}): ${String((err as Error)?.message ?? err)}`);
    }
  }
  return n;
}

function registerView(view: SessionView): void {
  // Bound memory: dispose the oldest view (including its timers) at the cap.
  if (registry.size >= 120) {
    const first = registry.keys().next().value;
    if (first) deleteView(first);
  }
  registry.get(view.sessionId)?.dispose();
  registry.set(view.sessionId, view);
}

export interface SessionViewOpts {
  sessionId: string;
  projectDir: string;
  channel: string;
  threadTs: string;
  threadKey: string;
  client: OCClient;
  deps: RenderDeps;
  state: StateStore;
  threadState: ThreadState;
  /**
   * ts of an already-posted live-status message (e.g. the cold-start ack the
   * router posts before the session exists) — adopted instead of re-posting.
   */
  statusTs?: string;
}

/**
 * SessionView renders one OpenCode session's event stream into a Slack thread.
 * Live activity rides a single status message re-rendered once a second
 * (alternating ⏳/⌛ + ticking elapsed — Slack chat.update tolerates ~1/s);
 * finished text parts post as their own thread replies.
 */
export class SessionView {
  sessionId: string;
  private readonly client: OCClient;
  readonly projectDir: string;
  private readonly channel: string;
  private readonly threadTs: string;
  readonly threadKey: string; // public: \status builds thread permalinks from it
  private readonly deps: RenderDeps;
  private readonly state: StateStore;
  private verbose: VerboseMode;

  private statusTs: string | null = null;
  /** True from beginPrompt until finalize — drives the queued-prompt ack. */
  private active = false;
  private readonly pendingText = new Map<string, string>();
  private readonly activeTools = new Map<string, string>();
  private readonly msgCost = new Map<string, { cost: number; input: number; output: number; model?: string }>();
  private readonly msgRoles = new Map<string, string>(); // messageID -> role (filter user echo)
  /** Assistant text part ids already posted to Slack (backstop dedup). */
  private readonly postedPartIds = new Set<string>();
  /** Tool call ids whose start line is already posted (pending → running dedup). */
  private readonly postedToolStarts = new Set<string>();
  private readonly terminalTools = new Set<string>();
  private toolTimer: NodeJS.Timeout | null = null;
  private readonly waiting = new Map<string, "question" | "permission">();
  private connectionState: ConnectionState;
  private generation = 0;
  private reconcileInFlight: Promise<boolean> | null = null;
  private disposed = false;
  /**
   * Buffered tool-start lines. Verbose-on used to post one Slack message per
   * tool call — tool-heavy runs backed the 1/s FIFO up and flooded phone
   * clients. Lines accumulate and flush as one message on section flips,
   * buffer pressure, the 1.5s deadline, or finalize.
   */
  private readonly toolBuf: string[] = [];
  private toolCalls = 0;
  /**
   * Section currently being appended to (⎯ tools ⎯ / ⎯ response ⎯). Dividers
   * are transition-based: models can interleave text and tool calls, so the
   * divider re-posts every time the stream flips sections — not once per run.
   */
  private lastSection: "tools" | "response" | null = null;
  private readonly files = new Set<string>();
  private activity = "starting…";
  /**
   * 1s live-status ticker. The status message re-renders every second while a
   * run is active — alternating ⏳/⌛ and a ticking elapsed counter — so a slow
   * run (model silently reasoning, long tool) is visibly ALIVE instead of
   * freezing between events.
   */
  private ticker: NodeJS.Timeout | null = null;
  /** Updates sent since ticker start — drives the ⏳/⌛ alternation. */
  private tickSeen = 0;
  /** Coalesce: never pile a second status update behind a still-stuck one. */
  private tickInFlight = false;
  /**
   * Set by any thread-content post while a run is active. Slack can't reorder
   * messages, so once content lands BELOW the live-status line the bar is
   * re-posted at the bottom (delete + post) — STRICT bottom (issue #6): every
   * content post schedules a sink via maybeSink(), coalesced by sinkInFlight.
   * Cleared on a successful sink and reset per run in beginPrompt.
   */
  private contentBelow = false;
  /** Serializes sink rounds — at most one post→adopt→delete in flight. */
  private sinkInFlight = false;
  private sinkRetryAt = 0;
  private sinkFailures = 0;
  /**
   * Circuit breaker for the strict sink: when this channel's lane is deep in
   * queued work (a torrent run), skip the sink attempt — the bar trails until
   * the next content post instead of burying the lane (and the run's final
   * summary) behind dozens of stale sink pairs.
   */
  private static readonly SINK_MAX_LANE_DEPTH = 8;
  /**
   * Set by the watchdog after a true stall: the ticker keeps re-rendering a
   * "still working" stall line (instead of the stale activity) until any SSE
   * event lands, so the nudge message is never silently clobbered 1s later.
   */
  private stalled = false;
  private finalized = false;
  /** Serializes event renders — every handle() runs after the previous one. */
  private tail: Promise<void> = Promise.resolve();
  /** Wall-clock start of the current prompt run — backstop only ever posts text created after this. */
  private runStartedAt = Date.now();
  /** Last SSE event seen — the watchdog only fires after a truly silent gap. */
  private lastEventAt = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  /** Stall nudges posted this run — capped so a hung run doesn't nudge forever. */
  private nudges = 0;
  /**
   * Prompts begun but not yet idled. OpenCode's queue semantics are
   * unverified (idle per prompt vs one idle when the queue drains), so a
   * non-final idle starts a grace window instead of finalizing outright.
   */
  private outstandingPrompts = 0;
  private idleGrace: NodeJS.Timeout | null = null;
  private static readonly IDLE_GRACE_MS = 8_000;
  /** ts of user messages awaiting ✅/❌ — resolved at finalize. */
  private readonly pendingUserMsgs: string[] = [];
  /**
   * \watch mode: this view mirrors a session driven OUTSIDE Slack (TUI/IDE).
   * Cross-process SSE does NOT propagate (live-verified 2026-09-16: a session
   * driven by another opencode process emits nothing on this server's /event
   * bus), so delivery is a transcript poll instead of the SSE handlers.
   */
  private attached = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  /** Transcript length at the previous poll — growth gates the settle timer. */
  private lastTranscriptSize = 0;
  /** Settles a completed/dormant watch into finalize (or a quiet detach). */
  private settleTimer: NodeJS.Timeout | null = null;
  /** True once the watcher posted at least one post-attach part. */
  private streamedAny = false;

  constructor(opts: SessionViewOpts) {
    this.sessionId = opts.sessionId;
    this.client = opts.client;
    this.projectDir = canonicalDir(opts.projectDir);
    this.connectionState = connections.get(this.projectDir) ?? "connected";
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.threadKey = opts.threadKey;
    this.deps = opts.deps;
    this.state = opts.state;
    this.statusTs = opts.statusTs ?? null;
    this.verbose = opts.threadState?.verbose ?? "on";
    registerView(this);
  }

  setVerbose(v: VerboseMode): void {
    this.verbose = v;
    if (v === "off") {
      this.cancelToolTimer();
      this.toolBuf.length = 0;
    }
  }

  setConnectionState(state: ConnectionState): void {
    if (this.finalized || this.disposed) return;
    this.connectionState = state;
    this.stalled = false;
    this.generation++;
  }

  /** IDs are scoped by kind, so independent asks cannot clear each other. */
  setWaiting(id: string, kind: "question" | "permission", waiting: boolean): void {
    if (this.finalized || this.disposed) return;
    const key = `${kind}:${id}`;
    if (waiting) this.waiting.set(key, kind);
    else this.waiting.delete(key);
    this.generation++;
    this.stalled = false;
    this.lastEventAt = Date.now();
    this.cancelIdleGrace();
    if (this.active && !this.attached) this.armWatchdog();
  }

  /** Call after an external question/permission thread post succeeds. */
  contentPosted(): void {
    if (this.finalized || this.disposed) return;
    this.contentBelow = true;
    this.maybeSink();
  }

  private stopTimers(): void {
    this.stopPolling();
    this.cancelIdleGrace();
    this.cancelToolTimer();
    if (this.ticker) clearInterval(this.ticker);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.ticker = this.watchdog = null;
  }

  /** Detach immediately; in-flight status posts clean themselves up on arrival. */
  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.generation++;
    this.stopTimers();
    this.toolBuf.length = 0;
    if (this.statusTs) {
      void this.deleteStatus(this.statusTs);
      this.statusTs = null;
    }
  }

  private async deleteStatus(ts: string): Promise<void> {
    try { await this.deps.delete(this.channel, ts); }
    catch (err) {
      if (!messageNotFound(err)) logErr(`status cleanup failed (${this.sessionId}, ${ts}): ${errorMessage(err)}`);
    }
  }

  /** Read-throughs for the \status board (describeActiveRuns) — no registry surgery. */
  get isActive(): boolean {
    return this.active;
  }
  get queuedCount(): number {
    return Math.max(0, this.outstandingPrompts - 1);
  }
  get currentRunElapsedMs(): number {
    return Date.now() - this.runStartedAt;
  }

  /**
   * RB2: a run whose completion signals were all lost (SSE dropped during the
   * final events) will never receive another event — its ⏳ hangs forever.
   * Require verified idle status and the newest completed transcript turn;
   * local waits and changes during the poll invalidate that proof.
   * Returns true when it finalized.
   */
  reconcileIfStale(now = Date.now(), staleMs = 120_000): Promise<boolean> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    if (this.finalized || this.disposed || !this.active || now - this.lastEventAt < staleMs) return Promise.resolve(false);
    const generation = this.generation;
    const sessionId = this.sessionId;
    const run = (async () => {
      try {
        await this.tail;
        if (this.finalized || this.disposed || generation !== this.generation) return false;
        const msgs = await sessionMessages(this.client, sessionId);
        this.reconcileReceipts(msgs);
        const idle = await sessionIdle(this.client, sessionId);
        const check = this.tail.then(async () => {
          if (this.finalized || this.disposed || generation !== this.generation || this.waiting.size) return false;
          if (!idle) return false;
          const completed = completedTail(msgs, this.runStartedAt - 2_000);
          if (!completed) {
            if (this.attached && !this.streamedAny && !msgs.some((m) => (m.info.time?.created ?? 0) >= this.runStartedAt - 2_000)) {
              await this.stopWatchingInner(`:eye_in_speech_bubble: Nothing running in \`${safePayload(shortId(this.sessionId))}\` right now — \`\\watch\` again when it starts.`);
              return true;
            }
            return false;
          }
          // Lost terminal events can leave activeTools stale. Transcript states
          // above, not that event cache, decide whether tools are still pending.
          await this.finalizeInner(completed.info.error ? errorMessage(completed.info.error) : undefined);
          return true;
        });
        this.tail = check.then(() => {}, () => {});
        return await check;
      } catch (err) {
        logErr(`reconcile failed (${sessionId}): ${errorMessage(err)}`);
        return false;
      }
    })();
    this.reconcileInFlight = run.finally(() => { this.reconcileInFlight = null; });
    return this.reconcileInFlight;
  }

  private reconcileReceipts(msgs: Transcript): void {
    for (const m of msgs) if (m.info?.role === "user") this.state.reconcilePromptAcceptance(this.projectDir, m.info);
  }

  /**
   * Re-point this view at a replacement session (e.g. after a stale-session
   * 404 rebind) so SSE events keep landing here and the ⏳ → ✅ lifecycle
   * on the user's message continues uninterrupted.
   */
  retargetSession(newSessionId: string): void {
    this.generation++;
    registry.delete(this.sessionId);
    this.sessionId = newSessionId;
    registry.set(newSessionId, this);
  }

  /** Idempotent: posts the live-status placeholder once per run. */
  async start(): Promise<void> {
    if (this.statusTs || this.finalized || this.disposed) return;
    this.lastSection = null;
    // Interactive: the run's ack message — the user is staring at the thread
    // waiting for it; it must not queue behind background stream traffic.
    const { ts } = await this.deps.post(this.channel, this.threadTs, "⏳ OpenCode is on it…", undefined, {
      unfurl: false,
      lane: "interactive",
    });
    if (this.finalized || this.disposed) { await this.deleteStatus(ts); return; }
    this.statusTs = ts;
  }

  /** No-activity watchdog: nudge the status line if nothing lands for 3 minutes. */
  private static readonly WATCHDOG_MS = 180_000;
  /** True-stall nudges per run, then the watchdog goes quiet instead of re-arming forever. */
  private static readonly MAX_NUDGES = 3;

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.finalized || this.disposed || this.statusTs == null) return;
      if (this.waiting.size || this.connectionState !== "connected" || Date.now() - this.lastEventAt < SessionView.WATCHDOG_MS - 1_000) {
        this.armWatchdog(); // events are still landing — just re-check later
        return;
      }
      this.nudges += 1;
      this.stalled = true; // the ticker takes over the stall line from here
      void this.updateStatus(this.statusTs, "⏳ still working… no updates for 3m — `\\stop` to cancel");
      // First true stall also pages the owner — a stalled run needs attention
      // even when nobody is watching the thread.
      if (this.nudges === 1) {
        const proj = this.projectDir.split("/").filter(Boolean).pop() ?? "run";
        void this.deps
          .dm?.(this.channel, this.threadTs, `:alarm_clock: *${safePayload(proj)}* stalled — no events for 3m. Reply \`\\stop\` in the thread to cancel.`)
          .catch(() => {});
      }
      if (this.nudges < SessionView.MAX_NUDGES) this.armWatchdog();
    }, SessionView.WATCHDOG_MS);
    this.watchdog.unref();
  }

  /**
   * Called when a new user prompt begins driving this session. Marks the
   * user's message for later ✅/❌ resolution and posts the live status.
   * A second prompt arriving mid-run gets a queued ack. Safe for
   * back-to-back prompts on an active session.
   */
  async beginPrompt(userMsgTs: string): Promise<void> {
    if (this.finalized || this.disposed) return;
    this.generation++;
    // A prompt through this thread means Slack is taking the watched session
    // over — stop the transcript poll and let the SSE handlers own delivery
    // (the runPrompt watchOnly gate has already been passed by \resume).
    if (this.attached) this.stopPolling();
    const wasActive = this.active;
    this.active = true;
    this.outstandingPrompts += 1;
    this.cancelIdleGrace(); // a new prompt cancels any pending "queue drained" finalize
    this.nudges = 0;
    this.stalled = false;
    this.contentBelow = false; // fresh run: the status line is at the top again
    if (!this.pendingUserMsgs.includes(userMsgTs)) this.pendingUserMsgs.push(userMsgTs);
    this.runStartedAt = Date.now();
    this.lastEventAt = Date.now();
    this.armWatchdog();
    await this.start();
    if (this.finalized || this.disposed) return;
    this.startTicker();
    // Tombstone for the interrupt sweep: if the bridge dies before finalize,
    // the next boot can resolve this thread's ⏳ instead of leaving it frozen.
    const cur = this.state.getThread(this.threadKey);
    if (cur) {
      const tombstones = [...new Set([...(cur.pendingRun?.userMsgTs ?? []), userMsgTs])];
      this.state.setThread(this.threadKey, { ...cur, pendingRun: { userMsgTs: tombstones, statusTs: this.statusTs ?? undefined } });
    }
    if (wasActive) {
      // Interactive: this ack directly answers the user's just-sent message.
      await this.deps
        .post(this.channel, this.threadTs, "⏳ Queued — runs after the current task.", undefined, {
          unfurl: false,
          lane: "interactive",
        })
        .catch(() => {});
      this.contentBelow = true; // the ack landed below the status line
      this.maybeSink();
    }
  }

  private cancelIdleGrace(): void {
    if (this.idleGrace) {
      clearTimeout(this.idleGrace);
      this.idleGrace = null;
    }
  }

  /**
   * \watch: attach this view to a session NOT driven by Slack. Posts the
   * watching status line, starts the 1s ticker, and polls the transcript —
   * SSE events for a TUI-driven session never reach this process (spike 1).
   * Deliberately NOT beginPrompt: no pendingRun tombstone (the boot interrupt
   * sweep must never ❌ this thread's unrelated messages), no user-message
   * lifecycle, and `runStartedAt` = attach time so finalize's delivery
   * backstop only posts content created after attaching — history is
   * \history's job, not the watcher's.
   */
  async attach(): Promise<void> {
    if (this.finalized || this.disposed) return;
    this.generation++;
    this.attached = true;
    this.active = true; // \status "runs in flight" + the idle reaper's busy check
    this.runStartedAt = Date.now();
    this.lastEventAt = this.runStartedAt;
    this.activity = "driven on the computer…";
    const { ts } = await this.deps.post(
      this.channel,
      this.threadTs,
      `👀 watching \`${shortId(this.sessionId)}\` — driven on the computer…`,
      undefined,
      { unfurl: false },
    );
    if (this.finalized || this.disposed) { await this.deleteStatus(ts); return; }
    this.statusTs = ts;
    this.startTicker();
    this.pollTimer = setInterval(() => void this.pollTranscript(), SessionView.POLL_MS);
    this.pollTimer.unref();
    void this.pollTranscript(); // first pass immediately, not one tick late
  }

  private static readonly POLL_MS = 3_000;
  /** A completed tail finalizes this long after the transcript stops growing. */
  private static readonly WATCH_SETTLE_MS = 8_000;

  private cancelSettle(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  /** Tear down watch polling (not the view) — Slack is taking the session over. */
  private stopPolling(): void {
    this.attached = false;
    this.cancelSettle();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Delta-poll the transcript and post what's new through the same rendering
   * path the SSE handlers use (postedPartIds/postedToolStarts dedup makes the
   * two delivery paths mutually safe). Also detects run completion: when the
   * tail message is a completed assistant message and the transcript has
   * stopped growing, settle → finalize with the usual stats line — or, when
   * nothing streamed at all, a quiet detach (attaching to an idle session).
   */
  private async pollTranscript(): Promise<void> {
    if (this.finalized || !this.attached || this.pollInFlight) return;
    // Self-guard: a view dropped from the registry (rebind, teardown, another
    // thread's \resume) must not keep polling and posting into its old thread.
    if (getView(this.sessionId) !== this) {
      this.stopPolling();
      return;
    }
    this.pollInFlight = true;
    const generation = this.generation;
    try {
      const msgs = await sessionMessages(this.client, this.sessionId);
      this.reconcileReceipts(msgs);
      const idle = await sessionIdle(this.client, this.sessionId).catch(() => false);
      const run = this.tail.then(async () => {
        if (this.finalized || this.disposed || !this.attached || generation !== this.generation) return;
        const grew = msgs.length !== this.lastTranscriptSize;
        const firstPoll = this.lastTranscriptSize === 0;
        this.lastTranscriptSize = msgs.length;
        if (grew && !firstPoll) this.cancelSettle(); // fresh activity always outvotes a pending settle

        for (const m of msgs) {
          if (this.disposed) return;
          const created = m.info?.time?.created ?? 0;
          if (created < this.runStartedAt - 2_000) continue; // pre-attach history is \history's job
          if (m.info?.role === "user") {
            this.activityUpdate("new prompt on the computer…");
            continue;
          }
          if (m.info?.role !== "assistant") continue;
          const done = !!m.info.time?.completed;
          for (const p of m.parts ?? []) {
            if (this.disposed || !this.attached) return;
            if (p.type === "text") {
              const text = (p as { text?: string }).text ?? "";
              if (!text.trim() || this.postedPartIds.has(p.id)) continue;
              // Stream while incomplete; post leftovers once the message completes.
              if (!p.time?.end && !done) {
                this.pendingText.set(p.id, text);
                this.activityUpdate("typing…");
                continue;
              }
              this.pendingText.delete(p.id);
              this.postedPartIds.add(p.id);
              this.streamedAny = true;
              await this.postThreadText(text);
            } else if (p.type === "tool") {
              await this.handleTool(p);
              if (this.verbose !== "off") this.streamedAny = true;
            } else if (p.type === "file") {
              await this.postFilePart(p).catch(() => {});
              this.streamedAny = true;
            }
          }
        }
        const tail = msgs.at(-1);
        const tailCreated = tail?.info?.time?.created ?? 0;
        const tailDone = !!completedTail(msgs, this.runStartedAt - 2_000);
        const postAttach = tailCreated >= this.runStartedAt - 2_000;
        if (idle && !this.waiting.size && (!postAttach || (tailDone && !grew))) {
          // Recheck server proof when the settle timer fires, not just here.
          if (!this.settleTimer) {
            this.settleTimer = setTimeout(() => {
              this.settleTimer = null;
              void this.reconcileIfStale(Date.now(), 0);
            }, SessionView.WATCH_SETTLE_MS);
            this.settleTimer.unref();
          }
        } else this.cancelSettle();
      });
      this.tail = run.then(() => {}, () => {});
      await run;
    } catch (err) {
      // The server for this project died mid-watch: the pool's death hook
      // finalizes this view with a visible reason — swallow poll errors here.
      logErr(`watch poll failed (${this.sessionId}): ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * End a watch without the run-summary machinery: remove the status line,
   * drop the view, ungate the thread. Used by \unwatch and the idle-attach
   * settle. Idempotent with finalize() (whichever ran first wins).
   */
  async stopWatching(reason?: string): Promise<void> {
    const run = this.tail.then(() => this.stopWatchingInner(reason));
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  private async stopWatchingInner(reason?: string): Promise<void> {
    if (this.finalized || this.disposed) return;
    this.finalized = true;
    this.stopTimers();
    this.active = false;
    if (this.statusTs) {
      await this.deleteStatus(this.statusTs);
      this.statusTs = null;
    }
    const cur = this.state.getThread(this.threadKey);
    if (cur) this.state.setThread(this.threadKey, { ...cur, watchOnly: false });
    if (registry.get(this.sessionId) === this) deleteView(this.sessionId);
    if (reason) await this.deps.post(this.channel, this.threadTs, reason, undefined, { unfurl: false }).catch(() => {});
  }

  /**
   * session.idle bookkeeping for queued prompts. OpenCode's queue semantics
   * are unverified — it may emit one idle per queued prompt, or stay busy
   * until the queue drains and emit a single idle. Correct under both:
   * decrement the count; when prompts are still outstanding, start an 8s
   * grace window that only a genuinely new run signal cancels (beginPrompt,
   * session.status busy, step-start — trailing bookkeeping events must NOT
   * stall the grace forever). Quiet expiry means the queue really drained.
   */
  private async onIdle(): Promise<void> {
    if (this.waiting.size) return;
    this.outstandingPrompts = Math.max(0, this.outstandingPrompts - 1);
    if (this.outstandingPrompts > 0) {
      this.cancelIdleGrace();
      this.idleGrace = setTimeout(() => {
        this.idleGrace = null;
        void this.finalize();
      }, SessionView.IDLE_GRACE_MS);
      this.idleGrace.unref();
      return;
    }
    // NOTE: onIdle runs INSIDE the serialized tail chain — calling the public
    // finalize() here would await the chain that is awaiting us (deadlock —
    // this actually shipped: idle events between 2026-09-01 and this fix never
    // completed finalization). finalizeInner is the correct in-chain call.
    await this.finalizeInner();
  }

  async handle(ev: OcEvent): Promise<void> {
    if (this.finalized || this.disposed) return;
    this.generation++;
    // Serialize event processing: Slack's API delivers results the instant a
    // post is enqueued, so two events processed concurrently can enqueue their
    // posts out of arrival order (dividers/messages out of order). Chain every
    // event's render run after the previous one, whatever it awaits inside.
    const run = this.tail.then(() => this.handleInner(ev)).catch((err) => {
      logErr(`session view event error (${ev.type}): ${String((err as Error)?.message ?? err)}`);
      // A pipeline error must not leave the thread hanging at ⏳ until the
      // watchdog — surface it as a finalized failure (idempotent).
      void this.finalize(`event pipeline error: ${truncate(String((err as Error)?.message ?? err), 200)}`);
    });
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  private async handleInner(ev: OcEvent): Promise<void> {
    if (this.finalized || this.disposed) return;
    this.lastEventAt = Date.now();
    this.stalled = false; // any SSE signal means the run is alive — drop the stall line
    const props = (ev.properties ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "message.part.updated": {
        const part = props.part as OcPart | undefined;
        if (!part) return;
        if (part.type === "text") {
          // The user's own prompt streams through as a text part too — skip it.
          const role = part.messageID ? this.msgRoles.get(part.messageID) : undefined;
          if (role === "user") return;
          const text = part.text ?? "";
          if (part.time?.end) {
            this.pendingText.delete(part.id);
            if (text.trim() && !this.postedPartIds.has(part.id)) {
              this.postedPartIds.add(part.id);
              await this.postThreadText(text);
            }
          } else {
            this.pendingText.set(part.id, text);
            this.activityUpdate("typing…");
          }
        } else if (part.type === "tool") {
          await this.handleTool(part);
        } else if (part.type === "file") {
          // Model-produced file/image output — displayed inline.
          await this.postFilePart(part);
        } else if (part.type === "reasoning") {
          // Reasoning streams silently: no post, no divider — the response
          // divider must only appear when real non-reasoning content shows.
          this.activityUpdate("💭 reasoning…");
        } else if (part.type === "step-start") {
          this.cancelIdleGrace(); // unambiguous "a queued run started" signal
          this.activityUpdate("🧠 thinking…");
        }
        return;
      }
      case "message.updated": {
        const info = props.info as
          | { id: string; role: string; cost?: number; modelID?: string; providerID?: string; tokens?: { input?: number; output?: number }; error?: { name?: string; data?: Record<string, unknown> }; time?: { completed?: number } }
          | undefined;
        if (!info) return;
        if (!this.msgRoles.has(info.id)) this.msgRoles.set(info.id, info.role);
        if (info.role !== "assistant") return;
        this.msgCost.set(info.id, {
          cost: info.cost ?? 0,
          input: info.tokens?.input ?? 0,
          output: info.tokens?.output ?? 0,
          model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
        });
        if (info.error && info.time?.completed) {
          const msg =
            (info.error.data?.message as string | undefined) ?? info.error.name ?? "provider error";
          await this.finalizeInner(msg); // in-chain: finalizeInner, not finalize (deadlock)
        }
        return;
      }
      case "session.status": {
        const st = props.status as { type?: string; message?: string; attempt?: number } | undefined;
        if (!st?.type) return;
        if (st.type === "busy") {
          this.cancelIdleGrace(); // a queued run took over before the grace expired
          this.activityUpdate("working…");
        } else if (st.type === "retry") this.activityUpdate(`retrying${st.message ? `: ${safePayload(truncate(st.message, 60))}` : ""} (attempt ${st.attempt ?? "?"})`);
        else if (st.type === "idle") await this.onIdle();
        return;
      }
      case "session.idle":
        await this.onIdle();
        return;
      case "session.error":
        await this.finalizeInner(errorMessage(props.error)); // in-chain
        return;
      case "file.edited": {
        if (typeof props.file === "string") {
          this.files.add(props.file);
          this.activityUpdate(`edited ${safePayload(shortPath(props.file))}`);
        }
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------

  /**
   * Reaction failures must not break the run — but they must not be silent
   * either (a missing reactions:write scope is fixed by reinstalling the app).
   */
  private async reactOrLog(channel: string, ts: string, name: string, add: boolean): Promise<void> {
    await reactLogged(this.deps, channel, ts, name, add);
  }

  private activityUpdate(line: string): void {
    // The 1s ticker picks the change up on its next beat — no per-event push.
    this.activity = line;
  }

  /** Begin the per-second status re-render. Idempotent; started on beginPrompt. */
  private startTicker(): void {
    if (this.ticker) return;
    this.tickSeen = 0;
    this.ticker = setInterval(() => this.tick(), SessionView.TICK_MS);
    this.ticker.unref(); // a leaked view must never hold the bridge process open
  }

  private static readonly TICK_MS = 1_000;

  private tick(): void {
    if (this.finalized || this.disposed || this.tickInFlight) return;
    // The sink owns the beat whenever the bar isn't at the bottom (issue #6):
    // re-homing it IS this second's refresh — a same-second re-render on top
    // would double-post. Sinks are never gated on queue depth; the round-1 #4
    // design gated them inside the ticker, so any sustained queue traffic
    // pinned the bar to the top for the whole run.
    if (this.contentBelow || this.sinkInFlight || this.statusTs == null) {
      this.maybeSink();
      return;
    }
    // Yield when THIS channel's lane has real work queued: a command reply /
    // content post ahead of us is more time-sensitive than a status
    // re-render, and the next beat is 1s away regardless (issue #3). Only the
    // plain re-render yields — the sink above never does.
    if (laneDepth(this.channel) > 0) return;
    this.tickInFlight = true;
    this.tickSeen += 1;
    void this.updateStatus(this.statusTs, this.statusText())
      .finally(() => {
        this.tickInFlight = false;
      });
  }

  private async updateStatus(ts: string, text: string): Promise<void> {
    try { await this.deps.update(this.channel, ts, text); }
    catch (err) {
      if (messageNotFound(err) && this.statusTs === ts && !this.finalized && !this.disposed) {
        this.statusTs = null;
        this.syncTombstoneStatusTs();
        this.contentBelow = true;
        this.maybeSink();
      } else if (!messageNotFound(err)) logErr(`status update failed (${this.sessionId}): ${errorMessage(err)}`);
    }
  }

  /**
   * Re-home the live-status message to the bottom of the thread (STRICT,
   * issue #6 — user decision over a 4s throttle). Every content post lands
   * below the bar, so each schedules this: post a fresh status at the bottom,
   * adopt its ts, delete the old one. Coalesced by sinkInFlight (bursts chain
   * back-to-back rounds via the finally re-check, never overlapping); the
   * lane-depth circuit breaker makes torrents trail the bar instead of
   * burying the lane in stale sink pairs. Failed posts retain the dirty flag;
   * later ticks/content retry after the 2/4/8/16/30s backoff deadline.
   */
  private maybeSink(): void {
    if (this.finalized || this.disposed || this.sinkInFlight || !this.contentBelow || Date.now() < this.sinkRetryAt) return;
    if (this.statusTs == null && !this.active) return;
    if (laneDepth(this.channel) > SessionView.SINK_MAX_LANE_DEPTH) return;
    this.sinkInFlight = true;
    // The flag is CONSUMED up front so content landing mid-flight re-arms it
    // for the chase below (clearing it at completion would clobber exactly
    // that evidence and strand the bar above newer content).
    this.contentBelow = false;
    this.tickSeen += 1; // a sink is a visible refresh — keep the glass alternating
    const text = this.statusText();
    const oldTs = this.statusTs;
    void this.deps
      .post(this.channel, this.threadTs, text, undefined, { unfurl: false })
      .then(({ ts }) => {
        // finalize() may have run while the post was in flight (it deletes the
        // then-current statusTs). If so, the message we just posted is an
        // orphan — delete it rather than re-adopting it.
        if (this.finalized || this.disposed) return this.deleteStatus(ts);
        this.sinkFailures = 0;
        this.sinkRetryAt = 0;
        this.statusTs = ts;
        // The crash-recovery tombstone must point at the LIVE bar: a bridge
        // death after a sink would otherwise leave the boot interrupt sweep
        // deleting a stale ts and missing this one (orphaned "still working").
        this.syncTombstoneStatusTs();
        if (oldTs) return this.deleteStatus(oldTs);
      })
      .catch((err) => {
        this.contentBelow = true; // the sink failed — retry on a later beat/post
        this.sinkRetryAt = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(this.sinkFailures++, 4));
        logErr(`status sink failed (${this.sessionId}): ${errorMessage(err)}`);
      })
      .finally(() => {
        this.sinkInFlight = false;
        // Content landed while we were re-homing — keep chasing (strict bottom).
        this.maybeSink();
      });
  }

  /** Keep the interrupt sweep's tombstone pointed at the live status message. */
  private syncTombstoneStatusTs(): void {
    const cur = this.state.getThread(this.threadKey);
    if (!cur?.pendingRun || cur.pendingRun.statusTs === this.statusTs) return;
    this.state.setThread(this.threadKey, { ...cur, pendingRun: { ...cur.pendingRun, statusTs: this.statusTs ?? undefined } });
  }

  private statusText(): string {
    const glass = this.tickSeen % 2 ? "⌛" : "⏳";
    const elapsed = dur(Date.now() - this.runStartedAt);
    if (this.waiting.size) {
      const kinds = new Set(this.waiting.values());
      const what = kinds.size === 2 ? "your answer and permission" : kinds.has("question") ? "your answer" : "permission";
      return `${glass} Waiting for ${what} (${elapsed})`;
    }
    if (this.connectionState !== "connected") {
      const label = this.connectionState === "connecting" ? "Connecting to OpenCode" : this.connectionState === "reconnecting" ? "Reconnecting to OpenCode" : "Disconnected from OpenCode";
      return `${glass} ${label} · last update ${dur(Date.now() - this.lastEventAt)} ago`;
    }
    // Watching mirrors someone else's driving — a distinct prefix so the line
    // never reads as if Slack started this run.
    if (this.attached) return `👀 ${this.activity || "watching…"} (${elapsed})`;
    // Post-stall, the watchdog's "no updates for 3m" nudge owns the diagnosis —
    // the ticker just keeps the line visibly alive (distinct wording on purpose).
    if (this.stalled) return `${glass} still working… (${elapsed}) — \`\\stop\` to cancel`;
    return `${glass} ${this.activity || "working…"} (${elapsed})`;
  }

  private toolTitle(part: OcPart): string {
    return formatTool(part, this.projectDir);
  }

  /**
   * Transition into a thread section. Returns the divider text to prepend to
   * the section's FIRST content line (so divider + content travel as ONE
   * atomic Slack message — they can never interleave out of order), or null
   * when already in the section / when nothing needs separating.
   */
  private enterSection(s: "tools" | "response"): string | null {
    if (this.lastSection === s) return null;
    const from = this.lastSection;
    this.lastSection = s;
    // The divider's only job is separating sections from EACH OTHER. When the
    // response is the first thing in the thread (no tools ran above), there is
    // nothing to separate — a lone ⎯ response ⎯ line would be pure noise.
    if (s === "response" && from === null) return null;
    return s === "tools" ? "⎯⎯⎯ tools ⎯⎯⎯" : "⎯⎯⎯ response ⎯⎯⎯";
  }

  /** Post the section divider + first line as one message when a divider is due. */
  private async postSection(s: "tools" | "response", firstLine: string): Promise<void> {
    if (this.disposed) return;
    const divider = this.verbose === "off" ? null : this.enterSection(s);
    // Tool chatter suppresses link previews; answer text keeps them.
    await this.deps.post(
      this.channel,
      this.threadTs,
      divider ? `${divider}\n\n${firstLine}` : firstLine,
      undefined,
      { unfurl: s === "tools" ? false : undefined },
    );
    // Mark the bar as above-content — the SINK is scheduled by the outermost
    // content emitter (postThreadText / handleTool / postFilePart / queued
    // ack) after its LAST message, so the bar re-homes cleanly below a whole
    // logical step instead of splitting a tools→answer pair mid-flight.
    this.contentBelow = true;
  }

  /** Emit buffered tool lines as a single tools-section message (atomic with the divider). */
  private async flushTools(): Promise<void> {
    this.cancelToolTimer();
    if (!this.toolBuf.length) return;
    const body = this.toolBuf.join("\n");
    this.toolBuf.length = 0;
    if (this.verbose === "off" || this.disposed) return;
    await this.postSection("tools", body);
  }

  private cancelToolTimer(): void {
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.toolTimer = null;
  }

  private bufferTool(part: OcPart): void {
    const callId = part.callID ?? part.id;
    if (this.postedToolStarts.has(callId)) return;
    this.postedToolStarts.add(callId);
    if (this.verbose === "off") return;
    this.toolBuf.push(formatTool(part, this.projectDir));
    if (this.toolTimer) return;
    const timer = setTimeout(() => {
      // Keep the token until the serialized flush executes: new items never
      // slide the deadline, and an early flush invalidates this queued callback.
      const run = this.tail.then(async () => {
        if (this.toolTimer !== timer || this.finalized || this.disposed) return;
        await this.flushTools();
        this.maybeSink();
      }).catch((err) => {
        logErr(`tool batch failed (${this.sessionId}): ${errorMessage(err)}`);
        void this.finalize(`tool batch delivery failed: ${errorMessage(err)}`);
      });
      this.tail = run.then(() => {}, () => {});
    }, 1_500);
    timer.unref();
    this.toolTimer = timer;
  }

  private async handleTool(part: OcPart): Promise<void> {
    const st = part.state ?? {};
    const callId = part.callID ?? part.id;
    const title = this.toolTitle(part);
    if (this.terminalTools.has(callId)) return;
    if (st.status === "completed" || st.status === "error") {
      this.terminalTools.add(callId);
      this.toolCalls++;
      this.bufferTool(part); // missing running event: synthesize its useful start
    }
    switch (st.status) {
      case "running":
      case "pending": {
        this.activeTools.set(callId, title);
        this.activityUpdate(`tool: ${title}`);
        // Pending events carry empty input ("📄 read …"); don't burn the one
        // line per call on it — wait for `running`, which has real targets.
        if (st.status === "pending") return;
        this.bufferTool(part);
        if (this.toolBuf.length >= 8 || this.toolBuf.join("\n").length > 2000) {
          await this.flushTools();
          this.maybeSink(); // tool lines landed below the bar — re-home it
        }
        return;
      }
      case "completed": {
        this.activeTools.delete(callId);
        this.activityUpdate(`done: ${title}`);
        if (this.verbose === "full") {
          const raw = this.extractOutput(st);
          const out = typeof raw === "string" ? raw : raw ? JSON.stringify(raw, null, 2) : "";
          if (out.trim()) {
            await this.flushTools(); // buffered start lines precede their output
            // tool output belongs in the tools section
            if (out.length > 400) {
              await this.postSection("tools", `:hammer_and_wrench: ${title}`);
              if (this.disposed) return;
              await this.deps.upload({
                channelId: this.channel,
                threadTs: this.threadTs,
                filename: `${part.tool ?? "tool"}-${callId.slice(-6)}.txt`.replace(/[^\w.-]/g, "-"),
                content: out.slice(0, 200_000),
              });
            } else {
              await this.postSection("tools", `\`\`\`${safeCodePayload(out.slice(0, 3700), true)}\`\`\``);
            }
            this.maybeSink(); // output landed below the bar — re-home it
          }
        }
        if (this.toolBuf.length >= 8 || this.toolBuf.join("\n").length > 2000) {
          await this.flushTools();
          this.maybeSink();
        }
        return;
      }
      case "error": {
        this.activeTools.delete(callId);
        this.activityUpdate(`⚠️ tool failed: ${title}`);
        const errText = typeof st.error === "string" ? st.error : JSON.stringify(st.error);
        await this.flushTools(); // buffered start lines precede the failure
        await this.postSection("tools", `⚠️ ${title} failed: ${safePayload(truncate(errText ?? "unknown", 400))}`);
        this.maybeSink(); // errors remain visible even in silent mode
        return;
      }
      default:
        return;
    }
  }

  private extractOutput(st: { output?: unknown; metadata?: Record<string, unknown> }): unknown {
    if (typeof st.output === "string" && st.output.trim()) return st.output;
    const meta = st.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.output === "string") return meta.output;
    return st.output;
  }

  /**
   * Display a model-produced file part (images) inline: fetch its bytes,
   * then upload to the thread. Counted as response content — it gets the
   * ⎯ response ⎯ divider, unlike tool chatter.
   */
  private async postFilePart(part: OcPart): Promise<void> {
    if (this.disposed) return;
    const url = part.url ?? "";
    if (!url || this.postedPartIds.has(part.id)) return;
    this.postedPartIds.add(part.id);
    await this.flushTools(); // including file-fetch failure notices
    const mime =
      part.mime ?? (url.startsWith("data:") ? url.slice(5, url.indexOf(";") || undefined) : undefined) ?? "application/octet-stream";
    let data: Buffer;
    try {
      if (url.startsWith("data:")) {
        data = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = Buffer.from(await res.arrayBuffer());
      }
    } catch (err) {
      await this.deps
        .post(
          this.channel,
          this.threadTs,
           `:warning: couldn't display ${safePayload(part.filename ?? "model output file")} (${safePayload(errorMessage(err))})`,
          undefined,
          { unfurl: false },
        )
        .then(() => {
          this.contentBelow = true; // the error notice landed below the bar
          this.maybeSink();
        })
        .catch(() => {});
      return;
    }
    if (!data.length || this.disposed) return;
    const ext = mime.includes("/") ? mime.split("/").pop()! : "bin";
    const filename = part.filename ?? `output-${part.id.slice(-6)}.${ext}`;
    await this.flushTools(); // buffered tool chatter precedes response content
    if (this.disposed) return;
    // Divider must precede the upload — post it with a tiny banner comment as
    // its own message when a section flip is due (uploads can't join text).
    const divider = this.enterSection("response");
    if (divider) {
      await this.deps.post(this.channel, this.threadTs, divider, undefined, { unfurl: false });
      this.contentBelow = true; // the divider landed below the bar
    }
    await this.deps.upload({
      channelId: this.channel,
      threadTs: this.threadTs,
      filename,
      file: data,
      comment: `:framed_picture: ${safePayload(filename)} received.`,
    });
    this.contentBelow = true; // the upload landed below the live-status line
    this.maybeSink(); // last message of this emit step — re-home the bar now
  }

  async postThreadText(text: string): Promise<void> {
    if (this.disposed) return;
    // Assistants emit GitHub-flavored markdown; Slack speaks mrkdwn. Trim the
    // extremes: model parts routinely lead/trail with \n, and the divider joins
    // with \n\n — untrimmed, that becomes 3+ blank lines after ⎯ response ⎯.
    const converted = mdToMrkdwn(text).trim();
    // Response divider ONLY when real non-reasoning content is about to show —
    // whitespace-only or otherwise invisible text must not mint a section.
    if (!converted) return;
    await this.flushTools(); // buffered tool chatter precedes response content
    const chunks = chunkText(converted);
    const first = chunks.shift();
    if (first === undefined) return;
    // Divider + first chunk post as ONE atomic message.
    await this.postSection("response", first);
    for (const chunk of chunks) {
      if (this.disposed) return;
      await this.deps.post(this.channel, this.threadTs, chunk);
      this.contentBelow = true; // continuation chunk landed below the bar
    }
    // Last message of this emit step — strict bottom: the bar chases now.
    this.maybeSink();
  }

  async finalize(err?: string): Promise<void> {
    // Finalize can be invoked from outside the event chain (prompt-failure
    // path in the router) — run it through the same serialization so it
    // can't interleave with an in-flight event render.
    const run = this.tail.then(() => this.finalizeInner(err)).catch((error) => {
      logErr(`finalize failed (${this.sessionId}): ${errorMessage(error)}`);
      if (registry.get(this.sessionId) === this) deleteView(this.sessionId);
    });
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  private async finalizeInner(err?: string): Promise<void> {
    if (this.finalized || this.disposed) return;
    this.finalized = true;
    this.generation++;
    this.active = false;
    // A watched run just ended — stop the poll and ungate the thread in the
    // same breath (watchOnly must never outlive its view).
    const wasWatch = this.attached;
    this.stopTimers();
    // Run completed normally — it is no longer an interruption candidate.
    // One write: clear any tombstone, and lift the watch gate when this was a
    // watched run (watchOnly must never outlive its view). A second spread of
    // `cur` here would resurrect a just-cleared tombstone — hence single write.
    const cur = this.state.getThread(this.threadKey);
    if (cur && (cur.pendingRun || wasWatch)) {
      this.state.setThread(this.threadKey, { ...cur, pendingRun: undefined, watchOnly: wasWatch ? false : cur.watchOnly });
    }
    this.outstandingPrompts = 0;
    await this.flushTools().catch((error) => logErr(`final tool flush failed (${this.sessionId}): ${errorMessage(error)}`));

    // Flush text that never got an explicit `end` marker.
    for (const [id, text] of this.pendingText) {
      if (text.trim() && !this.postedPartIds.has(id)) {
        this.postedPartIds.add(id);
        await this.postThreadText(text).catch((error) => logErr(`final text flush failed (${this.sessionId}): ${errorMessage(error)}`));
      }
    }
    this.pendingText.clear();

    // Delivery backstop: the SSE stream can drop the final text part (or its
    // post can be silently lost), so pull the session's messages and post any
    // assistant text Slack never got. Only messages created for THIS run are
    // considered — earlier turns were already delivered (and this view's
    // posted-set doesn't know about them). Errors degrade to SSE-only behavior.
    try {
      const msgs = await sessionMessages(this.client, this.sessionId);
      this.reconcileReceipts(msgs);
      for (const m of msgs) {
        if (m.info?.role !== "assistant") continue;
        if ((m.info.time?.created ?? 0) < this.runStartedAt - 2_000) continue;
        for (const p of m.parts ?? []) {
          if (p.type === "text") {
            const text = (p as { text?: string }).text ?? "";
            if (!text.trim() || this.postedPartIds.has(p.id)) continue;
            this.postedPartIds.add(p.id);
            await this.postThreadText(text);
          } else if (p.type === "file") {
            await this.postFilePart(p).catch(() => {});
          }
        }
      }
    } catch {
      /* best effort — SSE delivery already handled the common path */
    }

    let summary: { additions: number; deletions: number; files: number } | null = null;
    try {
      const s = await sessionGet(this.client, this.sessionId);
      summary = s.summary ?? null;
    } catch {
      /* best effort */
    }

    let cost = 0;
    let input = 0;
    let output = 0;
    let model: string | undefined;
    for (const v of this.msgCost.values()) {
      cost += v.cost;
      input += v.input;
      output += v.output;
      if (v.model) model = v.model;
    }

    const bits: string[] = [];
    // Current project name (basename of the session's dir) leads the line.
    const proj = this.projectDir.split("/").filter(Boolean).pop();
    if (proj) bits.push(`*${safePayload(proj)}*`);
    if (summary && (summary.additions || summary.deletions || summary.files)) {
      bits.push(`+${summary.additions}/−${summary.deletions} across ${summary.files} file(s)`);
    } else if (this.files.size) {
      bits.push(`${this.files.size} file(s) touched`);
    }
    if (model) bits.push(`\`${safePayload(model)}\``);
    bits.push(dur(Date.now() - this.runStartedAt));
    if (cost) bits.push(money(cost));
    if (input || output) bits.push(`${tok(input)}↑/${tok(output)}↓`);
    // Rightmost: visibility mode for this run (what "N tool call(s)" used to say).
    bits.push(this.verbose === "off" ? "Silent Tools" : "Verbose Tools");

    // Outcome lives on the USER's message(s) as reactions — no "Done" chatter.
    // Every prompt picked up since the last finalize gets resolved, so
    // back-to-back messages can't miss their ✅/❌. The 👀 liveness ack from
    // dispatch is removed first — one state per message (seen → outcome).
    for (const ts of this.pendingUserMsgs) {
      if (this.disposed) return;
      await this.reactOrLog(this.channel, ts, "eyes", false);
      await this.reactOrLog(this.channel, ts, err ? "x" : "white_check_mark", true);
    }
    this.pendingUserMsgs.length = 0;
    // The live-status message has served its purpose — remove it to keep the thread clean.
    if (this.statusTs) {
      await this.deleteStatus(this.statusTs);
      this.statusTs = null;
    }
    // The summary/error line is the one message that must never be lost: a
    // dropped post (rate-limit give-up etc.) used to skip the DM + registry
    // cleanup entirely and leak the view. If it fails, tell the owner by DM.
    if (this.disposed) return;
    const summaryLine = err ? `:x: ${safePayload(truncate(err, 200))}` : bits.length ? bits.join(" · ") : null;
    if (summaryLine) {
      await this.deps.post(this.channel, this.threadTs, summaryLine, undefined, { unfurl: false }).catch(async (postErr) => {
        logErr(`run summary post failed (${this.sessionId}): ${String((postErr as Error)?.message ?? postErr)}`);
        await this.deps
          .dm?.(this.channel, this.threadTs, `:warning: couldn't post the run's final line in-thread (Slack error) — outcome: ${truncate(summaryLine, 300)}`)
          .catch(() => {});
      });
    }
    // Owner DM — the remote pager. Failures always page; completions only
    // when \notify is on for this thread. Best-effort: DM delivery must
    // never hold up or fail the thread-side finalize.
    try {
      if (err) {
        await this.deps.dm?.(this.channel, this.threadTs, `:x: *${safePayload(proj ?? "run")}* failed: ${safePayload(truncate(err, 200))}`);
      } else if (bits.length) {
        const notify = this.state.getThread(this.threadKey)?.notify;
        if (notify) {
          const dmText = `:white_check_mark: done — ${bits.join(" · ")}`;
          await this.deps.dm?.(
            this.channel,
            this.threadTs,
            dmText,
            // RF1: one-tap diff straight from the completion DM (handled by
            // the "view_diff" action in start.ts).
            viewDiffBlocks(dmText, this.sessionId),
          );
        }
      }
    } catch {
      /* DM is best-effort; the thread copy posted above */
    }
    if (registry.get(this.sessionId) === this) deleteView(this.sessionId);
  }
}
