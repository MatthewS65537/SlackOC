import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { App, LogLevel } from "@slack/bolt";
import { loadConfig, PID_PATH, CONFIG_PATH, STATE_PATH } from "./config.js";
import { StateStore } from "./state.js";
import { ServerPool } from "./opencode/server.js";
import { permRespond, sessionDiff, pendingQuestions, questionReply, questionReject } from "./opencode/client.js";
import { noteSessionActivity } from "./commands/picker.js";
import {
  permissionBlocks,
  permissionResultText,
  questionBlocks,
  VIEW_DIFF_ACTION,
  type PermButtonValue,
  type QuestionButtonValue,
} from "./slack/blocks.js";
import { handleIncomingMessage, type BridgeDeps, type SlackMsg } from "./slack/router.js";
import { buildUnifiedDiff, formatDiffSummary } from "./commands/handlers.js";
import { finalizeViewsForProject, getView, hasActiveViewForProject, reconcileStaleViews } from "./slack/render.js";
import type { RenderDeps } from "./slack/render.js";
import { sweepMissedMessages, type CatchupDeps } from "./slack/catchup.js";
import { GhostDetector } from "./ghosts.js";
import { enqueue } from "./slack/queue.js";
import { enableFileLog, logErr, pushLog, ringLogger } from "./log.js";
import { normalizePermission, type OcPermission, type OcQuestionRequest } from "./opencode/api.js";

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
  // A stray async bug must never silently kill the one process whose whole
  // job is answering Slack (Node's default for unhandled rejections is to
  // crash). Surface it in \logs and keep serving.
  process.on("unhandledRejection", (err) => {
    logErr(`unhandled rejection: ${String((err as Error)?.stack ?? err).slice(0, 400)}`);
  });
  // A SYNC throw through the event loop leaves the process in an undefined
  // state — die LOUDLY instead: the stack lands in bridge.log via logErr (a
  // detached daemon must be noticed, not limp half-wedged). After exit the
  // pidfile is stale; claimPidfile replaces it on the next start.
  process.on("uncaughtException", (err) => {
    logErr(`uncaught exception: ${String((err as Error)?.stack ?? err).slice(0, 400)}`);
    process.exit(1);
  });
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
  const state = new StateStore(STATE_PATH);
  // The launch cwd owns the default project on EVERY start. currentProjectDir
  // persists across runs (set by \cd / \new / \project), so it must not be
  // allowed to override where the server was launched — \cd et al. still move
  // the default mid-run; existing threads keep their own bound dir.
  state.setCurrentProject(opts.cwd);

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    // Socket layer diagnostics (connect/disconnect/ping timeouts) go to \logs,
    // not an unwatched console — the first thing to check when inbound stops.
    logger: ringLogger(),
    logLevel: LogLevel.INFO,
  });

  // All outbound Slack calls go through the per-channel, two-tier queue
  // (slack/queue.ts): ~1/s pacing per channel lane, interactive ops ahead of
  // background stream traffic, a shared 429 brake, and a per-op timeout so
  // one stalled call can never freeze its lane.
  let dmChannelId: string | null = null; // owner DM channel, opened post-auth
  let teamUrl: string | undefined; // for thread permalinks in DMs
  const render: RenderDeps = {
    post: async (channel, threadTs, text, blocks, opts) => {
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
        { channel: channelId, lane },
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

  // Seen permission IDs so duplicates (SSE reconnect replays, plus our own
  // answer echoing back as permission.replied) don't repost the same ask.
  const seenPerms = new Set<string>();
  /** Pending permission-ask nudges — cleared when the owner answers. */
  const permNudges = new Map<string, NodeJS.Timeout>();
  // Same dedupe/nudge pattern for the question tool (issue #2): a parked
  // question blocks its run server-side, so a missed/replayed ask must not
  // repost, and a sitting ask gets the same two 3-min nudges as permissions.
  const seenQuestions = new Set<string>();
  const quesNudges = new Map<string, NodeJS.Timeout>();

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
      void reconcileStaleViews(0, dir).then((n) => {
        if (n) pushLog(`reconciler finalized ${n} stale run(s) for ${dir}`);
      });
    },
    // A server just became ready: sweep for parked questions that outlived a
    // bridge restart and re-post the asks for bound sessions (issue #2).
    (dir, baseUrl) => {
      void sweepQuestions(dir, baseUrl);
    },
  );

  // Idle-server reaper: an untouched opencode serve stays resident forever on
  // an always-on box. Stop servers idle >30 min with no active views; they
  // respawn lazily on demand. unref'd so it never keeps the process alive.
  const reaper = setInterval(() => {
    const n = pool.reapIdle(IDLE_SERVER_TTL_MS, hasActiveViewForProject);
    if (n) pushLog(`idle reaper: stopped ${n} idle opencode server(s)`);
  }, REAPER_INTERVAL_MS);
  reaper.unref();

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

  /** Live permission asks, so an answer can update BOTH the thread and DM copies. */
  const permAsks = new Map<string, { channel: string; threadTs: string; askTs: string | null; dmTs: string | null }>();

  /**
   * Live question asks. `req` is the full stored ask (options resolved from
   * here, not from the button value); `answers` accumulates one label-array
   * per question as the owner taps — when every question has one, we reply.
   */
  const quesAsks = new Map<
    string,
    { req: OcQuestionRequest; answers: string[][]; channel: string; threadTs: string; askTs: string | null; dmTs: string | null }
  >();

  async function onPoolEvent(dir: string, eventType: string, props: Record<string, unknown>): Promise<void> {
    try {
      // Both event names: ≤1.18.25 emits permission.updated, ≥1.18.2x emits
      // permission.asked (auto-update renamed it). The adapter normalizes the
      // differing payloads onto one OcPermission the rest of the flow consumes.
      if (eventType === "permission.updated" || eventType === "permission.asked") {
        await onPermission(normalizePermission(props));
        return;
      }
      // Question tool (issue #2): the server parks a blocking question and
      // emits question.asked. Intercepted here (like permissions) so it never
      // reaches the view's default: drop — the run would hang with no way to
      // answer. replied/rejected echoes resolve the posted copies idempotently.
      if (eventType === "question.asked") {
        await onQuestion(props as unknown as OcQuestionRequest);
        return;
      }
      if (eventType === "question.replied" || eventType === "question.rejected") {
        const rid = (props.requestID as string | undefined) ?? (props.id as string | undefined);
        if (rid) await onQuestionResolved(rid, eventType === "question.rejected" ? "rejected" : "replied");
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

  async function onPermission(perm: OcPermission): Promise<void> {
    if (!perm?.id || seenPerms.has(perm.id)) return;
    seenPerms.add(perm.id);
    if (seenPerms.size > 500) {
      const first = seenPerms.values().next().value;
      if (first) seenPerms.delete(first);
    }
    const bound = state.findThreadBySession(perm.sessionID);
    if (!bound) return; // permission for a session not driven from Slack — ignore
    const [channel, threadTs] = bound.key.split(":") as [string, string];
    const header = `:rotating_light: *OpenCode wants permission* — ${perm.type}:${perm.title}`;
    const blocks = permissionBlocks(perm) as never;
    // Interactive lane: the run is BLOCKED on this ask — the owner is
    // actively waiting on it, so it jumps ahead of background stream traffic.
    let askTs: string | null = null;
    try {
      askTs = (await render.post(channel, threadTs, header, blocks, { unfurl: false, lane: "interactive" })).ts;
    } catch {
      /* thread ask failed — DM below may still reach the owner */
    }
    // Mirror the ask (buttons included) into the owner's DMs — on a phone,
    // this is the only notification that a run is blocked waiting for approval.
    let dmTs: string | null = null;
    try {
      dmTs = (await render.dm?.(channel, threadTs, header, blocks, { lane: "interactive" }))?.ts ?? null;
    } catch {
      pushLog(`permission DM failed (${perm.id}): DM channel unavailable`);
    }
    permAsks.set(perm.id, { channel, threadTs, askTs, dmTs });
    if (permAsks.size > 200) {
      const first = permAsks.keys().next().value;
      if (first) permAsks.delete(first);
    }
    // Nudge twice (3 min apart) if the ask sits unanswered; cleared on answer.
    const nudge = (remaining: number): void => {
      permNudges.set(
        perm.id,
        setTimeout(() => {
          if (!seenPerms.has(perm.id)) {
            permNudges.delete(perm.id);
            return;
          }
          void render
            .post(channel, threadTs, ":alarm_clock: Still waiting on this permission — Approve or Deny above.", undefined, {
              unfurl: false,
            })
            .catch(() => {});
          if (remaining > 0) nudge(remaining - 1);
          else permNudges.delete(perm.id);
        }, 180_000),
      );
    };
    nudge(1);
  }

  /**
   * A parked question (issue #2). Mirrors onPermission: dedupe, find the bound
   * thread, post the interactive blocks to the thread + owner DM, track both
   * copies, and nudge twice if it sits unanswered. The run is BLOCKED
   * server-side until the owner taps an option or Skip.
   */
  async function onQuestion(req: OcQuestionRequest): Promise<void> {
    if (!req?.id || seenQuestions.has(req.id)) return;
    seenQuestions.add(req.id);
    if (seenQuestions.size > 500) {
      const first = seenQuestions.values().next().value;
      if (first) seenQuestions.delete(first);
    }
    const bound = state.findThreadBySession(req.sessionID);
    if (!bound) return; // question for a session not driven from Slack — ignore
    const [channel, threadTs] = bound.key.split(":") as [string, string];
    const header = `❓ *OpenCode has a question* — ${req.questions.length} to answer`;
    const blocks = questionBlocks(req, []) as never;
    // Interactive lane: the run is BLOCKED on this question (like permissions).
    let askTs: string | null = null;
    try {
      askTs = (await render.post(channel, threadTs, header, blocks, { unfurl: false, lane: "interactive" })).ts;
    } catch {
      /* thread ask failed — DM below may still reach the owner */
    }
    let dmTs: string | null = null;
    try {
      dmTs = (await render.dm?.(channel, threadTs, header, blocks, { lane: "interactive" }))?.ts ?? null;
    } catch {
      pushLog(`question DM failed (${req.id}): DM channel unavailable`);
    }
    quesAsks.set(req.id, { req, answers: req.questions.map(() => []), channel, threadTs, askTs, dmTs });
    if (quesAsks.size > 200) {
      const first = quesAsks.keys().next().value;
      if (first) quesAsks.delete(first);
    }
    const nudge = (remaining: number): void => {
      quesNudges.set(
        req.id,
        setTimeout(() => {
          if (!seenQuestions.has(req.id)) {
            quesNudges.delete(req.id);
            return;
          }
          void render
            .post(channel, threadTs, ":alarm_clock: Still waiting on this question — pick an option or Skip above.", undefined, {
              unfurl: false,
            })
            .catch(() => {});
          if (remaining > 0) nudge(remaining - 1);
          else quesNudges.delete(req.id);
        }, 180_000),
      );
    };
    nudge(1);
  }

  /**
   * A parked question resolved (owner tapped, or an SSE replied/rejected echo).
   * Idempotent: clears tracking + nudges and collapses both copies to a final
   * line. Safe to call from the action handler AND the SSE echo.
   */
  async function onQuestionResolved(requestId: string, kind: "replied" | "rejected"): Promise<void> {
    const nudge = quesNudges.get(requestId);
    if (nudge) {
      clearTimeout(nudge);
      quesNudges.delete(requestId);
    }
    const ask = quesAsks.get(requestId);
    quesAsks.delete(requestId);
    const line =
      kind === "rejected"
        ? ":arrow_forward: Skipped — OpenCode continuing."
        : ":white_check_mark: Answered — OpenCode continuing.";
    const updateOne = (ch: string, ts: string): Promise<unknown> =>
      render.update(ch, ts, line).catch(() => {});
    const updates: Promise<unknown>[] = [];
    if (ask?.askTs) updates.push(updateOne(ask.channel, ask.askTs));
    if (ask?.dmTs && dmChannelId) updates.push(updateOne(dmChannelId, ask.dmTs));
    await Promise.all(updates);
  }

  /**
   * Boot recovery (issue #2): a parked question outlived a bridge restart (the
   * opencode server is a detached child that can survive an unclean bridge
   * death). When a server first becomes ready, list its pending questions and
   * re-post the asks for bound sessions. onQuestion dedupes (seenQuestions)
   * and skips unbound sessions itself, so this just fans out.
   */
  async function sweepQuestions(dir: string, baseUrl: string): Promise<void> {
    let list: OcQuestionRequest[];
    try {
      list = await pendingQuestions(baseUrl);
    } catch (err) {
      pushLog(`question sweep failed for ${dir}: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    for (const req of list) {
      await onQuestion(req);
    }
  }

  const botAuth = await app.client.auth.test().catch((err) => {
    console.error("Slack auth.test failed — check SLACK_BOT_TOKEN:", err);
    return null;
  });
  if (!botAuth) {
    process.exitCode = 1;
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

  const bridge: BridgeDeps = {
    config,
    state,
    pool,
    render,
    botUserId,
    cwd: opts.cwd,
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
    const e = event as unknown as import("./slack/router.js").SlackMsg;
    pushLog(`in: app_mention ${e.channel}:${e.ts}`);
    ghost.noteLive();
    await handleIncomingMessage(e, bridge).catch((err) => console.error(err));
  });

  app.action("perm", async ({ ack, body, action, client, respond }) => {
    await ack();
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
    const entry = await pool.ensure(bound.thread.projectDir);
    try {
      await permRespond(entry.client!, v.s, v.p, v.r);
    } catch (err) {
      logErr(`permission respond failed: ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Failed to reply to OpenCode: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
      return;
    }
    // Keep the answered id in seenPerms: an SSE replay of the ask must not re-post it.
    const pending = permNudges.get(v.p);
    if (pending) {
      clearTimeout(pending);
      permNudges.delete(v.p);
    }
    // Update BOTH copies of the ask (thread + owner DM) to the result, no
    // matter which button was tapped. Fall back to the clicked message when
    // the ask wasn't tracked (bridge restarted between ask and answer).
    const result = permissionResultText(v.r, body.user.id);
    const updateOne = (ch: string, ts: string): Promise<unknown> =>
      client.chat
        .update({ channel: ch, ts, text: result, blocks: [{ type: "section", text: { type: "mrkdwn", text: result } }] })
        .catch(() => {});
    const ask = permAsks.get(v.p);
    permAsks.delete(v.p);
    const updates: Promise<unknown>[] = [];
    if (ask?.askTs) updates.push(updateOne(ask.channel, ask.askTs));
    if (ask?.dmTs && dmChannelId) updates.push(updateOne(dmChannelId, ask.dmTs));
    if (!updates.length) {
      const ch = (body as unknown as { channel?: { id: string } }).channel?.id;
      const ts =
        (body as unknown as { container?: { message_ts?: string } }).container?.message_ts ??
        (body as unknown as { message?: { ts?: string } }).message?.ts;
      if (ch && ts) updates.push(updateOne(ch, ts));
    }
    await Promise.all(updates);
  });

  // Question tool (issue #2): owner taps an option (single-select, one tap per
  // question) or Skip. Labels are resolved from the stored ask, so the button
  // value stays tiny. When every question is answered we send the full matrix;
  // the SSE question.replied/rejected echo then collapses both copies too.
  app.action("question", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can answer OpenCode questions.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const raw = (action as { value?: string }).value;
    if (!raw) return;
    let v: QuestionButtonValue;
    try {
      v = JSON.parse(raw) as QuestionButtonValue;
    } catch {
      return;
    }
    const bound = state.findThreadBySession(v.s);
    if (!bound) {
      await respond({ text: "That session is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const ask = quesAsks.get(v.q);
    if (!ask) {
      await respond({ text: "That question is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const entry = await pool.ensure(bound.thread.projectDir);
    if (!entry.url) {
      await respond({ text: "The OpenCode server isn't ready yet — try again in a moment.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    // Re-render BOTH copies (thread + owner DM) with the current answer matrix.
    const updateBoth = (blocks: unknown[]): Promise<unknown>[] => {
      const one = (ch: string, ts: string) =>
        client.chat.update({ channel: ch, ts, text: "OpenCode question", blocks: blocks as never }).catch(() => {});
      const u: Promise<unknown>[] = [];
      if (ask.askTs) u.push(one(ask.channel, ask.askTs));
      if (ask.dmTs && dmChannelId) u.push(one(dmChannelId, ask.dmTs));
      return u;
    };

    if (v.a === -1) {
      // Skip (reject): unblock the run, collapse both copies to a final line.
      try {
        await questionReject(entry.url, v.q);
      } catch (err) {
        logErr(`question reject failed: ${String((err as Error)?.message ?? err)}`);
        await respond({ text: `Failed to skip the question: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
        return;
      }
      await onQuestionResolved(v.q, "rejected");
      return;
    }

    // Option tap: record the label for this question (single-select: one tap).
    const label = ask.req.questions[v.i]?.options[v.a]?.label;
    if (label == null) return;
    ask.answers[v.i] = [label];
    if (!ask.req.questions.every((_, qi) => ask.answers[qi]?.length)) {
      // More questions open — re-render both copies (answered ones collapse).
      await Promise.all(updateBoth(questionBlocks(ask.req, ask.answers)));
      return;
    }
    // All answered — send the full matrix, then collapse both copies.
    try {
      await questionReply(entry.url, v.q, ask.answers);
    } catch (err) {
      logErr(`question reply failed: ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Failed to send your answer: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
      // Keep it tracked + re-render so the owner can retry or Skip.
      await Promise.all(updateBoth(questionBlocks(ask.req, ask.answers)));
      return;
    }
    await onQuestionResolved(v.q, "replied");
  });

  // RF1: "📄 View diff" button on completion DMs → post the session's diff
  // (same rendering rules as \diff full: stat lines, inline diff ≤3.5k, else a
  // .diff snippet upload to the DM).
  app.action(VIEW_DIFF_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
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
          { channel: dmChannelId!, lane: "interactive" },
        );
      }
    } catch (err) {
      logErr(`view_diff action failed (${sessionId}): ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Couldn't fetch the diff: ${String((err as Error)?.message ?? err).slice(0, 200)}`, response_type: "ephemeral" }).catch(() => {});
    }
  });

  await app.start();

  // Missed-message catch-up (see slack/catchup.ts): Slack discards socket-mode
  // envelopes it can't deliver and never replays them — a restart gap, network
  // flap, or zombie connection otherwise leaves a thread permanently silent
  // while outbound posts still work. This backstop bounds the damage to
  // ≤ ~1 min of latency: bound threads are re-read from conversations.replies
  // past their watermark and unprocessed owner messages route through the
  // exact same handler as live socket deliveries.
  const catchupDeps: CatchupDeps = {
    state,
    ownerSlackUserId: config.ownerSlackUserId,
    fetchReplies: async (channel, rootTs, oldest): Promise<SlackMsg[]> => {
      const out: SlackMsg[] = [];
      let cursor: string | undefined;
      do {
        // Background: the 60s sweep can fan out across ~10 threads — it must
        // never hold up commands/prompts in their channels (issue #5).
        const r = (await enqueue(
          () => app.client.conversations.replies({ channel, ts: rootTs, oldest, inclusive: false, limit: 100, ...(cursor ? { cursor } : {}) }),
          { channel, lane: "background" },
        )) as { messages?: unknown[]; response_metadata?: { next_cursor?: string } };
        out.push(...((r.messages ?? []) as SlackMsg[]));
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    },
    dispatch: (m) => handleIncomingMessage(m, bridge),
  };
  const runCatchup = async (boot = false): Promise<void> => {
    try {
      const n = await sweepMissedMessages(catchupDeps);
      if (n && !boot) ghost.noteReplayed(n); // boot pass replays are the restart gap, not a ghost
      const warn = ghost.check();
      if (warn) logErr(warn);
    } catch (err) {
      logErr(`catch-up sweep failed: ${String((err as Error)?.message ?? err)}`);
    }
  };
  const catchup = setInterval(() => void runCatchup(), 60_000);
  catchup.unref();

  // Interrupt sweep: any thread with a pendingRun tombstone was mid-run when
  // the bridge last stopped (crash / slackoc stop / host reboot). Resolve the
  // orphaned ⏳/✅ lifecycle so users aren't staring at a frozen status.
  const interrupted = state.threadsWithPendingRun();
  if (interrupted.length) {
    pushLog(`interrupt sweep: ${interrupted.length} thread(s) had a run in flight at shutdown`);
    for (const { key, thread } of interrupted) {
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
          ":warning: bridge restarted — the run in progress here was interrupted. Resend your prompt to retry.",
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
  void runCatchup(true);

  // Pidfile was claimed before app.start() (see top of startBridge) — the
  // shutdown handler owns removing it.
  const shutdown = () => {
    console.error("\nslackoc stopping…");
    clearInterval(reaper);
    clearInterval(reconciler);
    clearInterval(catchup);
    void (async () => {
      try {
        await pool.killAll();
        await app.stop();
      } finally {
        rmSync(PID_PATH, { force: true });
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Kick the current project's server so the first prompt is snappy.
  void pool.ensure(state.currentProjectDir!).catch(() => {});

  pushLog(`slackoc online as @${botAuth.user ?? "bot"} in ${botAuth.team ?? "workspace"}`);
  console.error(`✓ slackoc online as @${botAuth.user ?? "bot"} in ${botAuth.team ?? "workspace"}`);
  console.error(`  current project: ${state.currentProjectDir}`);
  console.error(`  config: ${CONFIG_PATH}`);
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

/**
 * Atomically claim the pidfile for this process. "running" = a live bridge
 * holds it; "starting" = a concurrent start beat us to the atomic write
 * (wx fails on EEXIST). Stale pidfiles (dead pid) are replaced.
 */
export function claimPidfile(pidPath: string): PidClaim {
  const existing = readPid(pidPath);
  if (existing && processAlive(existing)) return "running";
  rmSync(pidPath, { force: true });
  mkdirSync(dirname(pidPath), { recursive: true });
  try {
    writeFileSync(pidPath, String(process.pid), { flag: "wx", mode: 0o600 });
    return "claimed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return "starting";
    throw err;
  }
}

export async function stopBridge(): Promise<void> {
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
