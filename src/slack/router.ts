import type { SlackocConfig } from "../config.js";
import { randomBytes } from "node:crypto";
import { promptAsync, sessionCreate } from "../opencode/client.js";
import type { ServerPool } from "../opencode/server.js";
import type { StateStore, ThreadState } from "../state.js";
import { execute, type CmdCtx } from "../commands/registry.js";
import { parseBackslash } from "../commands/parse.js";
import "../commands/handlers.js"; // registers all commands on import
import { SessionView, getView, reactLogged, type RenderDeps } from "./render.js";
import { slackToPlain, truncate } from "../util.js";
import { canonicalDir } from "../paths.js";
import { logErr } from "../log.js";
import { abortableFetch } from "../http.js";
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
  bridgeInfo?: { startedAt: number; dmAvailable: () => boolean };
  /** Archives permalink for a state threadKey — null when the team URL is unknown. */
  threadUrl?: (threadKey: string) => string | null;
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
export type IncomingOutcome = "accepted" | "processing" | "uncertain" | "retry" | "paused" | "ignored";
interface ProcessingAttempt { effectsStarted: boolean }

export async function handleIncomingMessage(msg: SlackMsg, d: BridgeDeps): Promise<IncomingOutcome> {
  if (d.isStopping?.()) return "retry";
  // file_share is the only subtype we let through — it carries user attachments.
  if ((msg.subtype && msg.subtype !== "file_share") || msg.bot_id) return "ignored";
  if (!msg.user || msg.user !== d.config.ownerSlackUserId) return "ignored";

  const threadKey = d.state.threadKey(msg.channel, threadRootTs(msg));
  const parsed = parseBackslash(cleanMentionText(slackToPlain(msg.text ?? ""), d.botUserId));
  const claim = d.state.claimMessage(threadKey, msg.ts, { recoveryCommand: parsed?.name === "restart" });
  if (claim !== "claimed") {
    // At hard capacity, status is a read-only escape hatch. Only its Slack reply
    // has best-effort (process-local) dedup; restart NEVER bypasses durable claims.
    if (claim === "paused" && parsed?.name === "status") {
      if (!claimEvent(msg.channel, msg.ts)) return "ignored";
      await execute(parsed, buildCtx(msg, d, d.state.getThread(threadKey)));
      return "accepted";
    }
    return claim;
  }
  const attempt: ProcessingAttempt = { effectsStarted: false };
  try {
    d.state.markThreadSeen(threadKey, msg.ts);
    const outcome = await processMessage(msg, d, attempt);
    d.state.initializeHistory(threadKey, msg.ts === threadRootTs(msg) ? previousTs(msg.ts) : threadRootTs(msg));
    d.state.markThreadSeen(threadKey, msg.ts);
    if (outcome === "retry") d.state.releaseMessage(threadKey, msg.ts);
    else d.state.settleMessage(threadKey, msg.ts, outcome);
    return d.state.isMessageAccepted(threadKey, msg.ts) ? "accepted" : outcome;
  } catch (err) {
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
    const ctx = buildCtx(msg, d, thread);
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
  const fileParts = await downloadAttachments(attachments, msg, d);
  // Every attachment failed to download AND there's no real caption — warnings
  // already posted; a text-only "look at this file" prompt would mislead.
  if (attachments.length && !fileParts.length && !cleanMentionText(slackToPlain(raw), d.botUserId).trim()) return "accepted";
  return runPrompt(text, msg, d, attempt, fileParts);
}

/** Download Slack file attachments and convert to OpenCode data-URI file parts. */
async function downloadAttachments(
  files: SlackMsg["files"],
  msg: SlackMsg,
  d: BridgeDeps,
): Promise<ImagePart[]> {
  const parts: ImagePart[] = [];
  for (const f of files ?? []) {
    try {
      if (d.isStopping?.()) break;
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
          await d.render.post(
            msg.channel,
            threadRootTs(msg),
            `:warning: ${filename} is too large to process (${Math.round(buf.length / 1024 / 1024)} MB) — skipped.`,
            undefined,
            { unfurl: false },
          );
          continue;
        }
        const decoded = await readImage(buf);
        const longest = decoded ? Math.max(decoded.bitmap.width, decoded.bitmap.height) : 0;
        if (buf.length > TARGET_IMAGE_BYTES || longest > MAX_IMAGE_EDGE) {
          const shrunk = await shrinkImage(buf, mime, filename, TARGET_IMAGE_BYTES, decoded ?? undefined);
          if (shrunk) {
            parts.push({
              mime: shrunk.mime,
              filename: shrunk.filename,
              dataUrl: `data:${shrunk.mime};base64,${shrunk.data.toString("base64")}`,
            });
            await d.render.post(
              msg.channel,
              threadRootTs(msg),
              `:small_orange_diamond: ${filename} was ${Math.round(buf.length / 1024)} kB — compressed to ${Math.round(shrunk.data.length / 1024)} kB to fit.`,
              undefined,
              { unfurl: false },
            );
            continue;
          }
          await d.render.post(
            msg.channel,
            threadRootTs(msg),
            `:warning: couldn't compress ${filename} to fit — skipped.`,
            undefined,
            { unfurl: false },
          );
          continue;
        }
      }
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        await d.render.post(
          msg.channel,
          threadRootTs(msg),
          `:warning: ${filename} is too large to send (${Math.round(buf.length / 1024)} kB) — skipped.`,
          undefined,
          { unfurl: false },
        );
        continue;
      }
      parts.push({
        mime,
        filename,
        dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      });
    } catch (err) {
      await d.render.post(
        msg.channel,
        threadRootTs(msg),
        `:warning: couldn't attach ${f.name ?? "file"}: ${truncate(String((err as Error)?.message ?? err), 200)}`,
        undefined,
        { unfurl: false },
      );
    }
  }
  return parts;
}

function buildCtx(msg: SlackMsg, d: BridgeDeps, thread: ThreadState | null = null): CmdCtx {
  const threadTs = threadRootTs(msg);
  const threadKey = d.state.threadKey(msg.channel, threadTs);
  return {
    channelId: msg.channel,
    threadTs,
    threadKey,
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
  };
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
  void reactLogged(d.render, msg.channel, msg.ts, "eyes");

  let thread = d.state.getThread(threadKey);

  if (!thread && creatingThreads.has(threadKey)) {
    // Leader is creating this thread's session right now — wait for it, then
    // re-read state. If the leader failed, fall through and try our own.
    await creatingThreads.get(threadKey)!.catch(() => null);
    thread = d.state.getThread(threadKey);
  }

  // Ack BEFORE any OpenCode work: cold starts (pool ensure + session create)
  // can take seconds of silence. An active view keeps its own status message;
  // otherwise the placeholder is posted now and adopted by the new view.
  let ackTs: string | null = null;
  if (!thread || !getView(thread.sessionId)) {
    try {
      // Interactive: this is the prompt's ack — the user is watching for it.
      const ack = await d.render.post(
        msg.channel,
        threadTs,
        "⏳ OpenCode is on it…",
        undefined,
        { unfurl: false, lane: "interactive" },
      );
      ackTs = ack.ts;
    } catch {
      /* ack is best-effort; the run continues regardless */
    }
  }

  if (!thread) {
    // The ack above yielded: another message may have installed the creation
    // lock while Slack was posting it. Re-check before starting any creation.
    const creating = creatingThreads.get(threadKey);
    if (creating) await creating.catch(() => null);
    thread = d.state.getThread(threadKey);
  }
  if (d.isStopping?.()) return "retry";
  if (!thread) {
    const dir = canonicalDir(d.state.currentProjectDir ?? d.cwd);
    const create = (async (): Promise<ThreadState> => {
      const lease = await acquire(d.pool, dir);
      try {
        if (d.isStopping?.()) throw new Error("bridge stopping before session creation");
        attempt.effectsStarted = true;
        const sess = await sessionCreate(lease.entry.client!, truncate(text, 60));
        const now = Date.now();
        // Start at the thread boundary; live receipt evidence protects this
        // creating prompt while history can still discover an earlier gap.
        const fresh: ThreadState = { sessionId: sess.id, projectDir: dir, verbose: "on", lastSeenTs: msg.ts,
          historyCursorTs: threadTs === msg.ts ? previousTs(msg.ts) : threadTs, createdAt: now, lastUsedAt: now };
        d.state.setThread(threadKey, fresh);
        attempt.effectsStarted = false; // binding is durable; retry can reuse it
        return fresh;
      } finally { lease.release(); }
    })();
    creatingThreads.set(threadKey, create);
    try {
      thread = await create;
    } catch (err) {
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
    attempt.effectsStarted = true;
    return await sendPrompt(d, thread, text, entry.client!, threadKey, msg, fileParts);
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
  fileParts: ImagePart[] = [],
): Promise<"accepted" | "uncertain"> {
  try {
    const messageID = newPromptMessageID();
    d.state.associatePrompt(threadKey, msg.ts, { projectDir: thread.projectDir, sessionId: thread.sessionId, messageId: messageID });
    await promptAsync(client, thread.sessionId, text, { model: thread.model, agent: thread.agent, files: fileParts, messageID });
    return "accepted";
  } catch (err) {
    if (d.state.isMessageAccepted(threadKey, msg.ts)) return "accepted";
    const msgText = String((err as Error)?.message ?? err);
    if (isMissingSession(err)) {
      // Session vanished (server data wiped, etc.) — rebind a fresh session, once.
      let reboundSessionId: string | null = null;
      try {
        const dir = thread.projectDir;
        const lease = await acquire(d.pool, dir);
        try {
          const sess = await sessionCreate(lease.entry.client!, truncate(text, 60));
          reboundSessionId = sess.id;
          const fresh: ThreadState = {
            ...(d.state.getThread(threadKey) ?? thread),
            sessionId: sess.id, projectDir: dir, lastUsedAt: Date.now(),
          };
          d.state.setThread(threadKey, fresh);
          // Keep the view, preferences and pending-run metadata through a rebind.
          getView(thread.sessionId)?.retargetSession(sess.id);
          const messageID = newPromptMessageID();
          d.state.associatePrompt(threadKey, msg.ts, { projectDir: dir, sessionId: sess.id, messageId: messageID });
          await promptAsync(lease.entry.client!, sess.id, text, { model: fresh.model, agent: fresh.agent, files: fileParts, messageID });
          return "accepted";
        } finally { lease.release(); }
      } catch (err2) {
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
