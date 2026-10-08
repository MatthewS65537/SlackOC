import type { SocketHealth } from "./socket-supervisor.js";
import type { SlackocConfig } from "../config.js";
import { randomBytes } from "node:crypto";
import { promptAsync, sessionCreate } from "../opencode/client.js";
import type { ServerPool } from "../opencode/server.js";
import type { StateStore, ThreadState } from "../state.js";
import { execute, type CmdCtx, type PermissionCommands } from "../commands/registry.js";
import { parseBackslash } from "../commands/parse.js";
import "../commands/handlers.js"; // registers all commands on import
import { SessionView, getView, reactLogged, type RenderDeps } from "./render.js";
import { slackToPlain, truncate } from "../util.js";
import { canonicalDir } from "../paths.js";
import { logErr, pushLog } from "../log.js";
import { abortableFetch } from "../http.js";
import { classifyRecovery, timestampMicros, type IncomingContext, type RecoveryDecision } from "./recovery-policy.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_DOWNLOAD_BYTES,
  MAX_IMAGE_EDGE,
  TARGET_IMAGE_BYTES,
  readImage,
  shrinkImage,
} from "../image.js";

/** Loose structural shape of a Bolt message/app_mention event we handle. */
export interface SlackMsg {
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  channel_type?: string;
  bot_id?: string;
  /** Present whenever the user attached files. NOTE: newer Slack clients
   *  upload images with NO subtype at all (subtype-less file_share) — gate on
   *  this array's presence, never on `subtype === "file_share"` (live bug). */
  files?: Array<{
    mimetype?: string;
    name?: string;
    url_private_download?: string;
    size?: number;
  }>;
}

/** One image to attach to the outgoing prompt (data-URI form for OpenCode). */
export interface ImagePart {
  mime: string;
  filename: string;
  dataUrl: string;
}

export interface BridgeDeps {
  config: SlackocConfig;
  state: StateStore;
  pool: ServerPool;
  render: RenderDeps;
  botUserId: string;
  cwd: string;
  isStopping?: () => boolean;
  /** Bridge self-report for \status (uptime, owner-DM reachability). */
  bridgeInfo?: { startedAt: number; dmAvailable: () => boolean; socket?: () => SocketHealth | undefined };
  /** Archives permalink for a state threadKey — null when the team URL is unknown. */
  threadUrl?: (threadKey: string) => string | null;
  permissions?: PermissionCommands;
  questions?: CmdCtx["questions"];
  resumeQuestions?: CmdCtx["resumeQuestions"];
  schedules?: CmdCtx["schedules"];
  ownerDmChannel?: () => string | null;
}

function threadRootTs(msg: SlackMsg): string {
  return msg.thread_ts ?? msg.ts;
}

/**
 * Slack Events often delivers the same message twice (a thread reply that
 * @mentions the bot arrives as both `message` and `app_mention`; Socket Mode
 * also retries on slow acks). Legacy utility retained for callers; the router
 * itself uses StateStore.claimMessage's durable evidence, not this TTL cache.
 */
const claimedEvents = new Map<string, number>();

export function claimEvent(channel: string, ts: string): boolean {
  const key = `${channel}:${ts}`;
  const now = Date.now();
  if ((claimedEvents.get(key) ?? 0) > now - 60_000) return false;
  claimedEvents.set(key, now);
  if (claimedEvents.size > 500) {
    for (const [k, t] of claimedEvents) if (t <= now - 60_000) claimedEvents.delete(k);
  }
  return true;
}

/** What to do with a message arriving in a (possibly hushed) thread. */
export type HushAction = "proceed" | "ignore" | "unhush";

export function hushAction(
  thread: { hushed?: boolean } | null,
  explicitMention: boolean,
  isCommand: boolean,
): HushAction {
  if (!thread?.hushed) return "proceed";
  if (explicitMention) return "unhush"; // a deliberate @ always wakes the thread
  return isCommand ? "proceed" : "ignore";
}

/** Strip <@BOT> (and other) mention tokens; returns the cleaned text. */
export function cleanMentionText(text: string, botUserId: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/** Mimetype allowlist for user-attached files forwarded to OpenCode. */
function attachable(mime: string | undefined): boolean {
  const mt = mime ?? "";
  return (
    mt.startsWith("image/") ||
    mt.startsWith("text/") ||
    mt === "application/pdf" ||
    mt === "application/json"
  );
}

/**
 * Central message gate. THE SECURITY INVARIANT: events from any user other
 * than the paired owner are dropped before anything else happens.
 */
export type IncomingOutcome = "accepted" | "processing" | "uncertain" | "retry" | "paused" | "ignored" | "held" | "expired" | "canceled";
interface ProcessingAttempt { effectsStarted: boolean; context: IncomingContext }
class RecoveryBlocked extends Error {
  constructor(readonly verdict: RecoveryDecision) { super(verdict.reason); }
}

function checkSubmission(msg: SlackMsg, d: BridgeDeps, attempt: ProcessingAttempt): void {
  const key = d.state.threadKey(msg.channel, threadRootTs(msg));
  const verdict = classifyRecovery({ ts: msg.ts, thread: d.state.getThread(key), receipt: d.state.getReceipt(key, msg.ts),
    now: d.state.now(), context: attempt.context, ownClaim: true,
    canceledThroughTs: d.state.cancellationThrough(key),
    command: parseBackslash(cleanMentionText(slackToPlain(msg.text ?? ""), d.botUserId))?.name });
  if (verdict.decision !== "recover") throw new RecoveryBlocked(verdict);
}

export async function handleIncomingMessage(msg: SlackMsg, d: BridgeDeps, context: IncomingContext = { source: "live" }): Promise<IncomingOutcome> {
  if (d.isStopping?.()) return "retry";
  // file_share is the only subtype we let through — it carries user attachments.
  if ((msg.subtype && msg.subtype !== "file_share") || msg.bot_id) return "ignored";
  if (!msg.user || msg.user !== d.config.ownerSlackUserId) return "ignored";

  const threadKey = d.state.threadKey(msg.channel, threadRootTs(msg));
  const parsed = parseBackslash(cleanMentionText(slackToPlain(msg.text ?? ""), d.botUserId));
  const existing = d.state.getReceipt(threadKey, msg.ts);
  const verdict = classifyRecovery({ ts: msg.ts, thread: d.state.getThread(threadKey), receipt: existing, context,
    command: parsed?.name, now: d.state.now(), canceledThroughTs: d.state.cancellationThrough(threadKey) });
  if (verdict.decision !== "recover") {
    if (verdict.reason === "submission_uncertain" && existing?.disposition === "processing") return "processing";
    d.state.recordRecoveryDecision(threadKey, msg.ts, verdict);
    logDecision(msg, d, context, verdict);
    if (verdict.decision === "already_handled") return "accepted";
    if (verdict.reason === "submission_uncertain" && existing) return existing.disposition;
    return verdict.decision;
  }
  const claim = d.state.claimMessage(threadKey, msg.ts, { recoveryCommand: parsed?.name === "restart", source: context.source });
  if (claim !== "claimed") {
    // At hard capacity, status is a read-only escape hatch. Only its Slack reply
    // has best-effort (process-local) dedup; restart NEVER bypasses durable claims.
    if (claim === "paused" && ["status", "permissions", "help"].includes(parsed?.name ?? "")) {
      if (!claimEvent(msg.channel, msg.ts)) return "ignored";
      await execute(parsed!, buildCtx(msg, d, d.state.getThread(threadKey), context.source));
      return "accepted";
    }
    return claim;
  }
  const attempt: ProcessingAttempt = { effectsStarted: false, context: { ...context,
    generation: d.state.bindingGeneration(threadKey) } };
  try {
    d.state.markThreadSeen(threadKey, msg.ts);
    if (context.source === "live" && !parsed) d.state.noteLiveIntent(threadKey);
    const outcome = await processMessage(msg, d, attempt);
    d.state.initializeHistory(threadKey, msg.ts === threadRootTs(msg) ? previousTs(msg.ts) : threadRootTs(msg));
    d.state.markThreadSeen(threadKey, msg.ts);
    if (outcome === "retry") d.state.releaseMessage(threadKey, msg.ts);
    else d.state.settleMessage(threadKey, msg.ts, outcome);
    return d.state.isMessageAccepted(threadKey, msg.ts) ? "accepted" : outcome;
  } catch (err) {
    if (err instanceof RecoveryBlocked) {
      d.state.recordRecoveryDecision(threadKey, msg.ts, err.verdict);
      logDecision(msg, d, context, err.verdict);
      if (!attempt.effectsStarted) d.state.releaseMessage(threadKey, msg.ts);
      const th = d.state.getThread(threadKey);
      if (th) await getView(th.sessionId)?.forgetUnsubmittedPrompt(msg.ts);
      await reactLogged(d.render, msg.channel, msg.ts, "eyes", false);
      return err.verdict.decision === "already_handled" ? "accepted" : err.verdict.decision === "recover" ? "retry" : err.verdict.decision;
    }
    if (d.state.isMessageAccepted(threadKey, msg.ts)) return "accepted";
    const outcome = attempt.effectsStarted ? "uncertain" : "retry";
    if (outcome === "retry") d.state.releaseMessage(threadKey, msg.ts);
    else d.state.settleMessage(threadKey, msg.ts, "uncertain");
    logErr(`message ${msg.channel}:${msg.ts}: ${outcome} — ${String(err)}`);
    await d.render.post(msg.channel, threadRootTs(msg), outcome === "uncertain"
      ? "⚠️ This message may have caused partial side effects. It will not be replayed automatically; inspect the session before sending it again."
      : "⚠️ This message was not submitted. Recovery can retry it once the connection is available.",
    undefined, { unfurl: false, lane: "interactive" }).catch(() => {});
    return outcome;
  }
}

async function processMessage(msg: SlackMsg, d: BridgeDeps, attempt: ProcessingAttempt): Promise<"accepted" | "uncertain" | "retry"> {
  const threadKey = d.state.threadKey(msg.channel, threadRootTs(msg));

  const raw = msg.text ?? "";
  const explicitMention = raw.includes(`<@${d.botUserId}>`);
  // Slack encodes entities (<, >, &) and wraps links in <url|label> markup —
  // decode BEFORE anything else so prompts AND command args see clean text.
  let text = cleanMentionText(slackToPlain(raw), d.botUserId);
  const parsed = text ? parseBackslash(text) : null;

  // Files attached to this message — images AND text/pdf/json. Key off the
  // files array's presence, not the subtype: newer Slack clients send image
  // uploads with subtype ABSENT entirely, and gating on "file_share" silently
  // dropped every such image (live-verified 2026-09-10; the subtype gate
  // above still blocks bot echoes/message_changed before this ever runs).
  const attachments = (msg.files ?? []).filter(
    (f) => attachable(f.mimetype) && !!f.url_private_download,
  );
  if (attachments.length) {
    // Slack wraps attachments in link markup pointing at its file store —
    // unwrap to the plain filename so the model sees a clean caption.
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1").trim();
    if (!text) {
      text = attachments.length === 1 ? "look at this attached file" : "look at these attached files";
    }
  }

  const thread = d.state.getThread(threadKey);

  // An approval context is not an interactive prompt queue. Owner controls
  // remain available, but cannot rebind or mutate a running report session.
  if (d.schedules?.busy(threadKey)) {
    attempt.effectsStarted = true;
    const ctx = buildCtx(msg, d, thread, attempt.context.source);
    if (parsed && ["stop", "abort"].includes(parsed.name)) {
      await d.schedules.cancelThread(threadKey);
      await ctx.postToThread("Scheduled report canceled. Future occurrences are unchanged.");
      return "accepted";
    }
    if (!parsed || !["schedule", "permissions", "permission", "questions", "help", "status", "logs", "history", "summary"].includes(parsed.name)) {
      await ctx.postToThread("This report is still running. Use its approval/question controls, or `\\stop` to cancel; other replies can follow the finished report.");
      return "accepted";
    }
  }

  if (!text) {
    attempt.effectsStarted = true;
    await d.render.post(
      msg.channel,
      threadRootTs(msg),
      "@ mention with a prompt to run OpenCode here and use `\\help` to view commands.",
      undefined,
      { unfurl: false },
    );
    return "accepted";
  }

  const action = hushAction(thread, explicitMention, parsed !== null);
  if (action === "ignore") return "accepted";
  if (action === "unhush" && thread) {
    d.state.setThread(threadKey, { ...thread, hushed: false });
  }

  if (parsed) {
    checkSubmission(msg, d, attempt);
    const replacement = ["new", "unwatch"].includes(parsed.name)
      || (!!parsed.args && ["cd", "project", "projects", "resume", "watch"].includes(parsed.name));
    if (replacement || ["stop", "abort"].includes(parsed.name) || (parsed.name === "hush" && !thread?.hushed))
      d.state.cancelRecovery(threadKey, msg.ts, replacement);
    const ctx = buildCtx(msg, d, thread, attempt.context.source);
    // execute reports failures instead of throwing. Observe its failure reaction
    // so a command that already mutated state never becomes a replayable failure.
    let failed = false;
    const react = ctx.react;
    ctx.react = async (name, add) => {
      if (name === "x" && add !== false) failed = true;
      await react?.(name, add);
    };
    attempt.effectsStarted = true;
    await execute(parsed, ctx);
    if (failed) {
      await ctx.postToThread("⚠️ Command side effects may be partial. Automatic replay is disabled for this message.");
      return "uncertain";
    }
    return "accepted";
  }
   if (!thread?.watchOnly) void reactLogged(d.render, msg.channel, msg.ts, "eyes");
   const fileParts = await downloadAttachments(attachments, msg, d);
  // Every attachment failed to download AND there's no real caption — warnings
  // already posted; a text-only "look at this file" prompt would mislead.
  if (attachments.length && !fileParts.length && !cleanMentionText(slackToPlain(raw), d.botUserId).trim()) return "accepted";
  return runPrompt(text, msg, d, attempt, fileParts);
}

/** Download Slack file attachments and convert to OpenCode data-URI file parts.
 * Files download/shrink in parallel (order preserved); notices are
 * fire-and-forget so a paced Slack post never delays the prompt. */
async function downloadAttachments(
  files: SlackMsg["files"],
  msg: SlackMsg,
  d: BridgeDeps,
): Promise<ImagePart[]> {
  const notify = (text: string): void => {
    void d.render.post(msg.channel, threadRootTs(msg), text, undefined, { unfurl: false })
      .catch(err => logErr(`attachment notice failed: ${String((err as Error)?.message ?? err)}`));
  };
  const results = await Promise.all((files ?? []).map(async (f): Promise<ImagePart | undefined> => {
    try {
      if (d.isStopping?.()) return;
      const res = await abortableFetch(f.url_private_download!, {
        headers: { authorization: `Bearer ${d.config.slackBotToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = f.mimetype ?? "application/octet-stream";
      const filename = f.name ?? "file";
      if (mime.startsWith("image/")) {
        // Provider gateways 413 on large request bodies, and opencode itself
        // re-encodes big-dimension images to PNG before calling the provider
        // (a 694kB/4032px JPEG became a 3.67MB PNG → 5.15MB body → airouter
        // 413, live-verified 2026-09-13). So the shrink trigger is not just
        // bytes — ANY image past the vision-model pixel ceiling (1568px, or
        // byte-heavy) gets JPEG-re-encoded to fit. Undecodable/unshrinkable
        // images skip+warn.
        if (buf.length > MAX_IMAGE_DOWNLOAD_BYTES) {
          notify(`:warning: ${filename} is too large to process (${Math.round(buf.length / 1024 / 1024)} MB) — skipped.`);
          return;
        }
        const decoded = await readImage(buf);
        const longest = decoded ? Math.max(decoded.bitmap.width, decoded.bitmap.height) : 0;
        if (buf.length > TARGET_IMAGE_BYTES || longest > MAX_IMAGE_EDGE) {
          const shrunk = await shrinkImage(buf, mime, filename, TARGET_IMAGE_BYTES, decoded ?? undefined);
          if (shrunk) {
            notify(`:small_orange_diamond: ${filename} was ${Math.round(buf.length / 1024)} kB — compressed to ${Math.round(shrunk.data.length / 1024)} kB to fit.`);
            return { mime: shrunk.mime, filename: shrunk.filename, dataUrl: `data:${shrunk.mime};base64,${shrunk.data.toString("base64")}` };
          }
          notify(`:warning: couldn't compress ${filename} to fit — skipped.`);
          return;
        }
      }
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        notify(`:warning: ${filename} is too large to send (${Math.round(buf.length / 1024)} kB) — skipped.`);
        return;
      }
      return { mime, filename, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (err) {
      notify(`:warning: couldn't attach ${f.name ?? "file"}: ${truncate(String((err as Error)?.message ?? err), 200)}`);
    }
  }));
  return results.filter((p): p is ImagePart => !!p);
}

function buildCtx(msg: SlackMsg, d: BridgeDeps, thread: ThreadState | null = null, source: IncomingContext["source"] = "live"): CmdCtx {
  const threadTs = threadRootTs(msg);
  const threadKey = d.state.threadKey(msg.channel, threadTs);
  return {
    channelId: msg.channel,
    threadTs,
    threadKey,
    permissions: d.permissions,
    questions: d.questions,
    resumeQuestions: d.resumeQuestions,
    ownerDm: msg.channel === d.ownerDmChannel?.(),
    schedules: d.schedules,
    thread,
    state: d.state,
    config: d.config,
    pool: d.pool,
    cwd: d.cwd,
    bridgeInfo: d.bridgeInfo,
    threadUrl: d.threadUrl,
    postToThread: async (extra) => {
      // Interactive: command replies are what the user is actively waiting
      // for — they jump ahead of queued background stream traffic (issue #5).
      await d.render.post(msg.channel, threadTs, extra, undefined, { unfurl: false, lane: "interactive" });
    },
    uploadToThread: async (filename, content) => {
      await d.render.upload({ channelId: msg.channel, threadTs, filename, content, lane: "interactive" });
    },
    react: async (name, add = true) => {
      await reactLogged(d.render, msg.channel, msg.ts, name, add);
    },
    render: d.render,
    ...{ messageTs: msg.ts, source },
  };
}

function logDecision(msg: SlackMsg, d: BridgeDeps, context: IncomingContext, decision: RecoveryDecision): void {
  if (decision.decision === "already_handled") return;
  const micros = timestampMicros(msg.ts);
  const key = d.state.threadKey(msg.channel, threadRootTs(msg));
  logErr(`recovery ${key} · ${msg.ts} · ageMs=${micros === undefined ? "unknown" : d.state.now() - Number(micros / 1000n)} · ${decision.decision} · ${decision.reason} · ${context.source} · generation=${d.state.bindingGeneration(key)}`);
}

/**
 * One session creation per thread at a time. Without this, two quick prompts
 * on an unbound thread (double-send from a phone) both see `thread == null`
 * during the slow cold-start window and each creates a session — the second
 * setThread clobbers the first binding and two runs interleave in one thread.
 * The follower awaits the leader and continues through the normal bound path
 * (picking up the queued-prompt ack from the view the leader created).
 */
const creatingByStore = new WeakMap<StateStore, Map<string, Promise<ThreadState>>>();

/** Older test doubles have ensure only; real pools always reserve a request lease. */
async function acquire(pool: ServerPool, dir: string) {
  return typeof pool.acquire === "function" ? pool.acquire(dir)
    : { entry: await pool.ensure(dir), release: () => {} };
}

/**
 * New root message → fresh OpenCode session in the current project.
 * Thread reply → continue the bound session (or bind a fresh one).
 */
async function runPrompt(text: string, msg: SlackMsg, d: BridgeDeps, attempt: ProcessingAttempt, fileParts: ImagePart[] = []): Promise<"accepted" | "uncertain" | "retry"> {
  if (d.isStopping?.()) return "retry";
  checkSubmission(msg, d, attempt);
  const threadTs = threadRootTs(msg);
  const threadKey = d.state.threadKey(msg.channel, threadTs);
  let creatingThreads = creatingByStore.get(d.state);
  if (!creatingThreads) { creatingThreads = new Map(); creatingByStore.set(d.state, creatingThreads); }

  // \watch gate: this thread is mirroring a session driven on the computer —
  // plain replies would interleave with the TUI's own turns. \ commands pass
  // (execute() never reaches runPrompt); \resume is the takeover path.
  const bound = d.state.getThread(threadKey);
  if (bound?.watchOnly) {
    await d.render.post(
      msg.channel,
      threadTs,
      "👁 This thread is watch-only — the session is being driven on the computer. `\\resume` to take it over here, `\\unwatch` to stop mirroring.",
      undefined,
      { unfurl: false },
    );
    return "accepted";
  }

  // 👀 liveness ack — the owner learns the bridge is up and saw their
  // message even if the run then takes minutes (or fails quietly downstream).
  // Removed at finalize when ✅/❌ lands (one state per message). Best-effort,
  // fire-and-forget: it must never delay or fail the run.

  let thread = d.state.getThread(threadKey);

  if (!thread && creatingThreads.has(threadKey)) {
    // Leader is creating this thread's session right now — wait for it, then
    // re-read state. If the leader failed, fall through and try our own.
    await creatingThreads.get(threadKey)!.catch(() => null);
    thread = d.state.getThread(threadKey);
    if (thread && attempt.context.generation === 0) attempt.context.generation = d.state.bindingGeneration(threadKey);
  }

  // Ack BEFORE any OpenCode work: cold starts (pool ensure + session create)
  // can take seconds of silence. An active view keeps its own status message;
  // otherwise the placeholder is posted now and adopted by the new view.
  let ackTs: string | null = null;
  // SessionView posts its status independently. Slack latency cannot gate admission.

  if (!thread) {
    // The ack above yielded: another message may have installed the creation
    // lock while Slack was posting it. Re-check before starting any creation.
    const creating = creatingThreads.get(threadKey);
    if (creating) {
      await creating.catch(() => null);
      if (attempt.context.generation === 0) attempt.context.generation = d.state.bindingGeneration(threadKey);
    }
    thread = d.state.getThread(threadKey);
  }
  if (d.isStopping?.()) return "retry";
  checkSubmission(msg, d, attempt);
  if (!thread) {
    const dir = canonicalDir(d.state.currentProjectDir ?? d.cwd);
    const create = (async (): Promise<ThreadState> => {
      const lease = await acquire(d.pool, dir);
      try {
        if (d.isStopping?.()) throw new Error("bridge stopping before session creation");
        checkSubmission(msg, d, attempt);
        attempt.effectsStarted = true;
        const sess = await sessionCreate(lease.entry.client!, truncate(text, 60));
        attempt.effectsStarted = false;
        checkSubmission(msg, d, attempt);
        const now = Date.now();
        // Start at the thread boundary; live receipt evidence protects this
        // creating prompt while history can still discover an earlier gap.
        const fresh: ThreadState = { sessionId: sess.id, projectDir: dir, verbose: "on", lastSeenTs: msg.ts,
          historyCursorTs: threadTs === msg.ts ? previousTs(msg.ts) : threadTs, createdAt: now, lastUsedAt: now };
        d.state.setThread(threadKey, fresh);
        attempt.context.generation = d.state.bindingGeneration(threadKey);
        attempt.effectsStarted = false; // binding is durable; retry can reuse it
        return fresh;
      } finally { lease.release(); }
    })();
    creatingThreads.set(threadKey, create);
    try {
      thread = await create;
    } catch (err) {
      if (err instanceof RecoveryBlocked) {
        if (ackTs) await d.render.delete(msg.channel, ackTs).catch(() => {});
        throw err;
      }
      await failBoot(msg, d, ackTs, err);
      throw err;
    } finally {
      creatingThreads.delete(threadKey);
    }
  }

  let lease: Awaited<ReturnType<typeof acquire>>;
  try {
    lease = await acquire(d.pool, thread.projectDir);
  } catch (err) {
    await failBoot(msg, d, ackTs, err);
    return "retry";
  }

  try {
    const entry = lease.entry;
    if (d.isStopping?.()) return "retry";
    checkSubmission(msg, d, attempt);
    let view = getView(thread.sessionId);
    if (!view) {
      view = new SessionView({
        sessionId: thread.sessionId,
        projectDir: thread.projectDir,
        channel: msg.channel,
        threadTs,
        threadKey,
        client: entry.client!,
        deps: d.render,
        state: d.state,
        threadState: thread,
        statusTs: ackTs ?? undefined,
      });
    } else if (ackTs) {
      await d.render.delete(msg.channel, ackTs).catch(() => {});
    }
    await view.beginPrompt(msg.ts);
    if (d.isStopping?.()) return "retry";
    checkSubmission(msg, d, attempt);
    return await sendPrompt(d, thread, text, entry.client!, threadKey, msg, attempt, fileParts);
  } catch (err) {
    if (err instanceof RecoveryBlocked && ackTs) await d.render.delete(msg.channel, ackTs).catch(() => {});
    throw err;
  } finally { lease.release(); }
}

/**
 * Cold-start failure (server spawn or session create) — surface it in Slack
 * (status removed, ❌, error line) instead of dying in the console handler.
 */
async function failBoot(msg: SlackMsg, d: BridgeDeps, ackTs: string | null, err: unknown): Promise<void> {
  if (ackTs) await d.render.delete(msg.channel, ackTs).catch(() => {});
  await reactLogged(d.render, msg.channel, msg.ts, "eyes", false);
  await reactLogged(d.render, msg.channel, msg.ts, "x");
  await d.render
    .post(
      msg.channel,
      threadRootTs(msg),
      `:x: prompt failed: ${truncate(String((err as Error)?.message ?? err), 200)}`,
      undefined,
      { unfurl: false, lane: "interactive" },
    )
    .catch(() => {});
}

async function sendPrompt(
  d: BridgeDeps,
  thread: ThreadState,
  text: string,
  client: Parameters<typeof promptAsync>[0],
  threadKey: string,
  msg: SlackMsg,
  attempt: ProcessingAttempt,
  fileParts: ImagePart[] = [],
): Promise<"accepted" | "uncertain"> {
  const admittedAt = performance.now();
  try {
    const messageID = newPromptMessageID();
    d.state.associatePrompt(threadKey, msg.ts, { projectDir: thread.projectDir, sessionId: thread.sessionId, messageId: messageID });
    checkSubmission(msg, d, attempt);
    attempt.effectsStarted = true;
    await promptAsync(client, thread.sessionId, text, { model: thread.model, agent: thread.agent, files: fileParts, messageID });
    pushLog(`latency admission ${msg.channel}:${msg.ts}: ${Math.round(performance.now() - admittedAt)}ms`);
    return "accepted";
  } catch (err) {
    if (err instanceof RecoveryBlocked) throw err;
    if (d.state.isMessageAccepted(threadKey, msg.ts)) return "accepted";
    const msgText = String((err as Error)?.message ?? err);
    if ((err as { _tag?: string })?._tag === "SessionNotFoundError" || (!client.v2 && isMissingSession(err))) {
      attempt.effectsStarted = false; // authoritative rejection; retry only while still eligible
      // Session vanished (server data wiped, etc.) — rebind a fresh session, once.
      let reboundSessionId: string | null = null;
      try {
        const dir = thread.projectDir;
        const lease = await acquire(d.pool, dir);
        try {
          checkSubmission(msg, d, attempt);
          const sess = await sessionCreate(lease.entry.client!, truncate(text, 60));
          checkSubmission(msg, d, attempt);
          reboundSessionId = sess.id;
          const fresh: ThreadState = {
            ...(d.state.getThread(threadKey) ?? thread),
            sessionId: sess.id, projectDir: dir, lastUsedAt: Date.now(),
          };
          d.state.setThread(threadKey, fresh);
          attempt.context.generation = d.state.bindingGeneration(threadKey);
          // Keep the view, preferences and pending-run metadata through a rebind.
          getView(thread.sessionId)?.retargetSession(sess.id);
          const messageID = newPromptMessageID();
          d.state.associatePrompt(threadKey, msg.ts, { projectDir: dir, sessionId: sess.id, messageId: messageID });
          checkSubmission(msg, d, attempt);
          attempt.effectsStarted = true;
          await promptAsync(lease.entry.client!, sess.id, text, { model: fresh.model, agent: fresh.agent, files: fileParts, messageID });
          return "accepted";
        } finally { lease.release(); }
      } catch (err2) {
        if (err2 instanceof RecoveryBlocked) throw err2;
        return reportUncertain(d, msg, `after rebind${reboundSessionId ? ` (${reboundSessionId})` : ""}: ${String((err2 as Error)?.message ?? err2)}`);
      }
    }
    return reportUncertain(d, msg, msgText);
  }
}

function isMissingSession(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number }; message?: string };
  return e?.status === 404 || e?.response?.status === 404 || /^(?:HTTP )?404(?: not found)?$/i.test(e?.message ?? "");
}

async function reportUncertain(d: BridgeDeps, msg: SlackMsg, reason: string): Promise<"accepted" | "uncertain"> {
  const key = d.state.threadKey(msg.channel, threadRootTs(msg));
  if (d.state.isMessageAccepted(key, msg.ts)) return "accepted";
  // Persist BEFORE attempting to report. A failed Slack post must not erase evidence.
  d.state.settleMessage(d.state.threadKey(msg.channel, threadRootTs(msg)), msg.ts, "uncertain");
  logErr(`prompt submission uncertain (${msg.channel}:${msg.ts}): ${reason}`);
  await d.render.post(msg.channel, threadRootTs(msg),
    `⚠️ Prompt acceptance is uncertain: ${truncate(reason, 200)}. It may still be running. I will not automatically resubmit; inspect the session before sending it again.`,
    undefined, { unfurl: false, lane: "interactive" }).catch(() => {});
  return d.state.isMessageAccepted(key, msg.ts) ? "accepted" : "uncertain";
}

let lastPromptIDTime = 0n;
/** Sortable msg_ prefix plus random suffix; correlation only, never a license to retry. */
function newPromptMessageID(): string {
  const now = BigInt(Date.now()) * 0x1000n;
  lastPromptIDTime = now > lastPromptIDTime ? now : lastPromptIDTime + 1n;
  return `msg_${lastPromptIDTime.toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`;
}

function previousTs(ts: string): string {
  const [seconds, fraction = ""] = ts.split(".");
  const micros = BigInt(seconds!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const previous = micros > 0n ? micros - 1n : 0n;
  return `${previous / 1_000_000n}.${String(previous % 1_000_000n).padStart(6, "0")}`;
}
