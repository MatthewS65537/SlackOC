import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { loadConfig, PID_PATH, CONFIG_PATH, STATE_PATH } from "./config.js";
import { StateStore } from "./state.js";
import { ServerPool } from "./opencode/server.js";
import { noteSessionActivity } from "./commands/picker.js";
import { PERMISSION_STORE_PATH, PermissionDeliveryStore } from "./slack/permissions.js";
import { QuestionsStore } from "./slack/questions-store.js";
import { recoverInterruptedRuns } from "./slack/boot-recovery.js";
import { handleIncomingMessage, shouldRouteMessage, type BridgeDeps } from "./slack/router.js";
import { sessionGet } from "./opencode/client.js";
import { getView, reconcileStaleViews, setProjectConnectionState, describeActiveRuns, deleteView } from "./slack/render.js";
import { createRenderDeps } from "./slack/render-deps.js";
import { createInteractions } from "./slack/interactions.js";
import { registerDiffActions } from "./slack/diff-view.js";
import { registerRunControls } from "./slack/run-controls.js";
import { registerModelSearch, registerPickerActions } from "./slack/pickers.js";
import { registerHome } from "./slack/home.js";
import { registerShortcut } from "./slack/shortcut.js";
import { createCatchupRunner } from "./slack/catchup-runner.js";
import { GhostDetector } from "./ghosts.js";
import { noteSlackOnline, slackOffline } from "./slack/queue.js";
import { slackWebClientOptions, slackSocketClientOptions } from "./slack/transport.js";
import { isSocketModeFailure, SocketSupervisor } from "./slack/socket-supervisor.js";
import { boundedShutdown, parsePid, pidAlive, pidfilePredatesBoot, startManagedRuntime, stopManagedService } from "./service.js";
import { enableFileLog, logErr, pushLog, ringLogger } from "./log.js";
import { type OcMessageInfo, type OcPermission, type OcQuestionRequest } from "./opencode/api.js";
import { createScheduledReports, type ScheduledReports } from "./schedules/slack.js";

export interface StartOpts {
  cwd: string;
}

/** RB2: sweep for runs whose completion signals were lost (SSE gap) every minute; a run untouched for 2 min is checked. */
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_STALE_MS = 120_000;
const CATCHUP_INTERVAL_MS = 10_000;
/** Managed runs exit (launchd restarts a clean process) after Slack is unreachable this long. */
const SOCKET_FATAL_MS = 10 * 60_000;

export async function startBridge(opts: StartOpts): Promise<void> {
  // Persistent log (rotated bridge.log in the config dir) — crashes, ghost
  // incidents, and 429 storms from before this boot become post-mortem-able.
  enableFileLog();
  const config = loadConfig();
  if (!config) {
    console.error(`No config at ${CONFIG_PATH} — run \`slackoc init\` first.`);
    process.exitCode = 1;
    return;
  }
  // Claim the pidfile BEFORE connecting to Slack or reading state. The boot
  // interrupt sweep resolves pendingRun tombstones from state.json — running
  // it from a second instance while the first is alive would ❌ and tear down
  // the LIVE instance's in-flight runs.
  const claim = claimPidfile(PID_PATH);
  if (claim === "running") {
    console.error(`slackoc already running (pid ${readPid(PID_PATH)}) — run \`slackoc stop\` first.`);
    process.exitCode = 1;
    return;
  }
  if (claim === "starting") {
    console.error("another slackoc instance is starting up — try again in a moment.");
    process.exitCode = 1;
    return;
  }
  const runtime = startManagedRuntime();
  const cleanup: Array<() => void | Promise<unknown>> = [];
  const lifetime = new AbortController();
  let stopping = false;
  const finishShutdown = boundedShutdown(async () => {
    console.error("\nslackoc stopping…");
    for (const { sessionId } of describeActiveRuns()) deleteView(sessionId);
    await Promise.allSettled(cleanup.map((close) => Promise.resolve().then(close)));
  }, (code) => {
    runtime.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
    if (readPid(PID_PATH) === process.pid) rmSync(PID_PATH, { force: true });
    process.exit(code);
  });
  const shutdown = (code = 0) => {
    stopping = true;
    lifetime.abort(new Error("bridge stopping"));
    return finishShutdown(code);
  };
  const onSignal = () => { void shutdown(); };
  const onException = (err: Error) => {
    logErr(`uncaught exception: ${String((err as Error)?.stack ?? err).slice(0, 400)}`);
    void shutdown(1);
  };
  let socketSupervisor: SocketSupervisor | undefined;
  const onRejection = (err: unknown) => {
    if (isSocketModeFailure(err) && socketSupervisor) {
      logErr(`slack socket rejection: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      socketSupervisor.noteLibraryFailure(err);
      return;
    }
    logErr(`unhandled rejection: ${String((err as Error)?.stack ?? err).slice(0, 400)}`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  try {
  const state = new StateStore(STATE_PATH);
  const permissionStore = openStore(PERMISSION_STORE_PATH, (path) => new PermissionDeliveryStore(path));
  const questionStore = openStore(`${dirname(STATE_PATH)}/questions.json`, (path) => new QuestionsStore(path));
  let scheduledReports: ScheduledReports | undefined;
  let interactionsEnabled = false;
  // The launch cwd owns the default project on EVERY start. currentProjectDir
  // persists across runs (set by \cd / \new / \project), so it must not be
  // allowed to override where the server was launched — \cd et al. still move
  // the default mid-run; existing threads keep their own bound dir.
  state.setCurrentProject(opts.cwd);

  const clientOptions: typeof slackWebClientOptions = {
    ...slackWebClientOptions,
    fetch: (url, init) => slackWebClientOptions.fetch!(url, {
      ...init, signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
    }),
  };
  // The socket client gets its own options (bounded retries for
  // apps.connections.open) and NO library auto-reconnect: SocketSupervisor
  // owns reconnection, because the library abandons it after one network error.
  const socketClientOptions: typeof slackWebClientOptions = {
    ...slackSocketClientOptions,
    fetch: (url, init) => slackSocketClientOptions.fetch!(url, {
      ...init, signal: AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
    }),
  };
  const receiver = new SocketModeReceiver({
    appToken: config.slackAppToken, logger: ringLogger(), logLevel: LogLevel.INFO,
    autoReconnectEnabled: false,
    installerOptions: { clientOptions: socketClientOptions },
  });
  const app = new App({
    token: config.slackBotToken,
    receiver,
    socketMode: true,
    clientOptions,
    // Socket layer diagnostics (connect/disconnect/ping timeouts) go to \logs,
    // not an unwatched console — the first thing to check when inbound stops.
    logger: ringLogger(),
    logLevel: LogLevel.INFO,
  });
  cleanup.push(() => app.stop());

  // Outbound Slack calls go through the per-channel queue (see slack/render-deps.ts).
  let dmChannelId: string | null = null; // owner DM channel, opened post-auth
  let teamUrl: string | undefined; // for thread permalinks in DMs
  let botUserId = ""; // set after auth.test
  /** Hand-rolled thread permalink (null until the team URL is known), so a DM is one tap from context. */
  const permalink = (channel: string, threadTs: string) => teamUrl ? `${teamUrl}archives/${channel}/p${threadTs.replace(".", "")}` : null;
  const viewThread = (channel: string, threadTs: string) => teamUrl ? `\n<${permalink(channel, threadTs)}|view thread>` : "";
  const render = createRenderDeps(app, { isStopping: () => stopping, dmChannel: () => dmChannelId, viewThread });

  const pool = new ServerPool(
    (dir, eventType, props) => {
      void onPoolEvent(dir, eventType, props);
    },
    (msg) => {
      pushLog(msg);
      console.error(`  · ${msg}`);
    },
    // SSE recovered: events fired during the outage are lost — immediately
    // reconcile this server's runs from polled state instead of waiting for
    // the 60s sweep (RB2).
    (dir, gapMs) => {
      pushLog(`SSE resumed for ${dir} after ${Math.round(gapMs / 1000)}s — reconciling runs`);
      void interactions.sweepInteractions(dir).then(() => reconcileStaleViews(0, dir)).then((n) => {
        if (n) pushLog(`reconciler finalized ${n} stale run(s) for ${dir}`);
      }).catch(err => logErr(`resume recovery failed: ${String(err)}`));
    },
    // A server just became ready: sweep for parked questions that outlived a
    // bridge restart and re-post the asks for bound sessions (issue #2).
    (dir, baseUrl) => {
      void interactions.sweepQuestions(dir, baseUrl);
    },
    { onConnectionState: setProjectConnectionState, sessionDir: sid => state.findThreadBySession(sid)?.thread.projectDir },
  );
  cleanup.push(() => pool.close());

  // Stale-run reconciler (RB2): a run whose completion events were all lost
  // (SSE gap) receives no further signals and would hang at ⏳ forever. Every
  // minute, runs silent for 2 min are checked against the server — finalizing
  // ONLY those the server proves completed.
  const reconciler = setInterval(() => {
    void reconcileStaleViews(RECONCILE_STALE_MS).then((n) => {
      if (n) pushLog(`reconciler finalized ${n} stale run(s)`);
    });
  }, RECONCILE_INTERVAL_MS);
  reconciler.unref();
  cleanup.push(() => clearInterval(reconciler));

  const interactions = createInteractions({ app, config, state, pool, render, permissionStore, questionStore,
    isStopping: () => stopping, enabled: () => interactionsEnabled,
    dmChannel: () => dmChannelId, setDmChannel: id => { dmChannelId = id; },
    botUserId: () => botUserId, scheduledReports: () => scheduledReports, viewThread });
  cleanup.push(() => interactions.close());

  // Subagent lanes (A2): a view-less session whose ancestor has a view is a
  // subagent of that run. parentID lookups are cached; failures retry next event.
  const CHILD_EVENTS = new Set(["message.part.updated", "session.status", "session.idle", "session.error"]);
  const sessionInfo = new Map<string, Promise<{ parentID: string | null; title: string } | null>>();
  function lookupSession(dir: string, sid: string): Promise<{ parentID: string | null; title: string } | null> {
    let hit = sessionInfo.get(sid);
    if (hit) return hit;
    const client = pool.get(dir)?.client;
    if (!client) return Promise.resolve(null);
    if (sessionInfo.size > 500) sessionInfo.clear();
    // A fork may carry parentID too, but it is a sibling session, never a subagent lane.
    hit = sessionGet(client, sid).then(s => ({ parentID: s.fork ? null : s.parentID ?? null, title: s.title }), () => {
      sessionInfo.delete(sid);
      return null;
    });
    sessionInfo.set(sid, hit);
    return hit;
  }
  async function laneOwner(dir: string, sid: string): Promise<{ view: NonNullable<ReturnType<typeof getView>>; title: string } | null> {
    const own = await lookupSession(dir, sid);
    let parent = own?.parentID;
    // Grandchildren roll up into the nearest ancestor that has a view.
    for (let depth = 0; own && parent && depth < 4; depth++) {
      const view = getView(parent);
      if (view) return { view, title: own.title };
      parent = (await lookupSession(dir, parent))?.parentID;
    }
    return null;
  }

  async function onPoolEvent(dir: string, eventType: string, props: Record<string, unknown>): Promise<void> {
    try {
      if (stopping) return;
      const sessionId = props.sessionID as string | undefined;
      if (sessionId) dir = state.findThreadBySession(sessionId)?.thread.projectDir ?? dir;
      if (eventType === "message.updated" && props.info) {
        state.reconcilePromptAcceptance(dir, props.info as OcMessageInfo);
      }
      if (eventType === "permission.replied") {
        const id = String(props.requestID ?? props.permissionID ?? props.id ?? "");
        interactions.interactionChanged(dir);
        if (id) await interactions.onPermissionResolved(id, props.sessionID as string | undefined);
        return;
      }
      // V2Events already normalized the payload onto OcPermission.
      if (eventType === "permission.asked") {
        interactions.interactionChanged(dir);
        if (interactionsEnabled) await interactions.onPermission(props as unknown as OcPermission, false, dir);
        return;
      }
      // Question tool (issue #2): the server parks a blocking question and
      // emits question.asked. Intercepted here (like permissions) so it never
      // reaches the view's default: drop — the run would hang with no way to
      // answer. replied/rejected echoes resolve the posted copies idempotently.
      if (eventType === "question.asked") {
        interactions.interactionChanged(dir);
        if (interactionsEnabled) await interactions.onQuestion(props as unknown as OcQuestionRequest);
        return;
      }
      if (eventType === "question.replied" || eventType === "question.rejected") {
        const rid = (props.requestID as string | undefined) ?? (props.id as string | undefined);
        interactions.interactionChanged(dir);
        if (rid) await interactions.onQuestionResolved(rid, eventType === "question.rejected" ? "rejected" : "replied", props.sessionID as string | undefined);
        return;
      }
      const sid = (props.sessionID as string | undefined) ?? (props.part as { sessionID?: string } | undefined)?.sessionID ?? (props.info as { sessionID?: string } | undefined)?.sessionID;
      if (!sid) return;
      // Activity map BEFORE the view lookup: events for view-less sessions
      // (e.g. a session whose thread was rebound) are dropped below, but their
      // busy/idle transitions feed the picker's ▶ running marker.
      if (eventType === "session.status") {
        const st = (props.status as { type?: string } | undefined)?.type;
        if (st === "busy" || st === "retry") noteSessionActivity(sid, true);
        else if (st === "idle") noteSessionActivity(sid, false);
      } else if (eventType === "session.idle") {
        noteSessionActivity(sid, false);
      }
      const view = getView(sid);
      if (view) await view.handle({ type: eventType, properties: props as never });
      else if (CHILD_EVENTS.has(eventType)) {
        const lane = await laneOwner(dir, sid);
        if (lane) await lane.view.handleChild(sid, lane.title, { type: eventType, properties: props as never });
      }
    } catch (err) {
      logErr(`event handling error (${dir} ${eventType}): ${String((err as Error)?.message ?? err)}`);
    }
  }

  const botAuth = await app.client.auth.test().catch((err) => {
    console.error("Slack auth.test failed — check SLACK_BOT_TOKEN:", err);
    return null;
  });
  if (stopping) return;
  if (!botAuth) {
    await shutdown(1);
    return;
  }

  botUserId = botAuth.user_id as string;
  teamUrl = (botAuth as { url?: string }).url;

  // Owner DM channel — the remote pager (permission asks, failures, \notify
  // completions). If it can't be opened, everything degrades to thread-only.
  try {
    const r = (await app.client.conversations.open({ users: config.ownerSlackUserId })) as {
      channel?: { id?: string };
    };
    dmChannelId = r.channel?.id ?? null;
  } catch (err) {
    pushLog(`owner DM channel unavailable: ${String((err as Error)?.message ?? err)}`);
  }
  if (stopping) return;

  // A corrupt scheduler store disables only scheduled work, never ordinary
  // Slack conversations. All jobs use this bridge's existing authenticated pool.
  try {
    scheduledReports = createScheduledReports({ app, pool, state, statePath: STATE_PATH,
      owner: config.ownerSlackUserId, botUserId, ownerDm: () => dmChannelId,
      signal: lifetime.signal, stopping: () => stopping,
      onError: err => logErr(`scheduled reports: ${String((err as Error)?.message ?? err)}`) });
    cleanup.push(() => scheduledReports?.close());
  } catch (err) {
    logErr(`scheduled reports disabled: ${String((err as Error)?.message ?? err)}`);
  }

  const bridge: BridgeDeps = {
    schedules: scheduledReports?.commands,
    resumeQuestions: interactions.resumeQuestions,
    questions: interactions.questions,
    config,
    state,
    pool,
    render,
    botUserId,
    cwd: opts.cwd,
    isStopping: () => stopping,
    bridgeInfo: { startedAt: Date.now(), dmAvailable: () => dmChannelId !== null, socket: () => socketSupervisor?.health() },
    ownerDmChannel: () => dmChannelId,
    permissions: interactions.permissions,
    threadUrl: (key) => {
      const [channel, threadTs] = key.split(":");
      return channel && threadTs ? permalink(channel, threadTs) : null;
    },
  };

  // Ghost-connection witness: live socket deliveries vs catch-up replays
  // (see ghosts.ts — a second instance sharing the app token shows up here).
  const ghost = new GhostDetector();

  app.event("message", async ({ event }) => {
    if (stopping) return;
    const e = event as unknown as import("./slack/router.js").SlackMsg;
    pushLog(`in: message ${e.channel}:${e.ts}${e.thread_ts ? " (reply)" : ""}${e.subtype ? ` subtype=${e.subtype}` : ""}`);
    ghost.noteLive();
    if (shouldRouteMessage(e, (c) => state.isAlwaysOn(c))) {
      await handleIncomingMessage(e, bridge).catch((err) => console.error(err));
    }
  });
  app.event("app_mention", async ({ event }) => {
    if (stopping) return;
    const e = event as unknown as import("./slack/router.js").SlackMsg;
    pushLog(`in: app_mention ${e.channel}:${e.ts}`);
    ghost.noteLive();
    await handleIncomingMessage(e, bridge).catch((err) => console.error(err));
  });

  registerHome(app, { ownerSlackUserId: config.ownerSlackUserId, state, pool, permissions: permissionStore, questions: questionStore,
    reports: () => scheduledReports?.jobs() ?? [], threadUrl: bridge.threadUrl!, isStopping: () => stopping });
  registerShortcut(app, { bridge, ownerSlackUserId: config.ownerSlackUserId, dmChannel: () => dmChannelId, isStopping: () => stopping });
  registerPickerActions(app, { bridge, ownerSlackUserId: config.ownerSlackUserId, isStopping: () => stopping });
  registerModelSearch(app, { bridge, ownerSlackUserId: config.ownerSlackUserId });
  registerDiffActions(app, { ownerSlackUserId: config.ownerSlackUserId, state, pool, isStopping: () => stopping });
  registerRunControls(app, { ownerSlackUserId: config.ownerSlackUserId, state, pool, isStopping: () => stopping });

  // Fair, bounded history recovery for retained threads + \listen/DM top-level messages (slack/catchup-runner.ts).
  const runCatchup = createCatchupRunner(app, { state, pool, ownerSlackUserId: config.ownerSlackUserId, ghost,
    isStopping: () => stopping, dispatch: (m, context) => handleIncomingMessage(m, bridge, context),
    topLevelChannels: () => [...state.alwaysOnChannels(), ...(dmChannelId ? [dmChannelId] : [])] });
  const recovered = await recoverInterruptedRuns({ state, pool, render, isStopping: () => stopping });
  pushLog(`boot recovery: ${JSON.stringify(recovered)}`);
  interactionsEnabled = true;
  // Interactions are now safe to restore, and poll independently of catch-up scans.
  const interactionTimer = setInterval(() => { void interactions.refreshPermissions().catch(err => logErr(`interaction recovery: ${String(err)}`)); }, 30_000);
  interactionTimer.unref();
  cleanup.push(() => clearInterval(interactionTimer));
  // Only enable intake after cleaning the previous process's tombstones. A
  // fresh prompt delivered during app.start must never join the interrupt sweep.
  if (stopping) return;
  // The first websocket can close before Slack's hello (e.g. a pong timeout);
  // the library then rejects with `undefined`. Hand that to the supervisor's
  // retry loop instead of failing startup.
  let socketUp = true;
  try {
    await app.start();
  } catch (err) {
    socketUp = false;
    pushLog(`slack socket: initial connect failed (${String((err as Error)?.message ?? err ?? "closed before hello")}) — retrying`);
  }
  if (stopping) return;
  // Catch-up on reconnect comes from the supervisor's onRecovered alone (it also covers wake).
  const onConnected = () => {
    if (stopping) return;
    noteSlackOnline();
    void scheduledReports?.poll().catch(err => logErr(`scheduled report reconnect: ${String(err)}`));
    void interactions.refreshPermissions(true).catch(err => logErr(`interaction reconnect recovery: ${String(err)}`));
  };
  receiver.client.on("connected", onConnected);
  cleanup.push(() => { receiver.client.off("connected", onConnected); });
  socketSupervisor = new SocketSupervisor(receiver.client, {
    log: pushLog,
    onRecovered: () => { if (!stopping) void runCatchup(); },
    // Only a service manager can restart us; a foreground bridge keeps retrying.
    fatalAfterMs: process.env.SLACKOC_SERVICE === "bridge" ? SOCKET_FATAL_MS : Infinity,
    onFatal: () => { void shutdown(1); },
  });
  socketSupervisor.start(socketUp);
  // Stop supervising BEFORE app.stop() disconnects, or the disconnect would schedule a reconnect.
  cleanup.unshift(() => socketSupervisor?.stop());
  // Every tick requests recovery, including the first tick after sleep.
  // Slow passes coalesce; shared history pacing bounds request starts.
  const catchup = setInterval(() => {
    // While offline, every sweep would just fail N history calls (and log each).
    // The supervisor's reconnect runs a sweep the moment Slack is back.
    if (slackOffline() || socketSupervisor?.health().connected === false) return;
    void runCatchup();
  }, CATCHUP_INTERVAL_MS);
  catchup.unref();
  cleanup.push(() => clearInterval(catchup));
  const scheduleTimer = setInterval(() => {
    void scheduledReports?.poll().catch(err => logErr(`scheduled report poll: ${String(err)}`));
  }, 5_000);
  scheduleTimer.unref();
  cleanup.push(() => clearInterval(scheduleTimer));
  void scheduledReports?.poll().catch(err => logErr(`scheduled report startup: ${String(err)}`));
  void runCatchup(true);
  void interactions.refreshPermissions().catch(err => logErr(`interaction boot recovery: ${String(err)}`));

  // Kick the current project's server so the first prompt is snappy.
  void pool.ensure(state.currentProjectDir!).catch(() => {});
  // Explicit resumed forms can outlive a stopped prompt in another location.
  // Warm only their still-authorized bindings; this never submits a prompt.
  const questionDirs = new Set(questionStore.list().filter(r => r.response !== "resolved" && interactions.resumedQuestionEligible(r)).map(r => r.projectDir));
  for (const dir of questionDirs) if (dir !== state.currentProjectDir) void pool.ensure(dir).catch(err => pushLog(`question recovery location: ${String(err)}`));

  pushLog(`slackoc online as @${botAuth.user ?? "bot"} in ${botAuth.team ?? "workspace"}`);
  console.error(`✓ slackoc online as @${botAuth.user ?? "bot"} in ${botAuth.team ?? "workspace"}`);
  console.error(`  current project: ${state.currentProjectDir}`);
  console.error(`  config: ${CONFIG_PATH}`);
  } catch (err) {
    logErr(`bridge startup failed: ${String((err as Error)?.stack ?? err)}`);
    await shutdown(1);
  }
}

/** A damaged interaction store must not crash-loop the bridge under launchd.
 * Move it aside (kept for inspection) and start empty; OpenCode stays the
 * authority for pending permissions/questions, which are re-polled on boot. */
function openStore<T>(path: string, open: (path: string) => T): T {
  try {
    return open(path);
  } catch (err) {
    const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { renameSync(path, backup); } catch { /* best effort */ }
    logErr(`${path} unreadable (${String((err as Error)?.message ?? err)}) — moved to ${backup}; starting empty`);
    return open(path);
  }
}

function readPid(pidPath: string): number | null {
  return existsSync(pidPath) && !pidfilePredatesBoot(pidPath) ? parsePid(readFileSync(pidPath, "utf8")) : null;
}

/** Unlike pidAlive, EPERM counts as dead: `slackoc stop` then clears a pidfile whose pid was reused by another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type PidClaim = "claimed" | "running" | "starting";

const PARTIAL_PID_GRACE_MS = 30_000;

/** Publish a nonempty directory atomically: rename cannot replace another
 * nonempty directory. Remove only our unique marker, then rmdir (never recursive
 * rm), so late cleanup cannot remove a replacement owner's live lock.
 */
function lockPidfile(pidPath: string): (() => void) | null {
  const lock = `${pidPath}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const prepared = `${lock}.${owner}`;
  mkdirSync(prepared, { mode: 0o700 });
  const removeOwner = (name: string): void => {
    try { unlinkSync(`${lock}/${name}`); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try { rmdirSync(lock); }
    catch (err) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
  };
  try {
    writeFileSync(`${prepared}/${owner}`, "", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(prepared, lock);
        return () => removeOwner(owner);
      } catch (err) {
        if (!["ENOTEMPTY", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      }
      let entries: string[];
      try { entries = readdirSync(lock); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (!entries.length) continue; // an owner is finishing release
      const marker = entries.length === 1 ? entries[0]! : "";
      const match = /^(\d+)-[0-9a-f-]{36}$/.exec(marker);
      const pid = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(pid) || pid <= 1 || pidAlive(pid)) return null;
      removeOwner(marker);
    }
    return null;
  } finally {
    // This unpublished, uniquely named directory is exclusively ours.
    rmSync(prepared, { recursive: true, force: true });
  }
}

/**
 * Serialize inspection/replacement, then publish a fully written pid atomically.
 * A dead lock owner is recoverable; an in-progress owner or recent legacy partial
 * pidfile reports "starting". No contender ever unlinks the shared pidfile.
 */
export function claimPidfile(pidPath: string): PidClaim {
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
  const unlock = lockPidfile(pidPath);
  if (!unlock) return "starting";
  const temp = `${pidPath}.${process.pid}-${randomUUID()}.new`;
  try {
    try {
      const existing = parsePid(readFileSync(pidPath, "utf8"));
      if (existing !== null) {
        if (!pidfilePredatesBoot(pidPath) && pidAlive(existing)) return "running";
      } else if (Date.now() - statSync(pidPath).mtimeMs < PARTIAL_PID_GRACE_MS) {
        return "starting";
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    writeFileSync(temp, String(process.pid), { flag: "wx", mode: 0o600 });
    renameSync(temp, pidPath);
    return "claimed";
  } finally {
    try { rmSync(temp, { force: true }); }
    finally { unlock(); }
  }
}

export async function stopBridge(): Promise<void> {
  if (await stopManagedService()) return;
  const pid = readPid(PID_PATH);
  if (!pid || !processAlive(pid)) {
    console.log("slackoc is not running (no live pidfile).");
    rmSync(PID_PATH, { force: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`failed to stop pid ${pid}:`, err);
    process.exitCode = 1;
    return;
  }
  console.log(`sent SIGTERM to slackoc (pid ${pid}).`);
}