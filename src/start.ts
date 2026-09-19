import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { App, LogLevel, SocketModeReceiver, type RespondFn } from "@slack/bolt";
import { loadConfig, PID_PATH, CONFIG_PATH, STATE_PATH } from "./config.js";
import { StateStore } from "./state.js";
import { ServerPool } from "./opencode/server.js";
import { permRespond, sessionDiff, sessionMessages, pendingQuestions, pendingPermissions, questionReply, questionReject } from "./opencode/client.js";
import { noteSessionActivity } from "./commands/picker.js";
import {
  permissionBlocks,
  permissionResultText,
  questionBlocks,
  VIEW_DIFF_ACTION,
  type PermButtonValue,
} from "./slack/blocks.js";
import { handleIncomingMessage, type BridgeDeps, type SlackMsg } from "./slack/router.js";
import { buildUnifiedDiff, formatDiffSummary } from "./commands/handlers.js";
import { finalizeViewsForProject, getView, hasActiveViewForProject, reconcileStaleViews, setProjectConnectionState, describeActiveRuns, deleteView } from "./slack/render.js";
import type { RenderDeps } from "./slack/render.js";
import { sweepMissedMessages, type CatchupDeps } from "./slack/catchup.js";
import { GhostDetector } from "./ghosts.js";
import { enqueue } from "./slack/queue.js";
import { slackWebClientOptions, SLACK_UPLOAD_TIMEOUT_MS } from "./slack/transport.js";
import { boundedShutdown, startManagedRuntime, stopManagedService } from "./service.js";
import { enableFileLog, logErr, pushLog, ringLogger } from "./log.js";
import { normalizePermission, type OcPermission, type OcQuestionRequest, type OcMessageInfo } from "./opencode/api.js";

export interface StartOpts {
  cwd: string;
}

/** Idle servers are stopped after 30 min without SSE events; checked every 5 min. */
const IDLE_SERVER_TTL_MS = 30 * 60_000;
const REAPER_INTERVAL_MS = 5 * 60_000;
/** RB2: sweep for runs whose completion signals were lost (SSE gap) every minute; a run untouched for 2 min is checked. */
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_STALE_MS = 120_000;

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
  const onRejection = (err: unknown) => {
    logErr(`unhandled rejection: ${String((err as Error)?.stack ?? err).slice(0, 400)}`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  try {
  const state = new StateStore(STATE_PATH);
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
  const receiver = new SocketModeReceiver({
    appToken: config.slackAppToken, logger: ringLogger(), logLevel: LogLevel.INFO,
    installerOptions: { clientOptions },
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

  // All outbound Slack calls go through the per-channel, two-tier queue
  // (slack/queue.ts): ~1/s pacing per channel lane, interactive ops ahead of
  // background stream traffic, a shared 429 brake, and a per-op timeout so
  // one stalled call can never freeze its lane.
  let dmChannelId: string | null = null; // owner DM channel, opened post-auth
  let teamUrl: string | undefined; // for thread permalinks in DMs
  const render: RenderDeps = {
    post: async (channel, threadTs, text, blocks, opts) => {
      if (stopping) throw new Error("bridge stopping");
      const r = await enqueue(
        () =>
          app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text,
            mrkdwn: true,
            ...(blocks ? { blocks } : {}),
            // System chatter (tool lines, status, summaries) stays compact —
            // no big link preview cards. Answer text keeps previews (default).
            ...(opts?.unfurl === false ? { unfurl_links: false, unfurl_media: false } : {}),
          }),
        { channel, lane: opts?.lane },
      );
      return { ts: r.ts as string };
    },
    update: async (channel, ts, text) => {
      await enqueue(() => app.client.chat.update({ channel, ts, text }), { channel });
    },
    delete: async (channel, ts) => {
      await enqueue(() => app.client.chat.delete({ channel, ts }), { channel });
    },
    // Reactions don't order with messages, so they bypass the FIFO: the 👀
    // liveness ack and the ✅/❌ outcome land instantly instead of queueing
    // behind ticker beats (issue #3). Failures are caught by reactLogged's
    // warn-once wrapper at every call site.
    react: async (channel, ts, name) => {
      await app.client.reactions.add({ channel, timestamp: ts, name });
    },
    unreact: async (channel, ts, name) => {
      await app.client.reactions.remove({ channel, timestamp: ts, name });
    },
    upload: async ({ channelId, threadTs, filename, content, file, comment, lane }) => {
      await enqueue(
        () =>
          app.client.filesUploadV2({
            channel_id: channelId,
            thread_ts: threadTs,
            filename,
            ...(file ? { file } : { content: content ?? "" }),
            initial_comment: comment,
            title: filename,
          }),
        { channel: channelId, lane, timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false },
      );
    },
    dm: async (channel, threadTs, text, blocks, opts) => {
      if (!dmChannelId) throw new Error("owner DM channel unavailable");
      // Hand-rolled permalink to the thread, so a DM is one tap from context.
      const link = teamUrl ? `\n<${teamUrl}archives/${channel}/p${threadTs.replace(".", "")}|view thread>` : "";
      // With blocks present, `text` is only the notification fallback — graft
      // the link onto the first section so the RENDERED DM keeps it too.
      let outBlocks = blocks as Array<Record<string, unknown>> | undefined;
      if (outBlocks?.length && link) {
        outBlocks = outBlocks.map((b, i) =>
          i === 0 && b?.type === "section"
            ? { ...b, text: { ...(b.text as Record<string, unknown>), text: `${(b.text as { text?: string })?.text ?? ""}${link}` } }
            : b,
        );
      }
      const r = await enqueue(
        () =>
          app.client.chat.postMessage({
            channel: dmChannelId!,
            text: `${text}${link}`,
            mrkdwn: true,
            ...(outBlocks ? { blocks: outBlocks } : {}),
          }),
        { channel: dmChannelId!, lane: opts?.lane },
      );
      return { ts: r.ts as string };
    },
  };

  // Resolved IDs are tombstones for this bridge lifetime, not delivery dedup.
  // Keep them even after removing the live ask so old polls/replays cannot revive it.
  const resolvedPerms = new Set<string>();
  const resolvedQuestions = new Set<string>();
  const permNudges = new Map<string, NodeJS.Timeout>();
  const quesNudges = new Map<string, NodeJS.Timeout>();
  const interactionVersions = new Map<string, number>();
  const interactionSweeps = new Map<string, { flight: Promise<void>; requested: boolean }>();
  const interactionChanged = (dir: string): void => {
    interactionVersions.set(dir, (interactionVersions.get(dir) ?? 0) + 1);
  };

  const pool = new ServerPool(
    (dir, eventType, props) => {
      void onPoolEvent(dir, eventType, props);
    },
    (msg) => {
      pushLog(msg);
      console.error(`  · ${msg}`);
    },
    // A ready server crashed or was killed mid-run: its threads would hang at
    // ⏳ forever (the watchdog would lie every 3 min). Finalize them visibly —
    // finalize(err) also fires the failure-DM pager.
    (dir, code) => {
      pushLog(`opencode server for ${dir} died unexpectedly (code ${code}) — finalizing its threads`);
      void finalizeViewsForProject(
        dir,
        `:warning: opencode server exited unexpectedly (code ${code}) — \`\\restart\` to retry, then resend your prompt.`,
      );
    },
    // SSE recovered: events fired during the outage are lost — immediately
    // reconcile this server's runs from polled state instead of waiting for
    // the 60s sweep (RB2).
    (dir, gapMs) => {
      pushLog(`SSE resumed for ${dir} after ${Math.round(gapMs / 1000)}s — reconciling runs`);
      void sweepInteractions(dir).then(() => reconcileStaleViews(0, dir)).then((n) => {
        if (n) pushLog(`reconciler finalized ${n} stale run(s) for ${dir}`);
      }).catch(err => logErr(`resume recovery failed: ${String(err)}`));
    },
    // A server just became ready: sweep for parked questions that outlived a
    // bridge restart and re-post the asks for bound sessions (issue #2).
    (dir, baseUrl) => {
      void sweepQuestions(dir, baseUrl);
    },
    { isBusy: hasActiveViewForProject, onConnectionState: setProjectConnectionState },
  );
  cleanup.push(() => pool.close());

  // Idle-server reaper: an untouched opencode serve stays resident forever on
  // an always-on box. Stop servers idle >30 min with no active views; they
  // respawn lazily on demand. unref'd so it never keeps the process alive.
  const reaper = setInterval(() => {
    const n = pool.reapIdle(IDLE_SERVER_TTL_MS, hasActiveViewForProject);
    if (n) pushLog(`idle reaper: stopped ${n} idle opencode server(s)`);
  }, REAPER_INTERVAL_MS);
  reaper.unref();
  cleanup.push(() => clearInterval(reaper));

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

  type Delivery = { status: "new" | "in-flight" | "delivered" | "rejected" | "uncertain"; attempts: number };
  type InteractionAsk = {
    id: string;
    sessionId: string;
    projectDir: string;
    channel: string;
    threadTs: string;
    askTs: string | null;
    dmTs: string | null;
    threadDelivery: Delivery;
    dmDelivery: Delivery;
    deliveryFlight?: Promise<void>;
    resolvedText?: string;
    nudgeStarted: boolean;
  };
  type PermissionAsk = InteractionAsk & { perm: OcPermission };
  const permAsks = new Map<string, PermissionAsk>();
  cleanup.push(() => {
    for (const t of permNudges.values()) clearTimeout(t);
    for (const t of quesNudges.values()) clearTimeout(t);
  });

   /**
    * Live question asks. `req` is the full stored ask (options resolved from
    * here, not from the button value); `answers` accumulates one label-array
    * per question; `finalized` marks which questions are locked in (a
    * multi-select's toggles don't count until submitted). When every question
    * is finalized, we reply.
    */
   type QuestionAsk = InteractionAsk & {
     req: OcQuestionRequest;
     answers: string[][];
     finalized: boolean[];
   };
   const quesAsks = new Map<string, QuestionAsk>();

  async function onPoolEvent(dir: string, eventType: string, props: Record<string, unknown>): Promise<void> {
    try {
      if (stopping) return;
      if (eventType === "message.updated" && props.info) {
        state.reconcilePromptAcceptance(dir, props.info as OcMessageInfo);
      }
      if (eventType === "permission.replied") {
        const id = String(props.requestID ?? props.permissionID ?? props.id ?? "");
        interactionChanged(dir);
        if (id) await onPermissionResolved(id, props.sessionID as string | undefined);
        return;
      }
      // Both event names: ≤1.18.25 emits permission.updated, ≥1.18.2x emits
      // permission.asked (auto-update renamed it). The adapter normalizes the
      // differing payloads onto one OcPermission the rest of the flow consumes.
      if (eventType === "permission.updated" || eventType === "permission.asked") {
        interactionChanged(dir);
        await onPermission(normalizePermission(props));
        return;
      }
      // Question tool (issue #2): the server parks a blocking question and
      // emits question.asked. Intercepted here (like permissions) so it never
      // reaches the view's default: drop — the run would hang with no way to
      // answer. replied/rejected echoes resolve the posted copies idempotently.
      if (eventType === "question.asked") {
        interactionChanged(dir);
        await onQuestion(props as unknown as OcQuestionRequest);
        return;
      }
      if (eventType === "question.replied" || eventType === "question.rejected") {
        const rid = (props.requestID as string | undefined) ?? (props.id as string | undefined);
        interactionChanged(dir);
        if (rid) await onQuestionResolved(rid, eventType === "question.rejected" ? "rejected" : "replied", props.sessionID as string | undefined);
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
    } catch (err) {
      logErr(`event handling error (${dir} ${eventType}): ${String((err as Error)?.message ?? err)}`);
    }
  }

  type InteractionKind = "permission" | "question";
  function newAsk(id: string, sessionId: string): InteractionAsk | undefined {
    const bound = state.findThreadBySession(sessionId);
    // Do not dedupe an unbound boot ask: a later binding/poll may recover it.
    if (!bound) return;
    const [channel, threadTs] = bound.key.split(":") as [string, string];
    return { id, sessionId, projectDir: bound.thread.projectDir, channel, threadTs,
      askTs: null, dmTs: null, nudgeStarted: false,
      threadDelivery: { status: "new", attempts: 0 }, dmDelivery: { status: "new", attempts: 0 } };
  }

  function isPending(ask: InteractionAsk, kind: InteractionKind): boolean {
    return !stopping && !ask.resolvedText &&
      (kind === "question" ? quesAsks.get(ask.id) : permAsks.get(ask.id)) === ask;
  }

  // Only explicit rejection proves a post had no effect. Transport timeouts,
  // connection errors, HTTP 5xx, and internal Slack errors retain uncertainty.
  function rejectedPost(err: unknown): boolean {
    const e = err as { code?: string; statusCode?: number; data?: { error?: string } };
    if (e?.code === "slack_webapi_rate_limited_error" || e?.statusCode === 429) return true;
    return e?.code === "slack_webapi_platform_error" && new Set([
      "missing_scope", "invalid_auth", "token_revoked", "token_expired", "account_inactive",
      "channel_not_found", "not_in_channel", "is_archived", "no_permission", "restricted_action",
      "msg_too_long", "invalid_blocks", "invalid_arguments", "no_text",
    ]).has(e.data?.error ?? "");
  }

  async function collapseCopy(channel: string, ts: string, text: string): Promise<void> {
    if (stopping) return;
    await enqueue(async () => {
      if (!stopping) await app.client.chat.update({ channel, ts, text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
    }, { channel, lane: "interactive" }).catch(err => pushLog(`interaction update failed: ${String(err)}`));
  }

  function armInteractionNudge(ask: InteractionAsk, kind: InteractionKind): void {
    if (!isPending(ask, kind) || ask.nudgeStarted || (!ask.askTs && !ask.dmTs)) return;
    ask.nudgeStarted = true;
    const nudges = kind === "question" ? quesNudges : permNudges;
    const nudge = (remaining: number): void => {
      if (!isPending(ask, kind)) return;
      const timer = setTimeout(() => {
        nudges.delete(ask.id);
        if (!isPending(ask, kind)) return;
        const where = ask.askTs ? "above" : "in your DM";
        const action = kind === "question" ? "pick an option or Skip" : "Approve or Deny";
        void enqueue(async () => {
          if (!isPending(ask, kind)) return; // It may resolve/stop while queued.
          await app.client.chat.postMessage({ channel: ask.channel, thread_ts: ask.threadTs,
            text: `:alarm_clock: Still waiting on this ${kind} — ${action} ${where}.`,
            mrkdwn: true, unfurl_links: false, unfurl_media: false });
        }, { channel: ask.channel }).catch(() => {});
        if (remaining > 0) nudge(remaining - 1);
      }, 180_000);
      timer.unref();
      nudges.set(ask.id, timer);
    };
    nudge(1);
  }

  function deliverAsk(ask: InteractionAsk, kind: InteractionKind, header: string,
    blocks: () => unknown[], retry: boolean): Promise<void> {
    if (ask.deliveryFlight) return ask.deliveryFlight;
    ask.deliveryFlight = Promise.resolve().then(async () => {
      for (const destination of ["thread", "dm"] as const) {
        if (!isPending(ask, kind)) break;
        // A boot ask can precede DM availability; this is known not to have sent.
        if (destination === "dm" && !dmChannelId) continue;
        const delivery = destination === "thread" ? ask.threadDelivery : ask.dmDelivery;
        if (delivery.status !== "new" && !(retry && delivery.status === "rejected" && delivery.attempts < 3)) continue;
        delivery.status = "in-flight";
        delivery.attempts++;
        const postedBlocks = blocks();
        let ts: string;
        try {
          const result = destination === "thread"
            ? await render.post(ask.channel, ask.threadTs, header, postedBlocks, { unfurl: false, lane: "interactive" })
            : await render.dm!(ask.channel, ask.threadTs, header, postedBlocks, { lane: "interactive" });
          ts = result.ts;
          delivery.status = "delivered";
          if (destination === "thread") ask.askTs = ts; else ask.dmTs = ts;
        } catch (err) {
          delivery.status = rejectedPost(err) ? "rejected" : "uncertain";
          pushLog(`${kind} ${destination} delivery ${delivery.status} (${ask.id}): ${String(err)}`);
          continue;
        }
        if (stopping) break;
        const channel = destination === "thread" ? ask.channel : dmChannelId!;
        // Resolution can precede a post response. Collapse that late copy too,
        // without re-registering the ask or recreating its nudge.
        if (ask.resolvedText) await collapseCopy(channel, ts, ask.resolvedText);
        else if (isPending(ask, kind)) {
          if (destination === "thread") getView(ask.sessionId)?.contentPosted();
          // Partial multi-select/custom answers may change while the DM posts.
          if (JSON.stringify(postedBlocks) !== JSON.stringify(blocks())) {
            await enqueue(async () => {
              if (isPending(ask, kind)) await app.client.chat.update({ channel, ts, text: header, blocks: blocks() as never });
            }, { channel, lane: "interactive" }).catch(() => {});
          }
        }
      }
      armInteractionNudge(ask, kind);
    }).finally(() => { ask.deliveryFlight = undefined; });
    return ask.deliveryFlight;
  }

  async function onPermission(perm: OcPermission, retry = false): Promise<void> {
    if (stopping || !perm?.id || resolvedPerms.has(perm.id)) return;
    let ask = permAsks.get(perm.id);
    if (!ask) {
      const base = newAsk(perm.id, perm.sessionID);
      if (!base) return;
      ask = { ...base, perm };
      permAsks.set(perm.id, ask);
      interactionChanged(ask.projectDir);
    }
    getView(ask.sessionId)?.setWaiting(perm.id, "permission", true);
    await deliverAsk(ask, "permission", `:rotating_light: *OpenCode wants permission* — ${perm.type}:${perm.title}`,
      () => permissionBlocks(perm), retry);
  }

  async function onQuestion(req: OcQuestionRequest, retry = false): Promise<void> {
    if (stopping || !req?.id || resolvedQuestions.has(req.id)) return;
    let ask = quesAsks.get(req.id);
    if (!ask) {
      const base = newAsk(req.id, req.sessionID);
      if (!base) return;
      ask = { ...base, req, answers: req.questions.map(() => []), finalized: req.questions.map(() => false) };
      quesAsks.set(req.id, ask); // Buttons are usable BEFORE either post awaits.
      interactionChanged(ask.projectDir);
    }
    const pending = ask;
    getView(ask.sessionId)?.setWaiting(req.id, "question", true);
    await deliverAsk(ask, "question", `❓ *OpenCode has a question* — ${req.questions.length} to answer`,
      () => questionBlocks(pending.req, pending.answers, pending.finalized), retry);
  }

  async function resolveInteraction(kind: InteractionKind, id: string, text: string,
    sessionId?: string, knownAsk?: InteractionAsk): Promise<void> {
    const asks = kind === "question" ? quesAsks : permAsks;
    const resolved = kind === "question" ? resolvedQuestions : resolvedPerms;
    const nudges = kind === "question" ? quesNudges : permNudges;
    const ask = asks.get(id) ?? knownAsk;
    resolved.add(id);
    if (ask) ask.resolvedText = text;
    asks.delete(id);
    const timer = nudges.get(id);
    if (timer) clearTimeout(timer);
    nudges.delete(id);
    const sid = ask?.sessionId ?? sessionId;
    if (sid) getView(sid)?.setWaiting(id, kind, false);
    const dir = ask?.projectDir ?? (sid ? state.findThreadBySession(sid)?.thread.projectDir : undefined);
    if (dir) interactionChanged(dir);
    const updates: Promise<void>[] = [];
    if (ask?.askTs) updates.push(collapseCopy(ask.channel, ask.askTs, text));
    if (ask?.dmTs && dmChannelId) updates.push(collapseCopy(dmChannelId, ask.dmTs, text));
    await Promise.all(updates);
  }

  function onQuestionResolved(id: string, kind: "replied" | "rejected", sessionId?: string): Promise<void> {
    return resolveInteraction("question", id, kind === "rejected"
      ? ":arrow_forward: Skipped — OpenCode continuing."
      : ":white_check_mark: Answered — OpenCode continuing.", sessionId);
  }

  function onPermissionResolved(id: string, sessionId?: string,
    text = ":white_check_mark: Permission resolved — OpenCode continuing.", knownAsk?: PermissionAsk): Promise<void> {
    return resolveInteraction("permission", id, text, sessionId, knownAsk);
  }

  // Keep the onReady hook's signature; boot, resume, and periodic recovery all
  // share the same identity-checked, per-directory flight (including permissions).
  async function sweepQuestions(dir: string, baseUrl: string): Promise<void> {
    if (pool.get(dir)?.baseUrl === baseUrl) await sweepInteractions(dir);
  }

  function sweepInteractions(dir: string): Promise<void> {
    const entry = pool.get(dir);
    if (!entry?.baseUrl || stopping) return Promise.resolve();
    const key = entry.dir;
    const existing = interactionSweeps.get(key);
    if (existing) { existing.requested = true; return existing.flight; }
    const sweep = { requested: false, flight: null as unknown as Promise<void> };
    sweep.flight = Promise.resolve().then(async () => {
      do {
        sweep.requested = false;
        const current = pool.get(key);
        if (!current?.baseUrl || stopping) return;
        const version = interactionVersions.get(key) ?? 0;
        const [questions, permissions] = await Promise.allSettled([
          pendingQuestions(current.baseUrl), pendingPermissions(current.baseUrl),
        ]);
        if (stopping || pool.get(key) !== current || (interactionVersions.get(key) ?? 0) !== version) continue;
        // Apply all local changes without yielding; delivery promises finish
        // afterward and check ask identity/resolution before adopting late work.
        const work: Promise<void>[] = [];
        if (questions.status === "fulfilled") {
          const ids = new Set(questions.value.map(q => q.id));
          for (const [id, ask] of quesAsks) if (ask.projectDir === key && !ids.has(id)) work.push(onQuestionResolved(id, "replied"));
          for (const q of questions.value) work.push(onQuestion(q, true));
        } else pushLog(`question sweep failed for ${key}: ${String(questions.reason)}`);
        if (permissions.status === "fulfilled") {
          const ids = new Set(permissions.value.map(p => p.id));
          for (const [id, ask] of permAsks) if (ask.projectDir === key && !ids.has(id)) work.push(onPermissionResolved(id));
          for (const p of permissions.value) work.push(onPermission(p, true));
        } else pushLog(`permission sweep failed for ${key}: ${String(permissions.reason)}`);
        await Promise.all(work);
      } while (sweep.requested && !stopping);
    }).catch(err => logErr(`interaction sweep failed for ${key}: ${String(err)}`))
      .finally(() => { if (interactionSweeps.get(key) === sweep) interactionSweeps.delete(key); });
    interactionSweeps.set(key, sweep);
    return sweep.flight;
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

  const botUserId = botAuth.user_id as string;
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

  const bridge: BridgeDeps = {
    config,
    state,
    pool,
    render,
    botUserId,
    cwd: opts.cwd,
    isStopping: () => stopping,
    bridgeInfo: { startedAt: Date.now(), dmAvailable: () => dmChannelId !== null },
    threadUrl: (key) => {
      const [channel, threadTs] = key.split(":");
      if (!teamUrl || !channel || !threadTs) return null;
      return `${teamUrl}archives/${channel}/p${threadTs.replace(".", "")}`;
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
    if (e.channel_type === "im") {
      await handleIncomingMessage(e, bridge).catch((err) => console.error(err));
      return;
    }
    // Channels/groups: any THREAD reply gets routed — threads born from a bare
    // command (e.g. \help, \model) have no session binding yet, but later
    // non-command messages there should still prompt OpenCode (a fresh session
    // is created on demand). Owner-only gating happens inside the router.
    if (e.thread_ts) {
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

  app.action("perm", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (stopping) return;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can approve OpenCode actions.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const raw = (action as { value?: string }).value;
    if (!raw) return;
    let v: PermButtonValue;
    try {
      v = JSON.parse(raw) as PermButtonValue;
    } catch {
      return;
    }
    const bound = state.findThreadBySession(v.s);
    if (!bound) {
      await respond({ text: "That session is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    if (stopping || resolvedPerms.has(v.p)) return;
    const ask = permAsks.get(v.p);
    const entry = await pool.ensure(bound.thread.projectDir);
    if (stopping || resolvedPerms.has(v.p)) return;
    try {
      await permRespond(entry.client!, v.s, v.p, v.r);
    } catch (err) {
      logErr(`permission respond failed: ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Failed to reply to OpenCode: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
      return;
    }
    // Update BOTH copies of the ask (thread + owner DM) to the result, no
    // matter which button was tapped. Fall back to the clicked message when
    // the ask wasn't tracked (bridge restarted between ask and answer).
    const result = permissionResultText(v.r, body.user.id);
    await onPermissionResolved(v.p, v.s, result, ask);
    if (!ask?.askTs && !ask?.dmTs) {
      const ch = (body as unknown as { channel?: { id: string } }).channel?.id;
      const ts =
        (body as unknown as { container?: { message_ts?: string } }).container?.message_ts ??
        (body as unknown as { message?: { ts?: string } }).message?.ts;
      if (ch && ts) await collapseCopy(ch, ts, result);
    }
  });

  // Question tool (issue #2): owner taps an option (single-select, one tap per
  // question) or Skip. Labels are resolved from the stored ask, so the button
  // value stays tiny. When every question is answered we send the full matrix;
  // the SSE question.replied/rejected echo then collapses both copies too.
  // Re-render BOTH copies (thread + owner DM) of a live ask with fresh blocks.
  const renderAskBoth = (
    ask: { channel: string; askTs: string | null; dmTs: string | null },
    blocks: unknown[],
  ): Promise<unknown>[] => {
    const one = (ch: string, ts: string) =>
      app.client.chat.update({ channel: ch, ts, text: "OpenCode question", blocks: blocks as never }).catch(() => {});
    const u: Promise<unknown>[] = [];
    if (ask.askTs) u.push(one(ask.channel, ask.askTs));
    if (ask.dmTs && dmChannelId) u.push(one(dmChannelId, ask.dmTs));
    return u;
  };

  // If every question is finalized, send the answer matrix and resolve the ask;
  // otherwise re-render both copies. "failed" = the reply errored (re-rendered
  // so the owner can retry or Skip) — the caller surfaces the ephemeral notice.
  const submitAskIfComplete = async (ask: QuestionAsk, url: string): Promise<"replied" | "incomplete" | "failed"> => {
    if (!isPending(ask, "question")) return "incomplete";
    if (!ask.req.questions.every((_, qi) => ask.finalized[qi])) {
      await Promise.all(renderAskBoth(ask, questionBlocks(ask.req, ask.answers, ask.finalized)));
      return "incomplete";
    }
    try {
      await questionReply(url, ask.req.id, ask.answers);
    } catch (err) {
      logErr(`question reply failed: ${String((err as Error)?.message ?? err)}`);
      if (isPending(ask, "question")) await Promise.all(renderAskBoth(ask, questionBlocks(ask.req, ask.answers, ask.finalized)));
      return "failed";
    }
    await onQuestionResolved(ask.req.id, "replied");
    return "replied";
  };

  // Shared owner/bound/ask/entry guard for the question action handlers.
  const questionGuard = async (
    body: { user: { id: string } },
    raw: string | undefined,
    respond: RespondFn,
  ): Promise<{ v: { s: string; q: string; i: number; a?: number }; ask: QuestionAsk; url: string } | null> => {
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can answer OpenCode questions.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    if (!raw) return null;
    let parsed: { s: string; q: string; i: number; a?: number };
    try {
      parsed = JSON.parse(raw) as { s: string; q: string; i: number; a?: number };
    } catch {
      return null;
    }
    const bound = state.findThreadBySession(parsed.s);
    if (!bound) {
      await respond({ text: "That session is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    const ask = quesAsks.get(parsed.q);
    if (!ask || ask.sessionId !== parsed.s || !isPending(ask, "question")) {
      await respond({ text: "That question is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    const entry = await pool.ensure(bound.thread.projectDir);
    if (!isPending(ask, "question")) return null;
    if (!entry.url) {
      await respond({ text: "The OpenCode server isn't ready yet — try again in a moment.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    return { v: parsed, ask, url: entry.url };
  };

  app.action("question", async ({ ack, body, action, respond }) => {
    await ack();
    if (stopping) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const { v, ask, url } = g;

    if (v.a === -1) {
      // Skip (reject): unblock the run, collapse both copies to a final line.
      try {
        await questionReject(url, v.q);
      } catch (err) {
        logErr(`question reject failed: ${String((err as Error)?.message ?? err)}`);
        await respond({ text: `Failed to skip the question: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
        return;
      }
      await onQuestionResolved(v.q, "rejected");
      return;
    }

    const q = ask.req.questions[v.i!];
    const label = q?.options[v.a!]?.label;
    if (!q || label == null) return;

    if (q.multiple) {
      // Multi-select: toggle this option in/out; "Submit selection" finalizes.
      const cur = ask.answers[v.i!]!;
      const idx = cur.indexOf(label);
      if (idx >= 0) cur.splice(idx, 1);
      else cur.push(label);
      await Promise.all(renderAskBoth(ask, questionBlocks(ask.req, ask.answers, ask.finalized)));
      return;
    }

    // Single-select: one tap locks the answer, then submit-if-complete.
    ask.answers[v.i!] = [label];
    ask.finalized[v.i!] = true;
    const r = await submitAskIfComplete(ask, url);
    if (r === "failed") {
      await respond({ text: "Failed to send your answer — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
    }
  });

  app.action("qsubmit", async ({ ack, body, action, respond }) => {
    await ack();
    if (stopping) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const { v, ask, url } = g;
    if (!ask.answers[v.i!]?.length) {
      await respond({ text: "Pick at least one option before submitting.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    ask.finalized[v.i!] = true;
    const r = await submitAskIfComplete(ask, url);
    if (r === "failed") {
      await respond({ text: "Failed to send your answer — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
    }
  });

  app.action("qtext", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (stopping) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const { v, ask } = g;
    const q = ask.req.questions[v.i!];
    if (!q) return;
    // Open a modal; the answer comes back through the qtext_submit view.
    // (trigger_id lives on the BlockAction body, not the DialogSubmit variant.)
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;
    await client.views
      .open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "qtext_submit",
          title: { type: "plain_text", text: q.header },
          blocks: [
            {
              type: "input",
              block_id: "qtext_input",
              label: { type: "plain_text", text: q.question },
              optional: false,
              element: {
                type: "plain_text_input",
                action_id: "qtext_field",
                placeholder: { type: "plain_text", text: "Type your answer…" },
              },
            },
          ],
          private_metadata: JSON.stringify({ s: v.s, q: v.q, i: v.i }),
        },
      })
      .catch((err) => logErr(`question modal failed: ${String((err as Error)?.message ?? err)}`));
  });

  app.view("qtext_submit", async ({ ack, body, view, respond }) => {
    await ack();
    if (stopping) return;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can answer OpenCode questions.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    let v: { s: string; q: string; i: number };
    try {
      v = JSON.parse(view.private_metadata ?? "") as { s: string; q: string; i: number };
    } catch {
      return;
    }
    const text = String(view.state?.values?.qtext_input?.qtext_field?.value ?? "").trim();
    if (!text) {
      await respond({ text: "Answer can't be empty.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const bound = state.findThreadBySession(v.s);
    const ask = quesAsks.get(v.q);
    if (!bound || !ask || ask.sessionId !== v.s || !isPending(ask, "question")) return;
    const entry = await pool.ensure(bound.thread.projectDir);
    if (!entry.url || !isPending(ask, "question")) return;
    ask.answers[v.i] = [text];
    ask.finalized[v.i] = true;
    const r = await submitAskIfComplete(ask, entry.url);
    if (r === "failed") {
      await respond({ text: "Failed to send your answer — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
    }
  });

  // RF1: "📄 View diff" button on completion DMs → post the session's diff
  // (same rendering rules as \diff full: stat lines, inline diff ≤3.5k, else a
  // .diff snippet upload to the DM).
  app.action(VIEW_DIFF_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    if (stopping) return;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can view diffs here.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const sessionId = (action as { value?: string }).value;
    if (!sessionId) return;
    const bound = state.findThreadBySession(sessionId);
    if (!bound) {
      await respond({ text: "That session is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    if (!dmChannelId) return;
    try {
      const entry = await pool.ensure(bound.thread.projectDir);
      const diffs = await sessionDiff(entry.client!, sessionId);
      if (!diffs.length) {
        // Interactive: the owner just tapped the button and is waiting.
        await enqueue(() => app.client.chat.postMessage({ channel: dmChannelId!, text: "(no tracked edits in that session)" }), {
          channel: dmChannelId!,
          lane: "interactive",
        });
        return;
      }
      const body2 = buildUnifiedDiff(diffs);
      const summary = formatDiffSummary(diffs);
      await enqueue(
        () =>
          app.client.chat.postMessage({
            channel: dmChannelId!,
            text: body2 && body2.length <= 3500 ? `${summary}\n\`\`\`diff\n${body2}\n\`\`\`` : summary,
          }),
        { channel: dmChannelId!, lane: "interactive" },
      );
      if (body2 && body2.length > 3500) {
        await enqueue(
          () =>
            app.client.filesUploadV2({
              channel_id: dmChannelId!,
              filename: `session-${sessionId.slice(4, 14)}.diff`,
              content: body2.slice(0, 200_000),
              title: "session diff",
            }),
          { channel: dmChannelId!, lane: "interactive", timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false },
        );
      }
    } catch (err) {
      logErr(`view_diff action failed (${sessionId}): ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Couldn't fetch the diff: ${String((err as Error)?.message ?? err).slice(0, 200)}`, response_type: "ephemeral" }).catch(() => {});
    }
  });

  // Fair, bounded history recovery for retained threads. Older threads rotate
  // more slowly; a confirmed cursor is distinct from the newest live event.
  const catchupDeps: CatchupDeps = {
    state,
    ownerSlackUserId: config.ownerSlackUserId,
    fetchReplies: async (channel, rootTs, oldest, { maxPages }) => {
      const out: SlackMsg[] = [];
      let cursor: string | undefined;
      let pagesUsed = 0;
      do {
        // Background: the 60s sweep can fan out across ~10 threads — it must
        // never hold up commands/prompts in their channels (issue #5).
        const r = (await enqueue(
          () => app.client.conversations.replies({ channel, ts: rootTs, oldest, inclusive: false, limit: 100, ...(cursor ? { cursor } : {}) }),
          { channel, lane: "background" },
        )) as { messages?: unknown[]; response_metadata?: { next_cursor?: string } };
        out.push(...((r.messages ?? []) as SlackMsg[]));
        pagesUsed++;
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor && pagesUsed < maxPages && !stopping);
      return { messages: out.sort((a, b) => a.ts.localeCompare(b.ts)), hasMore: !!cursor, pagesUsed };
    },
    dispatch: (m) => stopping ? Promise.resolve("retry" as const) : handleIncomingMessage(m, bridge),
  };
  let catchupFlight: Promise<void> | undefined;
  let catchupRequested = false;
  let receiptOffset = 0;
  const runCatchup = (boot = false): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (catchupFlight) { catchupRequested = true; return catchupFlight; }
    catchupFlight = (async () => {
    do {
    catchupRequested = false;
    try {
      // Exact user-message IDs prove acceptance after an HTTP timeout or crash.
      // Check the stored session, which may differ from the thread's new binding.
      const pending = state.messageReceipts().filter(r => r.disposition === "uncertain" && r.submission);
      const groups = [...new Map(pending.map(r => [r.submission!.sessionId, r.submission!])).values()];
      for (let i = 0; i < Math.min(groups.length, 4) && !stopping; i++) {
        const ref = groups[(receiptOffset + i) % groups.length]!;
        try {
          const lease = await pool.acquire(ref.projectDir);
          try {
            for (const m of await sessionMessages(lease.entry.client!, ref.sessionId)) {
              state.reconcilePromptAcceptance(ref.projectDir, m.info);
            }
          } finally { lease.release(); }
        } catch (err) { pushLog(`acceptance recovery (${ref.sessionId}): ${String(err)}`); }
      }
      if (groups.length) receiptOffset = (receiptOffset + 4) % groups.length;
      await Promise.all(pool.list().filter(e => e.status === "ready").map(e => sweepInteractions(e.dir)));
      if (stopping) return;
      const n = await sweepMissedMessages(catchupDeps);
      if (n && !boot) ghost.noteReplayed(n); // boot pass replays are the restart gap, not a ghost
      const warn = ghost.check();
      if (warn) logErr(warn);
    } catch (err) {
      logErr(`catch-up sweep failed: ${String((err as Error)?.message ?? err)}`);
    }
    } while (catchupRequested && !stopping);
    })().finally(() => { catchupFlight = undefined; });
    return catchupFlight;
  };
  // Interrupt sweep: any thread with a pendingRun tombstone was mid-run when
  // the bridge last stopped (crash / slackoc stop / host reboot). Resolve the
  // orphaned ⏳/✅ lifecycle so users aren't staring at a frozen status.
  const interrupted = state.threadsWithPendingRun();
  if (interrupted.length) {
    pushLog(`interrupt sweep: ${interrupted.length} thread(s) had a run in flight at shutdown`);
    for (const { key, thread } of interrupted) {
      if (stopping) return;
      const [channel, threadTs] = key.split(":") as [string, string];
      const pr = thread.pendingRun!;
      for (const ts of pr.userMsgTs) {
        // The 👀 from dispatch belongs to the dead instance's view — sweep it
        // too so no message is left with a stale "seen but never resolved".
        await render.unreact(channel, ts, "eyes").catch(() => {});
        await render.react(channel, ts, "x").catch(() => {});
      }
      if (pr.statusTs) await render.delete(channel, pr.statusTs).catch(() => {});
      await render
        .post(
          channel,
          threadTs,
          "⚠️ Bridge restarted during this run. Check the session before resending: OpenCode may have accepted the prompt before the interruption.",
          undefined,
          // Interactive: the owner needs this notice NOW, not behind a backlog.
          { unfurl: false, lane: "interactive" },
        )
        .catch(() => {});
      state.clearPendingRun(key);
    }
  }

  // Boot catch-up pass: pick up anything sent while the bridge was down.
  // One-time watermark migration first (threads bound before catch-up existed):
  // without it the pass would skip them forever — and it must run BEFORE the
  // pass so freshly seeded threads are swept on this very boot.
  const seeded = state.seedMissingWatermarks();
  if (seeded) pushLog(`catch-up: seeded watermarks for ${seeded} legacy thread(s)`);
  // Only enable intake after cleaning the previous process's tombstones. A
  // fresh prompt delivered during app.start must never join the interrupt sweep.
  if (stopping) return;
  await app.start();
  if (stopping) return;
  const onConnected = () => { if (!stopping) void runCatchup(); };
  receiver.client.on("connected", onConnected);
  cleanup.push(() => { receiver.client.off("connected", onConnected); });
  // A sleep gap gets an immediate pass rather than waiting a fresh minute.
  let lastBeat = Date.now();
  let lastSweep = lastBeat;
  const catchup = setInterval(() => {
    const now = Date.now();
    if (now - lastBeat > 30_000 || now - lastSweep >= 60_000) {
      lastSweep = now;
      void runCatchup();
    }
    lastBeat = now;
  }, 10_000);
  catchup.unref();
  cleanup.push(() => clearInterval(catchup));
  void runCatchup(true);

  // Kick the current project's server so the first prompt is snappy.
  void pool.ensure(state.currentProjectDir!).catch(() => {});

  pushLog(`slackoc online as @${botAuth.user ?? "bot"} in ${botAuth.team ?? "workspace"}`);
  console.error(`✓ slackoc online as @${botAuth.user ?? "bot"} in ${botAuth.team ?? "workspace"}`);
  console.error(`  current project: ${state.currentProjectDir}`);
  console.error(`  config: ${CONFIG_PATH}`);
  } catch (err) {
    logErr(`bridge startup failed: ${String((err as Error)?.stack ?? err)}`);
    await shutdown(1);
  }
}

function readPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  return Number.isInteger(pid) ? pid : null;
}

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

function pidClaimOwnerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    // EPERM (or an unexpected probe failure) is not proof that the owner died.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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
      if (!Number.isSafeInteger(pid) || pid <= 1 || pidClaimOwnerAlive(pid)) return null;
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
      const text = readFileSync(pidPath, "utf8").trim();
      const existing = /^\d+$/.test(text) ? Number(text) : NaN;
      if (Number.isSafeInteger(existing) && existing > 1) {
        if (pidClaimOwnerAlive(existing)) return "running";
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
