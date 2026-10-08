import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { App, LogLevel, SocketModeReceiver, type RespondFn } from "@slack/bolt";
import { loadConfig, PID_PATH, CONFIG_PATH, STATE_PATH } from "./config.js";
import { StateStore } from "./state.js";
import { ServerPool, type PoolEntry } from "./opencode/server.js";
import { permRespond, sessionDiff, sessionMessages, pendingQuestions, pendingPermissions, questionReply, questionReject } from "./opencode/client.js";
import { noteSessionActivity } from "./commands/picker.js";
import {
  appendSectionSuffix,
  PERMISSION_ACTIONS,
  QUESTION_ACTION_PATTERN,
  questionBlocks,
  VIEW_DIFF_ACTION,
} from "./slack/blocks.js";
import { PERMISSION_STORE_PATH, PermissionDeliveryStore, PermissionResponder, parsePermissionButton, type PermissionRecord } from "./slack/permissions.js";
import { PermissionDeliveryManager } from "./slack/permission-delivery.js";
import { QuestionsStore, questionBindingToken, sameQuestionBinding, type QuestionSnapshot } from "./slack/questions-store.js";
import { QuestionUiReconciler, questionPresentationMarker } from "./slack/question-ui.js";
import { unicodeEmoji } from "./slack/emoji.js";
import { formAnswer, visibleQuestions } from "./opencode/v2.js";
import { compareTs, isRecentRecoveryEligibleReceipt, isRecentRecoveryEligibleThread, replayAge } from "./slack/recovery-policy.js";
import { recoverInterruptedRuns } from "./slack/boot-recovery.js";
import { handleIncomingMessage, type BridgeDeps, type SlackMsg } from "./slack/router.js";
import { buildUnifiedDiff, formatDiffSummary } from "./commands/handlers.js";
import { finalizeViewsForProject, getView, hasActiveViewForProject, reconcileStaleViews, setProjectConnectionState, describeActiveRuns, deleteView } from "./slack/render.js";
import type { RenderDeps } from "./slack/render.js";
import { sweepMissedMessages, type CatchupDeps } from "./slack/catchup.js";
import { GhostDetector } from "./ghosts.js";
import { enqueue, noteSlackOnline, slackOffline } from "./slack/queue.js";
import { slackWebClientOptions, slackSocketClientOptions, SLACK_UPLOAD_TIMEOUT_MS } from "./slack/transport.js";
import { isSocketModeFailure, SocketSupervisor } from "./slack/socket-supervisor.js";
import { boundedShutdown, startManagedRuntime, stopManagedService } from "./service.js";
import { enableFileLog, logErr, pushLog, ringLogger } from "./log.js";
import { normalizePermission, type OcPermission, type OcQuestionRequest, type OcMessageInfo } from "./opencode/api.js";
import { createScheduledReports, type ScheduledReports } from "./schedules/slack.js";

export interface StartOpts {
  cwd: string;
}

/** Idle servers are stopped after 30 min without SSE events; checked every 5 min. */
const IDLE_SERVER_TTL_MS = 30 * 60_000;
const REAPER_INTERVAL_MS = 5 * 60_000;
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
  // Keep a one-time pre-migration rollback copy, before StateStore's first save.
  if (existsSync(STATE_PATH) && !existsSync(`${STATE_PATH}.pre-recovery-v1`)) {
    let disk: { threads?: Record<string, { recovery?: { version?: number } }> } = {};
    try { disk = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { /* StateStore quarantines a corrupt file */ }
    if (Object.values(disk?.threads ?? {}).some(t => t.recovery?.version !== 1)) {
      copyFileSync(STATE_PATH, `${STATE_PATH}.pre-recovery-v1`);
      chmodSync(`${STATE_PATH}.pre-recovery-v1`, 0o600);
    }
  }
  const state = new StateStore(STATE_PATH);
  state.migrateRecovery();
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
            text: unicodeEmoji(text),
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
      await enqueue(() => app.client.chat.update({ channel, ts, text: unicodeEmoji(text) }), { channel, method: "chat.update" });
    },
    delete: async (channel, ts) => {
      await enqueue(() => app.client.chat.delete({ channel, ts }), { channel, method: "chat.delete" });
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
            initial_comment: comment ? unicodeEmoji(comment) : undefined,
            title: filename,
          }),
        { channel: channelId, method: "files.upload", lane, timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false },
      );
    },
    dm: async (channel, threadTs, text, blocks, opts) => {
      if (!dmChannelId) throw new Error("owner DM channel unavailable");
      // Hand-rolled permalink to the thread, so a DM is one tap from context.
      const link = teamUrl ? `\n<${teamUrl}archives/${channel}/p${threadTs.replace(".", "")}|view thread>` : "";
      // With blocks present, `text` is only the notification fallback — graft
      // the link onto the first section so the RENDERED DM keeps it too.
      const outBlocks = blocks && link ? appendSectionSuffix(blocks, link) : blocks;
      const r = await enqueue(
        () =>
          app.client.chat.postMessage({
            channel: dmChannelId!,
            text: unicodeEmoji(`${text}${link}`),
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
  type PermissionAsk = InteractionAsk & { perm: OcPermission; record: PermissionRecord };
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
     generation: number;
      response: "pending" | "answering" | "uncertain" | "resolved";
      page?: number;
      ui: NonNullable<QuestionSnapshot["ui"]>;
      draftRevision: number;
       resumeOwnerTs?: string;
       presentation: number;
    };
    const quesAsks = new Map<string, QuestionAsk>();
    const questionLocks = new Set<string>();
    function saveQuestion(ask: QuestionAsk, replace = false): void {
      const current = quesAsks.get(ask.id);
      const saved = questionStore.get(ask.id);
      const samePlacement = !!saved && sameQuestionBinding(saved, ask);
      if ((current && current !== ask) || (!replace && saved && !sameQuestionBinding(saved, ask))) {
        questionStore.update(ask.id, record => {
          const copies = [...record.retiredCopies ?? []];
          if (ask.askTs && (ask.askTs !== record.askTs || ask.channel !== record.channel)) copies.push({ channel: ask.channel, ts: ask.askTs });
          if (ask.dmTs && ask.dmTs !== record.dmTs && dmChannelId) copies.push({ channel: dmChannelId, ts: ask.dmTs });
          const retired = copies.filter((c, i) => copies.findIndex(o => o.channel === c.channel && o.ts === c.ts) === i);
          if (retired.length > 32) throw new Error("Question cleanup capacity reached; unresolved copies retained");
          record.retiredCopies = retired;
        });
        return;
      }
      if (!replace && saved && sameQuestionBinding(saved, ask)) {
        // The UI writer owns copy identities. A delayed answer/save must never
        // restore the old timestamps after a successful placement handoff.
        ask.askTs = saved.askTs ?? ask.askTs;
        ask.dmTs = saved.dmTs ?? ask.dmTs;
        ask.presentation = Math.max(ask.presentation, saved.presentation ?? 0);
        ask.ui.threadApplied = Math.max(ask.ui.threadApplied, saved.ui?.threadApplied ?? 0);
        ask.ui.dmApplied = Math.max(ask.ui.dmApplied, saved.ui?.dmApplied ?? 0);
      }
      questionStore.put({ id: ask.id, sessionId: ask.sessionId, projectDir: ask.projectDir, generation: ask.generation,
        channel: ask.channel, threadTs: ask.threadTs, req: ask.req, answers: ask.answers, finalized: ask.finalized,
        askTs: ask.askTs, dmTs: ask.dmTs, response: ask.response, updatedAt: Date.now(),
        threadDelivery: ask.threadDelivery, dmDelivery: ask.dmDelivery, ui: ask.ui, page: ask.page,
        draftRevision: ask.draftRevision, resumeOwnerTs: ask.resumeOwnerTs, resolvedText: ask.resolvedText,
        retiredCopies: saved?.retiredCopies, presentation: ask.presentation,
        threadPresentation: samePlacement ? saved.threadPresentation ?? 0 : ask.presentation,
        dmPresentation: samePlacement ? saved.dmPresentation ?? 0 : ask.presentation,
        relocation: samePlacement ? saved.relocation : undefined });
    }
    function activeQuestion(ask: Pick<QuestionSnapshot, "req" | "answers" | "finalized">): number {
      const visible = visibleQuestions(ask.req, ask.answers);
      return ask.req.questions.findIndex((_, i) => visible[i] && !ask.finalized[i]);
    }
    function changedQuestion(ask: QuestionAsk, draft = true): void {
      const previous = questionStore.get(ask.id);
      try {
        if (previous && sameQuestionBinding(previous, ask) && ask.response === "pending" &&
          activeQuestion(ask) >= 0 && activeQuestion(previous) !== activeQuestion(ask)) ask.presentation++;
        ask.ui.revision++;
        if (draft) ask.draftRevision++;
        saveQuestion(ask);
      } catch (err) {
        if (previous?.generation === ask.generation) Object.assign(ask, {
          answers: previous.answers, finalized: previous.finalized, response: previous.response, page: previous.page,
          draftRevision: previous.draftRevision ?? 0, ui: previous.ui ?? { revision: 1, threadApplied: 0, dmApplied: 0 },
          resolvedText: previous.resolvedText,
          presentation: previous.presentation ?? 0,
        });
        throw err;
      }
    }
    const questionCard = (ask: Pick<QuestionAsk, "req" | "answers" | "finalized" | "page" | "generation" | "response" | "id" | "sessionId" | "projectDir" | "channel" | "threadTs"> & { presentation?: number }) => {
      const visible = visibleQuestions(ask.req, ask.answers);
      return questionBlocks(ask.req, ask.answers, ask.finalized.map((done, i) => done || !visible[i]), ask.page,
        { generation: ask.generation, binding: questionBindingToken(ask), presentation: ask.presentation ?? 0, response: ask.response });
    };
    const questionUi = new QuestionUiReconciler({ store: questionStore, dmChannel: () => dmChannelId,
      stopping: () => stopping, onError: logErr,
      eligible: snapshot => snapshot.response === "resolved" ||
        (quesAsks.get(snapshot.id)?.generation === snapshot.generation && isPending(quesAsks.get(snapshot.id)!, "question")),
      render: (snapshot, destination) => {
        const text = snapshot.resolvedText ?? "OpenCode question";
        const blocks = snapshot.response === "resolved"
          ? [{ type: "section", text: { type: "mrkdwn", text: unicodeEmoji(text) } }]
          : questionCard(snapshot);
        const link = destination === "dm" && teamUrl
          ? `\n<${teamUrl}archives/${snapshot.channel}/p${snapshot.threadTs.replace(".", "")}|view thread>` : "";
        return { text: `${unicodeEmoji(text)}\n${questionPresentationMarker(snapshot, destination)}`,
          blocks: link ? appendSectionSuffix(blocks, link) : blocks };
      },
      send: async (channel, ts, build) => {
        await enqueue(async () => {
          const card = build();
          if (card) await app.client.chat.update({ channel, ts, text: card.text, blocks: card.blocks as never });
        }, { channel, method: "chat.update", lane: "interactive" });
      },
      remove: async (channel, ts, allowed) => {
        await enqueue(async () => {
          if (!allowed()) return;
          try { await app.client.chat.delete({ channel, ts }); }
          catch (err) {
            const e = err as { code?: string; data?: { error?: string } };
            if (e?.code !== "slack_webapi_platform_error" || e.data?.error !== "message_not_found") throw err;
          }
        }, { channel, method: "chat.delete", lane: "interactive" });
      },
      post: (channel, threadTs, build) => enqueue(async () => {
        const card = build();
        if (!card) return;
        const result = await app.client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}),
          text: card.text, blocks: card.blocks as never, unfurl_links: false, unfurl_media: false });
        if (!result.ts) throw new Error("Slack did not confirm the question card timestamp");
        return { ts: result.ts };
      }, { channel, lane: "interactive" }),
      find: (channel, threadTs, marker) => enqueue(async () => {
        if (stopping) return;
        const result = threadTs
          ? await app.client.conversations.replies({ channel, ts: threadTs, limit: 100 })
          : await app.client.conversations.history({ channel, limit: 100 });
        const copy = result.messages?.find(m => m.user === botUserId && m.text?.split("\n").includes(marker));
        return copy?.ts ? { ts: copy.ts } : undefined;
      }, { channel, method: threadTs ? "conversations.replies" : "conversations.history", lane: "interactive" }),
      rejectedPost,
      onAdopt: record => {
        const ask = quesAsks.get(record.id);
        if (!ask || !sameQuestionBinding(record, ask)) return;
        ask.askTs = record.askTs; ask.dmTs = record.dmTs;
        ask.ui.threadApplied = record.ui?.threadApplied ?? 0;
        ask.ui.dmApplied = record.ui?.dmApplied ?? 0;
        getView(ask.sessionId)?.contentPosted();
      },
    });

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
        interactionChanged(dir);
        if (id) await onPermissionResolved(id, props.sessionID as string | undefined);
        return;
      }
      // Both event names: ≤1.18.25 emits permission.updated, ≥1.18.2x emits
      // permission.asked (auto-update renamed it). The adapter normalizes the
      // differing payloads onto one OcPermission the rest of the flow consumes.
      if (eventType === "permission.updated" || eventType === "permission.asked") {
        interactionChanged(dir);
        if (interactionsEnabled) await onPermission(normalizePermission(props), false, dir);
        return;
      }
      // Question tool (issue #2): the server parks a blocking question and
      // emits question.asked. Intercepted here (like permissions) so it never
      // reaches the view's default: drop — the run would hang with no way to
      // answer. replied/rejected echoes resolve the posted copies idempotently.
      if (eventType === "question.asked") {
        interactionChanged(dir);
        if (interactionsEnabled) await onQuestion(props as unknown as OcQuestionRequest);
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
    if (kind === "question") {
      const q = ask as QuestionAsk;
      const key = `${q.channel}:${q.threadTs}`;
      const bound = state.getThread(key);
      if (!bound || bound.sessionId !== q.sessionId || bound.projectDir !== q.projectDir || state.bindingGeneration(key) !== q.generation) return false;
      if (bound.scheduledRunId && !scheduledReports?.eligible(key, q.sessionId)) return false;
      if (q.resumeOwnerTs && !resumedQuestionEligible(q)) return false;
      if (!bound.scheduledRunId && (bound.hushed || bound.watchOnly ||
        (bound.recovery?.lastRun?.outcome === "stopped" && !resumedQuestionEligible(q)))) return false;
    }
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

  async function collapseCopy(channel: string, ts: string, text: string): Promise<boolean> {
    if (stopping) return false;
    return enqueue(async () => {
      if (stopping) return false;
      await app.client.chat.update({ channel, ts, text: unicodeEmoji(text),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: unicodeEmoji(text) } }] });
      return true;
    }, { channel, method: "chat.update", lane: "interactive" }).catch(err => { pushLog(`interaction update failed: ${String(err)}`); return false; });
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
        const action = kind === "question" ? `pick an option or Skip ${where}` : `reply \`\\permission ${ask.id} once\` or \`\\permission ${ask.id} deny\``;
        void enqueue(async () => {
          if (!isPending(ask, kind)) return; // It may resolve/stop while queued.
          await app.client.chat.postMessage({ channel: ask.channel, thread_ts: ask.threadTs,
            text: `⏰ Still waiting on this ${kind} — ${action}.`,
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
      await Promise.all((["thread", "dm"] as const).map(async destination => {
        if (!isPending(ask, kind)) return;
        // A boot ask can precede DM availability; this is known not to have sent.
        if (destination === "dm" && !dmChannelId) return;
        const delivery = destination === "thread" ? ask.threadDelivery : ask.dmDelivery;
        const channel = destination === "thread" ? ask.channel : dmChannelId!;
        // Initial delivery has one stable marker even if an answer advances the
        // wizard before Slack returns this first post's timestamp.
        const marker = `slackoc-question:${ask.id}:${(ask as QuestionAsk).generation}`;
        if (retry && delivery.status === "uncertain") {
          try {
            const history = await enqueue(() => destination === "thread"
              ? app.client.conversations.replies({ channel, ts: ask.threadTs, limit: 100 })
              : app.client.conversations.history({ channel, limit: 100 }),
            { channel, method: destination === "thread" ? "conversations.replies" : "conversations.history" });
            if (!isPending(ask, kind)) return;
            const copy = history.messages?.find(m => m.user === botUserId && m.text?.split("\n").some(line => line === marker));
            if (copy?.ts) {
              if (destination === "thread") ask.askTs = copy.ts; else ask.dmTs = copy.ts;
              delivery.status = "delivered"; saveQuestion(ask as QuestionAsk);
              await questionUi.refresh(ask.id); return;
            }
            if (!history.has_more && !history.response_metadata?.next_cursor && delivery.attempts < 3) delivery.status = "new";
          } catch (err) { pushLog(`question delivery reconciliation: ${String(err)}`); }
        }
        if (delivery.status !== "new" && !(retry && delivery.status === "rejected" && delivery.attempts < 3)) return;
        delivery.status = "in-flight";
        delivery.attempts++;
        saveQuestion(ask as QuestionAsk);
        let postedBlocks: unknown[];
        const postedPresentation = (ask as QuestionAsk).presentation;
        let built = false;
        let ts: string;
        try {
          try { postedBlocks = blocks(); }
          catch (err) { delivery.status = "rejected"; saveQuestion(ask as QuestionAsk); throw err; }
          built = true;
          const text = `${header}\n${marker}`;
          const result = destination === "thread"
            ? await render.post(ask.channel, ask.threadTs, text, postedBlocks, { unfurl: false, lane: "interactive" })
            : await render.dm!(ask.channel, ask.threadTs, text, postedBlocks, { lane: "interactive" });
          ts = result.ts;
          delivery.status = "delivered";
          if (destination === "thread") ask.askTs = ts; else ask.dmTs = ts;
          const question = ask as QuestionAsk;
          if (!ask.resolvedText && JSON.stringify(postedBlocks) === JSON.stringify(blocks())) {
            question.ui[destination === "thread" ? "threadApplied" : "dmApplied"] = question.ui.revision;
          }
          if (kind === "question") {
            saveQuestion(ask as QuestionAsk);
            questionStore.update(ask.id, record => {
              if (!sameQuestionBinding(record, ask as QuestionAsk)) return;
              record[destination === "thread" ? "threadPresentation" : "dmPresentation"] = postedPresentation;
            });
          }
        } catch (err) {
          delivery.status = !built || rejectedPost(err) ? "rejected" : "uncertain";
          saveQuestion(ask as QuestionAsk);
          pushLog(`${kind} ${destination} delivery ${delivery.status} (${ask.id}): ${String(err)}`);
          return;
        }
        if (stopping) return;
        // Resolution can precede a post response. Collapse that late copy too,
        // without re-registering the ask or recreating its nudge.
        if (ask.resolvedText) await questionUi.refresh(ask.id, true);
        else if (isPending(ask, kind)) {
          if (destination === "thread") getView(ask.sessionId)?.contentPosted();
          // Partial multi-select/custom answers may change while the DM posts.
          await questionUi.refresh(ask.id);
        }
      }));
      armInteractionNudge(ask, kind);
    }).finally(() => { ask.deliveryFlight = undefined; });
    return ask.deliveryFlight;
  }

  async function onPermission(perm: OcPermission, retry = false, expectedDir?: string): Promise<void> {
    if (stopping || !perm?.id || resolvedPerms.has(perm.id)) return;
    const bound = state.findThreadBySession(perm.sessionID);
    if (!bound || (expectedDir && bound.thread.projectDir !== expectedDir)) return;
    if (bound.thread.scheduledRunId) {
      if (!scheduledReports?.eligible(bound.key, perm.sessionID)) return;
    } else if (retry && !isRecentRecoveryEligibleThread(bound.thread, state.now())) return;
    let ask = permAsks.get(perm.id);
    if (!ask) {
      const base = newAsk(perm.id, perm.sessionID);
      if (!base) return;
      const identity = { projectDir: bound.thread.projectDir, sessionId: perm.sessionID, requestId: perm.id,
        generation: state.bindingGeneration(bound.key) };
      const run = bound.thread.recovery?.lastRun;
      const runMessages = bound.thread.pendingRun?.userMsgTs ??
        (run && ["active", "interrupted"].includes(run.outcome) ? run.userMsgTs : []);
      // A recent \status or other administrative command cannot freshen an old ask.
      const originalOwnerTs = [...runMessages].sort(compareTs).at(-1) ??
        (retry ? undefined : bound.thread.recovery?.ownerActivityTs);
      const record = permissionStore.get(identity) ?? {
        ...identity, threadKey: bound.key, permission: perm, ownerActivityTs: originalOwnerTs,
        firstObservedAt: state.now(), updatedAt: state.now(),
        thread: { status: "new" as const, format: "card" as const, attempts: 0 },
        dm: { status: "new" as const, format: "card" as const, attempts: 0 }, response: { status: "pending" as const },
      };
      if (record.response.status === "resolved") { resolvedPerms.add(perm.id); return; }
      if (!permissionEligible(record)) return;
      permissionStore.put(record);
      ask = { ...base, perm, record, askTs: record.thread.ts ?? null, dmTs: record.dm.ts ?? null };
      permAsks.set(perm.id, ask);
      interactionChanged(ask.projectDir);
    }
    getView(ask.sessionId)?.setWaiting(perm.id, "permission", true);
    await permissionDelivery.deliver(ask.record);
    armInteractionNudge(ask, "permission");
  }

  function resumedQuestionEligible(ask: Pick<QuestionSnapshot, "resumeOwnerTs" | "channel" | "threadTs" | "generation" | "sessionId" | "projectDir">): boolean {
    const key = `${ask.channel}:${ask.threadTs}`;
    const bound = state.getThread(key);
    return !!bound && bound.sessionId === ask.sessionId && bound.projectDir === ask.projectDir &&
      state.bindingGeneration(key) === ask.generation && !bound.hushed && !bound.watchOnly &&
      replayAge(ask.resumeOwnerTs, state.now()).decision === "recover" &&
      (!bound.recovery?.canceledThroughTs || compareTs(ask.resumeOwnerTs!, bound.recovery.canceledThroughTs) >= 0);
  }

  async function onQuestion(req: OcQuestionRequest, retry = false, resumeOwnerTs?: string): Promise<void> {
    if (stopping || !req?.id || resolvedQuestions.has(req.id)) return;
    const context = state.findThreadBySession(req.sessionID);
    if (!context || context.thread.hushed || context.thread.watchOnly) return;
    if (resumeOwnerTs) {
      const [channel, threadTs] = context.key.split(":") as [string, string];
      if (!resumedQuestionEligible({ channel, threadTs, generation: state.bindingGeneration(context.key),
        sessionId: req.sessionID, projectDir: context.thread.projectDir, resumeOwnerTs })) return;
    }
    if (context?.thread.scheduledRunId && !scheduledReports?.eligible(context.key, req.sessionID)) return;
    if (retry) {
      const bound = state.findThreadBySession(req.sessionID);
      const saved = questionStore.get(req.id);
      if (!bound || (!bound.thread.scheduledRunId && !isRecentRecoveryEligibleThread(bound.thread, state.now()) &&
        !(saved && resumedQuestionEligible(saved)) && !resumeOwnerTs)) return;
    }
    const prior = questionStore.get(req.id);
    const [targetChannel, targetThread] = context.key.split(":") as [string, string];
    if (prior && !sameQuestionBinding(prior, { id: req.id, sessionId: req.sessionID, projectDir: context.thread.projectDir,
      generation: state.bindingGeneration(context.key), channel: targetChannel, threadTs: targetThread }) && prior.relocation) {
      await questionUi.refresh(req.id, true);
      const remaining = questionStore.get(req.id)?.relocation;
      if ([remaining?.thread, remaining?.dm].some(move => move && ["in-flight", "uncertain"].includes(move.status))) {
        pushLog(`question ${req.id} resume deferred: previous card delivery remains uncertain`);
        return;
      }
    }
    let ask = quesAsks.get(req.id);
    if (ask && (ask.sessionId !== req.sessionID || ask.projectDir !== context.thread.projectDir ||
      `${ask.channel}:${ask.threadTs}` !== context.key || ask.generation !== state.bindingGeneration(context.key))) {
      if (!resumeOwnerTs) return;
      const timer = quesNudges.get(ask.id);
      if (timer) clearTimeout(timer);
      quesNudges.delete(ask.id);
      quesAsks.delete(ask.id);
      ask = undefined;
    }
    if (!ask) {
      const base = newAsk(req.id, req.sessionID);
      if (!base) return;
      const generation = state.bindingGeneration(`${base.channel}:${base.threadTs}`);
      const saved = questionStore.get(req.id);
      if (saved && !resumeOwnerTs && !sameQuestionBinding(saved, { id: req.id, sessionId: req.sessionID,
        projectDir: base.projectDir, generation, channel: base.channel, threadTs: base.threadTs })) return;
      const sameForm = saved && saved.sessionId === req.sessionID && saved.projectDir === base.projectDir &&
        JSON.stringify(saved.req) === JSON.stringify(req);
      const restore = sameForm && saved.generation === generation && saved.channel === base.channel && saved.threadTs === base.threadTs;
      if (restore && saved.response === "resolved") return;
      const carry = sameForm && !!resumeOwnerTs;
      const sameDestination = sameForm && saved.channel === base.channel && saved.threadTs === base.threadTs;
      ask = { ...base, req, generation, response: restore ? saved.response : carry && ["answering", "uncertain"].includes(saved.response) ? "uncertain" : "pending",
        answers: restore || carry ? saved.answers : req.questions.map(() => []),
        finalized: restore ? saved.finalized : req.questions.map(() => false),
        askTs: restore || sameDestination ? saved.askTs : null, dmTs: restore || carry ? saved.dmTs : null,
        ui: restore ? saved.ui ?? { revision: 1, threadApplied: 0, dmApplied: 0 } : { revision: (saved?.ui?.revision ?? 0) + 1, threadApplied: 0, dmApplied: 0 },
        page: restore ? saved.page : 0, draftRevision: restore ? saved.draftRevision ?? 0 : (saved?.draftRevision ?? 0) + 1,
        presentation: restore ? saved.presentation ?? 0 : 0,
        resumeOwnerTs: resumeOwnerTs ?? (restore ? saved.resumeOwnerTs : undefined) };
      if (stopping || state.bindingGeneration(context.key) !== generation || state.findThreadBySession(req.sessionID)?.key !== context.key) return;
      if (ask.askTs) ask.threadDelivery.status = "delivered";
      if (ask.dmTs) ask.dmDelivery.status = "delivered";
      if (restore && saved.threadDelivery) ask.threadDelivery = saved.threadDelivery;
      if (restore && saved.dmDelivery) ask.dmDelivery = saved.dmDelivery;
      saveQuestion(ask, true);
      if (!restore && saved?.askTs && !sameDestination) questionStore.update(req.id, record => {
        record.retiredCopies = [...record.retiredCopies ?? [], { channel: saved.channel, ts: saved.askTs! }];
      });
      quesAsks.set(req.id, ask); // Buttons are usable BEFORE either post awaits.
      interactionChanged(ask.projectDir);
    }
    if (resumeOwnerTs && ask.resumeOwnerTs !== resumeOwnerTs) {
      ask.resumeOwnerTs = resumeOwnerTs;
      ask.finalized.fill(false);
      changedQuestion(ask);
    }
    const pending = ask;
    getView(ask.sessionId)?.setWaiting(req.id, "question", true);
    await deliverAsk(ask, "question", `❓ *OpenCode has a question* — ${req.questions.length} to answer`,
      () => questionCard(pending), retry);
    await questionUi.refresh(ask.id);
  }

  async function resolveInteraction(kind: InteractionKind, id: string, text: string,
    sessionId?: string, knownAsk?: InteractionAsk): Promise<void> {
    const asks = kind === "question" ? quesAsks : permAsks;
    const resolved = kind === "question" ? resolvedQuestions : resolvedPerms;
    const nudges = kind === "question" ? quesNudges : permNudges;
    const ask = asks.get(id) ?? knownAsk;
    const saved = kind === "question" ? questionStore.get(id) : undefined;
    if (sessionId && (ask?.sessionId ?? saved?.sessionId) && sessionId !== (ask?.sessionId ?? saved?.sessionId)) return;
    if (kind === "question" && ask) {
      const question = ask as QuestionAsk;
      question.response = "resolved";
      question.resolvedText = text;
      changedQuestion(question, false);
    }
    if (kind === "question" && !ask && saved) questionStore.update(id, record => {
      record.response = "resolved"; record.resolvedText = text;
      record.ui ??= { revision: 1, threadApplied: 0, dmApplied: 0 };
      record.ui.revision++; record.updatedAt = Date.now();
    });
    resolved.add(id);
    if (ask) ask.resolvedText = text;
    asks.delete(id);
    const timer = nudges.get(id);
    if (timer) clearTimeout(timer);
    nudges.delete(id);
    const sid = ask?.sessionId ?? saved?.sessionId ?? sessionId;
    if (sid) getView(sid)?.setWaiting(id, kind, false);
    const dir = ask?.projectDir ?? (sid ? state.findThreadBySession(sid)?.thread.projectDir : undefined);
    if (dir) interactionChanged(dir);
    const updates: Promise<unknown>[] = [];
    if (kind === "question") updates.push(questionUi.refresh(id, true));
    else {
      if (ask?.askTs) updates.push(collapseCopy(ask.channel, ask.askTs, text));
      if (ask?.dmTs && dmChannelId) updates.push(collapseCopy(dmChannelId, ask.dmTs, text));
    }
    await Promise.all(updates);
  }

  function onQuestionResolved(id: string, kind: "replied" | "rejected", sessionId?: string): Promise<void> {
    return resolveInteraction("question", id, kind === "rejected"
      ? ":arrow_forward: Skip confirmed."
      : ":white_check_mark: Answer confirmed.", sessionId);
  }

  async function onPermissionResolved(id: string, sessionId?: string): Promise<void> {
    const ask = permAsks.get(id);
    const record = ask?.record ?? permissionStore.list().find(r => r.requestId === id && (!sessionId || r.sessionId === sessionId));
    if (record) { await permissionResponder.observeResolved(record); return; }
    await resolveInteraction("permission", id, "Permission resolved or expired.", sessionId);
  }

  // Keep the onReady hook's signature; boot, resume, and periodic recovery all
  // share the same identity-checked, per-directory flight (including permissions).
  async function sweepQuestions(dir: string, baseUrl: string): Promise<void> {
    if (pool.get(dir)?.baseUrl === baseUrl) await sweepInteractions(dir);
  }

  function sweepInteractions(dir: string): Promise<void> {
    const entry = pool.get(dir);
    if (!interactionsEnabled || !entry?.baseUrl || stopping) return Promise.resolve();
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
        const [questions, permissions] = await withExistingLease(current, async () => Promise.allSettled([
          pendingQuestions(current.client!), pendingPermissions(current.client!),
        ]));
        if (stopping || pool.get(key) !== current || (interactionVersions.get(key) ?? 0) !== version) continue;
        // Apply all local changes without yielding; delivery promises finish
        // afterward and check ask identity/resolution before adopting late work.
        const work: Promise<void>[] = [];
        if (questions.status === "fulfilled") {
          const ids = new Set(questions.value.map(q => q.id));
          for (const saved of questionStore.list()) if (saved.projectDir === key && saved.response !== "resolved" && !ids.has(saved.id) && !quesAsks.has(saved.id)) {
            work.push(resolveInteraction("question", saved.id, "Question resolved or expired; the previous answer was not confirmed.", saved.sessionId));
          }
          for (const [id, ask] of quesAsks) if (ask.projectDir === key && !ids.has(id)) work.push(resolveInteraction("question", id, "Question resolved or expired; the previous answer was not confirmed."));
          for (const q of questions.value) work.push(onQuestion(q, true));
        } else pushLog(`question sweep failed for ${key}: ${String(questions.reason)}`);
        if (permissions.status === "fulfilled") {
          const ids = new Set(permissions.value.map(p => p.id));
          for (const [id, ask] of permAsks) if (ask.projectDir === key && !ids.has(id)) work.push(onPermissionResolved(id));
          for (const p of permissions.value) work.push(onPermission(p, true, key));
        } else pushLog(`permission sweep failed for ${key}: ${String(permissions.reason)}`);
        await Promise.all(work);
      } while (sweep.requested && !stopping);
    }).catch(err => logErr(`interaction sweep failed for ${key}: ${String(err)}`))
      .finally(() => { if (interactionSweeps.get(key) === sweep) interactionSweeps.delete(key); });
    interactionSweeps.set(key, sweep);
    return sweep.flight;
  }

  async function withExistingLease<T>(entry: PoolEntry, work: () => Promise<T>): Promise<T> {
    const lease = typeof pool.acquireExisting === "function" ? pool.acquireExisting(entry.dir) : undefined;
    if (stopping || pool.get(entry.dir) !== entry || (typeof pool.acquireExisting === "function" && lease?.entry !== entry)) {
      lease?.release();
      throw new Error("OpenCode generation no longer running");
    }
    try { return await work(); } finally { lease?.release(); }
  }

  function permissionEligible(record: PermissionRecord): boolean {
    const bound = state.getThread(record.threadKey);
    if (bound?.scheduledRunId) return !stopping && bound.sessionId === record.sessionId &&
      bound.projectDir === record.projectDir && state.bindingGeneration(record.threadKey) === record.generation &&
      !!scheduledReports?.eligible(record.threadKey, record.sessionId) &&
      ["read", "glob", "grep", "webfetch", "websearch", "question", "external_directory"].includes(record.permission.type);
    return !stopping && !!bound && bound.sessionId === record.sessionId && bound.projectDir === record.projectDir &&
      state.bindingGeneration(record.threadKey) === record.generation && !bound.hushed && !bound.watchOnly &&
      replayAge(record.ownerActivityTs, state.now()).decision === "recover" &&
      (!bound.recovery?.canceledThroughTs || compareTs(record.ownerActivityTs!, bound.recovery.canceledThroughTs) > 0);
  }

  async function collapsePermissionCopies(record: PermissionRecord, text: string): Promise<void> {
    await Promise.all((["thread", "dm"] as const).map(async destination => {
      const copy = permissionStore.get(record)?.[destination];
      if (!copy?.channel || !copy.ts || copy.collapsed) return;
      if (await collapseCopy(copy.channel, copy.ts, text)) permissionStore.update(record, r => {
        if (r[destination].ts === copy.ts) r[destination].collapsed = true;
      });
    }));
  }

  const permissionResponder = new PermissionResponder<PoolEntry>({
    ownerSlackUserId: config.ownerSlackUserId, store: permissionStore,
    getBinding: key => {
      const t = state.getThread(key);
      return t ? { projectDir: t.projectDir, sessionId: t.sessionId, generation: state.bindingGeneration(key) } : undefined;
    },
    getRunning: dir => { const e = pool.get(dir); return !stopping && e?.status === "ready" ? e : undefined; },
    findPending: entry => withExistingLease(entry, () => pendingPermissions(entry.client!)),
    respond: (entry, perm, choice) => withExistingLease(entry, async () => { await permRespond(entry.client!, perm.sessionID, perm.id, choice); }),
    eligible: permissionEligible,
    resolved: async (record, text) => {
      const ask = permAsks.get(record.requestId);
      // The durable copy registry owns result updates, including retry after a restart.
      if (ask) { ask.askTs = null; ask.dmTs = null; }
      await resolveInteraction("permission", record.requestId, text, record.sessionId, ask);
      await collapsePermissionCopies(record, text);
    },
  });

  const permissionDelivery = new PermissionDeliveryManager({
    store: permissionStore, isCurrent: permissionEligible, now: state.now,
    post: async (record, destination, text, blocks) => {
      const channel = destination === "thread" ? record.threadKey.split(":")[0]! : dmChannelId;
      if (!channel) throw Object.assign(new Error("owner DM channel unavailable"), { code: "channel_not_found" });
      const rootTs = record.threadKey.split(":")[1]!;
      const link = destination === "dm" && teamUrl ? `\n<${teamUrl}archives/${record.threadKey.split(":")[0]}/p${rootTs.replace(".", "")}|view thread>` : "";
      const result = await enqueue(async () => {
        const current = permissionStore.get(record);
        if (!current || current.response.status === "resolved" || !permissionEligible(current)) throw new Error("permission no longer pending");
        return app.client.chat.postMessage({ channel, ...(destination === "thread" ? { thread_ts: rootTs } : {}),
          text: text + link, ...(blocks ? { blocks: appendSectionSuffix(blocks, link) as never } : {}),
          mrkdwn: true, unfurl_links: false, unfurl_media: false });
      }, { channel, lane: "interactive" });
      if (!result.ts) throw new Error("Slack did not confirm the permission message timestamp");
      return { channel, ts: result.ts };
    },
    findCopy: async (record, destination, marker) => {
      const channel = destination === "thread" ? record.threadKey.split(":")[0]! : dmChannelId;
      if (!channel || stopping) return "unknown";
      const oldest = String(Math.max(0, record.firstObservedAt - 60_000) / 1000);
      const result = await enqueue(() => destination === "thread"
        ? app.client.conversations.replies({ channel, ts: record.threadKey.split(":")[1]!, oldest, inclusive: true, limit: 100 })
        : app.client.conversations.history({ channel, oldest, inclusive: true, limit: 100 }), { channel, method: destination === "thread" ? "conversations.replies" : "conversations.history", lane: "interactive" });
      const copies = result.messages?.filter(m => m.user === botUserId && m.text?.includes(marker) && m.ts);
      if (copies?.length) return { channel, ts: copies[0]!.ts! };
      return result.has_more || result.response_metadata?.next_cursor ? "unknown" : "absent";
    },
    onDelivered: async (record, destination) => {
      const d = record[destination];
      const ask = permAsks.get(record.requestId);
      if (ask) { if (destination === "thread") ask.askTs = d.ts ?? null; else ask.dmTs = d.ts ?? null; }
      if (record.response.status === "resolved" || !permissionEligible(record)) {
        await collapsePermissionCopies(record, record.response.text ?? "Permission expired or session changed.");
      } else {
        if (destination === "thread") getView(record.sessionId)?.contentPosted();
        if (ask) armInteractionNudge(ask, "permission");
      }
    },
    onState: record => {
      const failed = [record.thread, record.dm].some(d => d.error) && ![record.thread, record.dm].some(d => d.status === "delivered");
      getView(record.sessionId)?.setPermissionDeliveryFailed(record.requestId, failed);
    },
  });

  // Independent of history/acceptance scans: an approval can unblock the current run.
  let terminalQuestionOffset = 0;
  async function reconcileTerminalQuestionPosts(): Promise<void> {
    const records = questionStore.list().filter(r => r.response === "resolved" && state.now() - r.updatedAt <= 7 * 86400_000 &&
      ((!r.askTs && r.threadDelivery?.status === "uncertain") || (!r.dmTs && r.dmDelivery?.status === "uncertain")));
    const work = Array.from({ length: Math.min(4, records.length) }, (_, i) => records[(terminalQuestionOffset + i) % records.length]!);
    terminalQuestionOffset += work.length;
    await Promise.all(work.map(async record => {
      for (const destination of ["thread", "dm"] as const) {
        const channel = destination === "thread" ? record.channel : dmChannelId;
        const tsKey = destination === "thread" ? "askTs" : "dmTs";
        const deliveryKey = destination === "thread" ? "threadDelivery" : "dmDelivery";
        if (!channel || record[tsKey] || record[deliveryKey]?.status !== "uncertain" || stopping) continue;
        try {
          const history = await enqueue(() => destination === "thread"
            ? app.client.conversations.replies({ channel, ts: record.threadTs, limit: 100 })
            : app.client.conversations.history({ channel, limit: 100 }),
          { channel, method: destination === "thread" ? "conversations.replies" : "conversations.history" });
          if (stopping) return;
          const markers = [`slackoc-question:${record.id}:${record.generation}`, `slackoc-question:${record.id}`];
          const copy = history.messages?.find(m => m.user === botUserId && m.text?.split("\n").some(line => markers.includes(line)));
          questionStore.update(record.id, current => {
            if (!sameQuestionBinding(record, current) || current.response !== "resolved" || current[tsKey]) return;
            if (copy?.ts) {
              current[tsKey] = copy.ts;
              current[deliveryKey] = { ...current[deliveryKey]!, status: "delivered" };
              current.ui![destination === "thread" ? "threadApplied" : "dmApplied"] = 0;
            } else if (!history.has_more && !history.response_metadata?.next_cursor) {
              // Proved absent: there is no terminal card to replace, never repost it.
              current[deliveryKey] = { ...current[deliveryKey]!, status: "rejected" };
            }
          });
        } catch (err) { pushLog(`question terminal delivery reconciliation: ${String(err)}`); }
      }
    }));
  }

  async function refreshPermissions(force = false): Promise<void> {
    if (!interactionsEnabled || stopping) return;
    if (!dmChannelId && force) {
      const opened = await app.client.conversations.open({ users: config!.ownerSlackUserId }).catch(() => null);
      dmChannelId = opened?.channel?.id ?? null;
    }
    for (const record of permissionStore.list()) {
      if (record.response.status === "resolved" && permissionEligible(record)) {
        await collapsePermissionCopies(record, record.response.text ?? "Permission resolved or expired.");
      }
      if (record.response.status !== "resolved" && !permissionEligible(record)) {
        permissionStore.update(record, r => { r.response = { ...r.response, status: "resolved", confirmed: false, text: "Permission retired: old or canceled conversation." }; });
        const ask = permAsks.get(record.requestId);
        if (ask) {
          ask.resolvedText = "Permission retired.";
          permAsks.delete(record.requestId);
          const timer = permNudges.get(record.requestId);
          if (timer) clearTimeout(timer);
          permNudges.delete(record.requestId);
          getView(record.sessionId)?.setWaiting(record.requestId, "permission", false);
        }
      }
    }
    await Promise.all(pool.list().filter(e => e.status === "ready").map(e => sweepInteractions(e.dir)));
    await reconcileTerminalQuestionPosts();
    await questionUi.refreshAll(force);
    if (force) await Promise.all([...permAsks.values()].map(a => permissionDelivery.deliver(a.record, { force: true })));
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
    resumeQuestions: async context => {
      const bound = state.getThread(context.threadKey);
      if (stopping || !bound || bound.sessionId !== context.sessionId || bound.hushed || bound.watchOnly ||
        state.bindingGeneration(context.threadKey) !== context.generation || replayAge(context.ownerTs, state.now()).decision !== "recover" ||
        (bound.recovery?.canceledThroughTs && compareTs(context.ownerTs, bound.recovery.canceledThroughTs) < 0)) return;
      const entry = pool.get(bound.projectDir);
      if (!entry?.client) return;
      const questions = await withExistingLease(entry, () => pendingQuestions(entry.client!));
      const latest = state.getThread(context.threadKey);
      if (stopping || state.bindingGeneration(context.threadKey) !== context.generation || !latest || latest.hushed || latest.watchOnly ||
        latest.sessionId !== context.sessionId || (latest.recovery?.canceledThroughTs && compareTs(context.ownerTs, latest.recovery.canceledThroughTs) < 0)) return;
      for (const req of questions.filter(q => q.sessionID === context.sessionId)) await onQuestion(req, true, context.ownerTs);
    },
    questions: async (context, beforeRefresh) => {
      const known = new Map([...quesAsks.values()].filter(a => a.askTs || a.dmTs).map(a => [a.id, a.presentation]));
      await refreshPermissions();
      const asks = [...quesAsks.values()].filter(a => isPending(a, "question") &&
        ("dm" in context || context.threadKey === `${a.channel}:${a.threadTs}`));
      const status = asks.length ? ["*Pending questions:*", ...asks.map(a => {
        const record = questionStore.get(a.id);
        return `• \`${a.id}\` — ${a.finalized.filter(Boolean).length}/${a.req.questions.length} answered · thread ${record?.relocation?.thread?.status ?? a.threadDelivery.status} · DM ${record?.relocation?.dm?.status ?? a.dmDelivery.status}`;
      })].join("\n") : "No pending questions.";
      // Command feedback must land before the newly surfaced card, not after it.
      if (beforeRefresh) await beforeRefresh(status);
      for (const ask of asks) {
        for (const d of [ask.threadDelivery, ask.dmDelivery]) if (d.status === "rejected") { d.attempts = 0; d.status = "new"; }
        await onQuestion(ask.req, true);
        questionStore.update(ask.id, record => {
          for (const move of [record.relocation?.thread, record.relocation?.dm]) if (move?.status === "rejected") {
            move.status = "new"; move.attempts = 0; delete move.retryAt;
          }
        });
        const saved = questionStore.get(ask.id);
        const moving = !!saved?.relocation?.thread || !!saved?.relocation?.dm ||
          (saved?.askTs && (saved.threadPresentation ?? 0) < (saved.presentation ?? 0)) ||
          (saved?.dmTs && (saved.dmPresentation ?? 0) < (saved.presentation ?? 0));
        if (known.get(ask.id) === ask.presentation && !moving && ask.response === "pending" && activeQuestion(ask) >= 0) ask.presentation++;
        changedQuestion(ask, false);
        await Promise.all(renderAskBoth(ask));
      }
      return beforeRefresh ? undefined : status;
    },
    config,
    state,
    pool,
    render,
    botUserId,
    cwd: opts.cwd,
    isStopping: () => stopping,
    bridgeInfo: { startedAt: Date.now(), dmAvailable: () => dmChannelId !== null, socket: () => socketSupervisor?.health() },
    ownerDmChannel: () => dmChannelId,
    permissions: {
      list: async (context, refresh = false) => {
        if (refresh) await refreshPermissions(true);
        const records = permissionStore.list().filter(r => r.response.status !== "resolved" && permissionEligible(r) &&
          (!("threadKey" in context) || r.threadKey === context.threadKey));
        if (!records.length) return "*Permissions:* no pending requests tracked here.";
        return ["*Pending permissions:*", ...records.slice(0, 20).map(r =>
          `• \`${r.requestId}\` — ${r.permission.type} · thread ${r.thread.status}/${r.thread.format} · DM ${r.dm.status}/${r.dm.format}${r.response.status === "uncertain" ? " · reply unconfirmed" : ""}\n  \`\\permission ${r.requestId} once\` / \`\\permission ${r.requestId} deny\``),
          ...(records.length > 20 ? [`${records.length - 20} more — inspect the original threads.`] : [])].join("\n");
      },
      respond: async input => {
        // Hydrate current pending requests for pre-restart cards, never start a server.
        if (!permissionStore.list().some(r => r.requestId === input.requestId)) await refreshPermissions();
        return permissionResponder.respond(input);
      },
    },
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

  for (const actionId of ["perm", ...PERMISSION_ACTIONS]) app.action(actionId, async ({ ack, body, action, respond }) => {
    await ack();
    if (stopping) return;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can approve OpenCode actions.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const v = parsePermissionButton(actionId, (action as { value?: string }).value);
    if (!v) { await respond({ text: "Invalid permission button. Use \\permissions.", response_type: "ephemeral" }); return; }
    const envelope = body as unknown as { channel?: { id: string }; container?: { message_ts?: string; thread_ts?: string }; message?: { ts?: string; thread_ts?: string } };
    const channel = envelope.channel?.id;
    const root = envelope.message?.thread_ts ?? envelope.container?.thread_ts;
    if (!channel || (channel !== dmChannelId && !root)) {
      await respond({ text: "Cannot identify this permission's thread. Use \\permissions there or in your owner DM.", response_type: "ephemeral" });
      return;
    }
    try {
      const result = await bridge.permissions!.respond({ actor: body.user.id, requestId: v.p, response: v.r,
        sessionId: v.s, generation: v.g, actionId, source: "live",
        context: channel === dmChannelId ? { dm: true } : { threadKey: `${channel}:${root}` } });
      if (result.notificationError) logErr(`permission result delivery failed: ${result.notificationError}`);
      if (result.status !== "resolved") await respond({ text: result.text, response_type: "ephemeral" });
      else {
        // Also collapse the clicked legacy copy if it predates our durable copy registry.
        const ts = envelope.container?.message_ts ?? envelope.message?.ts;
        if (ts && ![result.record?.thread.ts, result.record?.dm.ts].includes(ts)) await collapseCopy(channel, ts, result.text);
      }
    } catch (err) {
      logErr(`permission respond failed: ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Failed to reply to OpenCode: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
    }
  });

  // Question tool (issue #2): owner taps an option (single-select, one tap per
  // question) or Skip. Labels are resolved from the stored ask, so the button
  // value stays tiny. When every question is answered we send the full matrix;
  // the SSE question.replied/rejected echo then collapses both copies too.
  // One recoverable writer per copy; callers never pass captured old blocks.
  const renderAskBoth = (ask: QuestionAsk): Promise<unknown>[] => [questionUi.refresh(ask.id, true)];

  // If every question is finalized, send the answer matrix and resolve the ask;
  // otherwise re-render both copies. "failed" = the reply errored (re-rendered
  // so the owner can retry or Skip) — the caller surfaces the ephemeral notice.
  const submitAskIfComplete = async (ask: QuestionAsk, client: NonNullable<PoolEntry["client"]>): Promise<"replied" | "incomplete" | "failed"> => {
    if (!isPending(ask, "question")) return "incomplete";
    if (questionLocks.has(ask.id)) return "incomplete";
    changedQuestion(ask);
    if (ask.response === "uncertain") {
      questionLocks.add(ask.id);
      try {
        const pending = await pendingQuestions(client);
        if (!isPending(ask, "question")) return "incomplete";
        if (!pending.some(q => q.id === ask.id && q.sessionID === ask.sessionId)) {
          await resolveInteraction("question", ask.id, "Question resolved or expired; the previous answer was not confirmed.");
          return "replied";
        }
        ask.response = "pending"; changedQuestion(ask, false);
        await questionUi.refresh(ask.id, true);
        await render.post(ask.channel, ask.threadTs, "The form is still pending. Your previous submission was not confirmed; review your answers, then tap Retry submission again to send them.", undefined, { lane: "interactive" });
        return "incomplete";
      } catch (err) {
        logErr(`question reconciliation failed: ${String(err)}`);
        return "failed";
      } finally { questionLocks.delete(ask.id); }
    }
    const visible = visibleQuestions(ask.req, ask.answers);
    if (!ask.req.questions.every((_, qi) => ask.finalized[qi] || !visible[qi])) {
      await Promise.all(renderAskBoth(ask));
      return "incomplete";
    }
    questionLocks.add(ask.id);
    try {
      ask.response = "answering"; changedQuestion(ask, false);
      void questionUi.refresh(ask.id).catch(err => logErr(`question sending update: ${String(err)}`));
      await questionReply(client, ask.req.id, ask.answers, { request: ask.req });
    } catch (err) {
      if (ask.resolvedText) return "replied";
      ask.response = (err as { _tag?: string })?._tag === "FormInvalidAnswerError" ? "pending" : "uncertain";
      changedQuestion(ask, false);
      logErr(`question reply failed: ${String((err as Error)?.message ?? err)}`);
      if (isPending(ask, "question")) await Promise.all(renderAskBoth(ask));
      return "failed";
    } finally {
      questionLocks.delete(ask.id);
    }
    await onQuestionResolved(ask.req.id, "replied");
    return "replied";
  };

  // Shared owner/bound/ask/entry guard for the question action handlers.
  const questionGuard = async (
    body: { user: { id: string } },
    raw: string | undefined,
    respond: RespondFn,
    allowUncertain = false,
  ): Promise<{ v: { s: string; q: string; i: number; a?: number; page?: number; g?: number; b?: string; c?: number }; ask: QuestionAsk; url: NonNullable<PoolEntry["client"]> } | null> => {
    if (stopping) return null;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can answer OpenCode questions.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    const invalid = async (text = "Invalid or outdated question control. Use \\questions to get the latest card.") => {
      await respond({ text, response_type: "ephemeral" }).catch(() => {}); return null;
    };
    if (!raw) return invalid();
    let parsed: { s: string; q: string; i: number; a?: number; g?: number; b?: string; c?: number };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
      if (!parsed || typeof parsed.s !== "string" || typeof parsed.q !== "string") return invalid();
    } catch {
      return invalid();
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
    if (!Number.isSafeInteger(parsed.g) || parsed.g !== ask.generation || parsed.b !== questionBindingToken(ask)) {
      await respond({ text: "This question belongs to an older binding. Use the latest card — refreshing it now.", response_type: "ephemeral" }).catch(() => {});
      changedQuestion(ask, false);
      await questionUi.refresh(ask.id, true);
      return null;
    }
    if (!Number.isSafeInteger(parsed.c ?? 0) || (parsed.c ?? 0) !== ask.presentation) {
      await respond({ text: "That answer is already saved or this card moved. Use the latest question below.", response_type: "ephemeral" }).catch(() => {});
      await questionUi.refresh(ask.id, true);
      return null;
    }
    const envelope = body as { channel?: { id: string }; message?: { thread_ts?: string }; container?: { thread_ts?: string } };
    if (envelope.channel && envelope.channel.id !== dmChannelId &&
      (envelope.channel.id !== ask.channel || (envelope.message?.thread_ts ?? envelope.container?.thread_ts) !== ask.threadTs)) return invalid("Use this question's current thread or owner DM.");
    if (!envelope.channel) return invalid("Cannot identify this question's destination. Use \\questions.");
    if (!Number.isSafeInteger(parsed.i) || parsed.i < 0 || parsed.i >= ask.req.questions.length) return invalid();
    if (questionLocks.has(ask.id)) { await respond({ text: "An answer is already being submitted.", response_type: "ephemeral" }); return null; }
    if (ask.response === "uncertain" && !allowUncertain) return invalid("Submission unconfirmed. Use Retry submission to reconcile it before changing answers.");
    const entry = pool.get(bound.thread.projectDir);
    if (!entry?.client) {
      await respond({ text: "The OpenCode server isn't ready yet — try again in a moment.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    return { v: parsed, ask, url: entry.client };
  };
  async function alreadySaved(ask: QuestionAsk, respond: RespondFn): Promise<void> {
    await respond({ text: "That answer is already saved. Refreshing the question — use the latest card.", response_type: "ephemeral" }).catch(() => {});
    changedQuestion(ask, false);
    await questionUi.refresh(ask.id, true);
  }

  app.action(QUESTION_ACTION_PATTERN, async ({ ack, body, action, respond }) => {
    await ack();
    if (stopping) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id)) return;
    const { v, ask, url } = g;

    if (v.a === -1) {
      // Skip (reject): unblock the run, collapse both copies to a final line.
      try {
        questionLocks.add(ask.id);
        ask.response = "answering"; changedQuestion(ask, false);
        void questionUi.refresh(ask.id).catch(err => logErr(`question skip update: ${String(err)}`));
        await questionReject(url, v.q, { sessionId: ask.sessionId });
      } catch (err) {
        if (ask.resolvedText) return;
        ask.response = "uncertain"; changedQuestion(ask, false);
        await questionUi.refresh(ask.id, true);
        logErr(`question reject failed: ${String((err as Error)?.message ?? err)}`);
        await respond({ text: `Failed to skip the question: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
        return;
      } finally { questionLocks.delete(ask.id); }
      await onQuestionResolved(v.q, "rejected");
      return;
    }

    const q = ask.req.questions[v.i!];
    if (ask.finalized[v.i] || !visibleQuestions(ask.req, ask.answers)[v.i]) { await alreadySaved(ask, respond); return; }
    const label = q?.options[v.a!]?.value ?? q?.options[v.a!]?.label;
    if (!q || label == null) { await respond({ text: "That option is no longer available. Use the latest card.", response_type: "ephemeral" }); return; }

    if (q.multiple) {
      // Multi-select: toggle this option in/out; "Submit selection" finalizes.
      const cur = ask.answers[v.i!]!;
      const idx = cur.indexOf(label);
      if (idx >= 0) cur.splice(idx, 1);
      else cur.push(label);
      changedQuestion(ask);
      await Promise.all(renderAskBoth(ask));
      return;
    }

    // Single-select: one tap locks the answer, then submit-if-complete.
    ask.answers[v.i!] = [label];
    ask.finalized[v.i!] = true;
    ask.page = 0;
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
    if (ask.finalized[v.i] || !visibleQuestions(ask.req, ask.answers)[v.i]) { await alreadySaved(ask, respond); return; }
    const field = ask.req.questions[v.i]?.field;
    if (!ask.answers[v.i!]?.length && (!field || field.type === "external" || field.required)) {
      await respond({ text: "Pick at least one option before submitting.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    ask.finalized[v.i!] = true;
    ask.page = 0;
    const r = await submitAskIfComplete(ask, url);
    if (r === "failed") {
      await respond({ text: "Failed to send your answer — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
    }
  });

  app.action("qomit", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id)) return;
    if (g.ask.finalized[g.v.i] || !visibleQuestions(g.ask.req, g.ask.answers)[g.v.i]) { await alreadySaved(g.ask, respond); return; }
    const field = g.ask.req.questions[g.v.i]?.field;
    if (!field || field.type === "external" || field.required) return;
    g.ask.answers[g.v.i] = []; g.ask.finalized[g.v.i] = true; g.ask.page = 0;
    await submitAskIfComplete(g.ask, g.url);
  });

  app.action(/^qpage_(prev|next)$/, async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || !Number.isSafeInteger(g.v.page) || g.v.page! < 0) return;
    g.ask.page = g.v.page;
    changedQuestion(g.ask, false);
    await Promise.all(renderAskBoth(g.ask));
  });
  app.action("qretry", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond, true);
    if (!g) return;
    const result = await submitAskIfComplete(g.ask, g.url);
    if (result === "failed") await respond({ text: "Answer not confirmed. Retry submission reconciles it before sending again.", response_type: "ephemeral" });
  });
  app.action("qedit", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id)) return;
    g.ask.finalized.fill(false); g.ask.page = 0;
    changedQuestion(g.ask);
    await Promise.all(renderAskBoth(g.ask));
  });
  app.action("qexternal", async ({ ack }) => { await ack(); });

  app.action("qtext", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (stopping) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const { v, ask } = g;
    const q = ask.req.questions[v.i!];
    if (!q || !q.custom || ask.finalized[v.i] || !visibleQuestions(ask.req, ask.answers)[v.i]) { await alreadySaved(ask, respond); return; }
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
          title: { type: "plain_text", text: Array.from(q.header).slice(0, 24).join("") || "Your answer" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "qtext_input",
              label: { type: "plain_text", text: Array.from(q.question).slice(0, 2000).join("") || "Your answer" },
              optional: false,
              element: {
                type: "plain_text_input",
                action_id: "qtext_field",
                placeholder: { type: "plain_text", text: "Type your own answer…" },
                ...(ask.answers[v.i]?.length && !q.multiple ? { initial_value: ask.answers[v.i]![0] } : {}),
                multiline: true,
              },
            },
          ],
          private_metadata: JSON.stringify({ s: v.s, q: v.q, i: v.i, g: ask.generation, b: questionBindingToken(ask), c: ask.presentation, revision: ask.draftRevision }),
        },
      })
      .catch(async (err) => {
        logErr(`question modal failed: ${String((err as Error)?.message ?? err)}`);
        await respond({ text: "Couldn't open the answer form. Please tap Type your answer again.", response_type: "ephemeral" }).catch(() => {});
      });
  });

  app.view("qtext_submit", async ({ ack, body, view }) => {
    if (stopping) { await ack(); return; }
    if (body.user.id !== config.ownerSlackUserId) {
      await ack({ response_action: "errors", errors: { qtext_input: "Only the paired owner can answer." } });
      return;
    }
    let v: { s: string; q: string; i: number; g: number; b: string; c?: number; revision: number };
    try {
      v = JSON.parse(view.private_metadata ?? "") as typeof v;
      if (!v || typeof v.s !== "string" || typeof v.q !== "string") throw new Error("Invalid modal identity");
    } catch {
      await ack({ response_action: "errors", errors: { qtext_input: "This form is outdated. Close it and use the latest question card." } });
      return;
    }
    const text = String(view.state?.values?.qtext_input?.qtext_field?.value ?? "").trim();
    if (!text) {
      await ack({ response_action: "errors", errors: { qtext_input: "Answer can't be empty." } });
      return;
    }
    const bound = state.findThreadBySession(v.s);
    const ask = quesAsks.get(v.q);
    if (!bound || !ask || ask.sessionId !== v.s || !isPending(ask, "question") || !Number.isSafeInteger(v.i) ||
      v.g !== ask.generation || v.b !== questionBindingToken(ask) || (v.c ?? 0) !== ask.presentation || v.revision !== ask.draftRevision || !ask.req.questions[v.i]?.custom ||
      ask.finalized[v.i] || !visibleQuestions(ask.req, ask.answers)[v.i] || ask.response !== "pending") {
      await ack({ response_action: "errors", errors: { qtext_input: "This question changed or was already answered. Close this form and use the latest card." } }); return;
    }
    if (questionLocks.has(ask.id)) { await ack({ response_action: "errors", errors: { qtext_input: "An answer is already being submitted." } }); return; }
    const entry = pool.get(bound.thread.projectDir);
    if (!entry?.client) { await ack({ response_action: "errors", errors: { qtext_input: "OpenCode is reconnecting. Please retry shortly." } }); return; }
    const answers = structuredClone(ask.answers);
    answers[v.i] = ask.req.questions[v.i]?.multiple ? [...new Set([...answers[v.i]!, text])] : [text];
    try { if (ask.req.form) formAnswer(ask.req, answers); }
    catch (err) { await ack({ response_action: "errors", errors: { qtext_input: String((err as Error).message) } }); return; }
    ask.answers = answers;
    ask.finalized[v.i] = true;
    ask.page = 0;
    try { changedQuestion(ask); }
    catch (err) {
      await ack({ response_action: "errors", errors: { qtext_input: "Couldn't save your answer. Please retry." } });
      logErr(`question save failed: ${String(err)}`); return;
    }
    await ack();
    const r = await submitAskIfComplete(ask, entry.client);
    if (r === "failed") {
      await render.post(ask.channel, ask.threadTs, "Answer not confirmed. Tap Retry submission to reconcile it before trying again.", undefined, { lane: "interactive" }).catch(() => {});
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
          { channel: dmChannelId!, method: "files.upload", lane: "interactive", timeoutMs: SLACK_UPLOAD_TIMEOUT_MS, retryRateLimits: false },
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
    fetchReplies: async (channel, rootTs, oldest, { maxPages, latest, inclusive, cursor: startCursor }) => {
      const out: SlackMsg[] = [];
      let cursor: string | undefined = startCursor;
      let pagesUsed = 0;
      let hasMore = false;
      do {
        // Background: a sweep can fan out across ~10 threads — it must
        // never hold up commands/prompts in their channels (issue #5).
        const r = (await enqueue(
          () => app.client.conversations.replies({ channel, ts: rootTs, oldest, latest, inclusive, limit: 100, ...(cursor ? { cursor } : {}) }),
          { channel, method: "conversations.replies", lane: "background" },
        )) as { messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
        out.push(...((r.messages ?? []) as SlackMsg[]));
        pagesUsed++;
        cursor = r.response_metadata?.next_cursor || undefined;
        hasMore = !!cursor || !!r.has_more;
      } while (cursor && pagesUsed < maxPages && !stopping);
      return { messages: out.sort((a, b) => compareTs(a.ts, b.ts)), hasMore, pagesUsed, nextCursor: cursor };
    },
    dispatch: (m, context) => stopping ? Promise.resolve("retry" as const) : handleIncomingMessage(m, bridge, context),
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
      const pending = state.messageReceipts().filter(r => {
        if (r.disposition !== "uncertain" || !r.submission || !isRecentRecoveryEligibleReceipt(r, state.now())) return false;
        const thread = state.getThread(r.threadKey);
        const canceled = state.cancellationThrough(r.threadKey);
        return thread?.sessionId === r.submission.sessionId && thread.projectDir === r.submission.projectDir &&
          isRecentRecoveryEligibleThread(thread, state.now()) && (!canceled || compareTs(r.ts, canceled) > 0) &&
          (r.generation === undefined || r.generation === state.bindingGeneration(r.threadKey));
      });
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
  const recovered = await recoverInterruptedRuns({ state, pool, render, isStopping: () => stopping });
  pushLog(`boot recovery: ${JSON.stringify(recovered)}`);
  interactionsEnabled = true;
  // Interactions are now safe to restore, and poll independently of catch-up scans.
  const interactions = setInterval(() => { void refreshPermissions().catch(err => logErr(`interaction recovery: ${String(err)}`)); }, 30_000);
  interactions.unref();
  cleanup.push(() => clearInterval(interactions));
  // Only enable intake after cleaning the previous process's tombstones. A
  // fresh prompt delivered during app.start must never join the interrupt sweep.
  if (stopping) return;
  await app.start();
  if (stopping) return;
  const onConnected = () => {
    if (stopping) return;
    noteSlackOnline();
    void scheduledReports?.poll().catch(err => logErr(`scheduled report reconnect: ${String(err)}`));
    void runCatchup();
    void refreshPermissions(true).catch(err => logErr(`interaction reconnect recovery: ${String(err)}`));
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
  socketSupervisor.start();
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
  void refreshPermissions().catch(err => logErr(`interaction boot recovery: ${String(err)}`));

  // Kick the current project's server so the first prompt is snappy.
  void pool.ensure(state.currentProjectDir!).catch(() => {});
  // Explicit resumed forms can outlive a stopped prompt in another location.
  // Warm only their still-authorized bindings; this never submits a prompt.
  const questionDirs = new Set(questionStore.list().filter(r => r.response !== "resolved" && resumedQuestionEligible(r)).map(r => r.projectDir));
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
