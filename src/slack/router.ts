import type { SlackocConfig } from "../config.js";
import { promptAsync, sessionCreate } from "../opencode/client.js";
import type { ServerPool } from "../opencode/server.js";
import type { StateStore, ThreadState } from "../state.js";
import { execute, type CmdCtx } from "../commands/registry.js";
import { parseBackslash } from "../commands/parse.js";
import "../commands/handlers.js"; // registers all commands on import
import { SessionView, getView, reactLogged, type RenderDeps } from "./render.js";
import { slackToPlain, truncate } from "../util.js";
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
 * also retries on slow acks). Claim channel:ts exactly once — 60 s window.
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
export async function handleIncomingMessage(msg: SlackMsg, d: BridgeDeps): Promise<void> {
  // file_share is the only subtype we let through — it carries user attachments.
  if ((msg.subtype && msg.subtype !== "file_share") || msg.bot_id) return; // message_changed, bot echoes, etc.
  if (!claimEvent(msg.channel, msg.ts)) return; // duplicate delivery (mention+message, retries)
  if (!msg.user || msg.user !== d.config.ownerSlackUserId) return; // owner-only

  // Catch-up watermark: the sweep (slack/catchup.ts) re-reads the thread past
  // this point if a socket-mode envelope is ever lost. Marked pre-hush-gate so
  // deliberately-ignored (hushed) messages don't replay on a later unhush.
  const threadKey = d.state.threadKey(msg.channel, threadRootTs(msg));
  d.state.markThreadSeen(threadKey, msg.ts);

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
    await d.render.post(
      msg.channel,
      threadRootTs(msg),
      "@ mention with a prompt to run OpenCode here and use `\\help` to view commands.",
      undefined,
      { unfurl: false },
    );
    return;
  }

  const action = hushAction(thread, explicitMention, parsed !== null);
  if (action === "ignore") return;
  if (action === "unhush" && thread) {
    d.state.setThread(threadKey, { ...thread, hushed: false });
  }

  if (parsed) {
    const ctx = buildCtx(msg, d, thread);
    await execute(parsed, ctx);
    return;
  }
  const fileParts = await downloadAttachments(attachments, msg, d);
  // Every attachment failed to download AND there's no real caption — warnings
  // already posted; a text-only "look at this file" prompt would mislead.
  if (attachments.length && !fileParts.length && !cleanMentionText(slackToPlain(raw), d.botUserId).trim()) return;
  await runPrompt(text, msg, d, fileParts);
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
      const res = await fetch(f.url_private_download!, {
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
      await d.render.post(msg.channel, threadTs, extra, undefined, { unfurl: false });
    },
    uploadToThread: async (filename, content) => {
      await d.render.upload({ channelId: msg.channel, threadTs, filename, content });
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
const creatingThreads = new Map<string, Promise<ThreadState>>();

/**
 * New root message → fresh OpenCode session in the current project.
 * Thread reply → continue the bound session (or bind a fresh one).
 */
async function runPrompt(text: string, msg: SlackMsg, d: BridgeDeps, fileParts: ImagePart[] = []): Promise<void> {
  const threadTs = threadRootTs(msg);
  const threadKey = d.state.threadKey(msg.channel, threadTs);

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
    return;
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
      const ack = await d.render.post(
        msg.channel,
        threadTs,
        ":hourglass: OpenCode is on it…",
        undefined,
        { unfurl: false },
      );
      ackTs = ack.ts;
    } catch {
      /* ack is best-effort; the run continues regardless */
    }
  }

  if (!thread) {
    const dir = d.state.currentProjectDir ?? d.cwd;
    const create = (async (): Promise<ThreadState> => {
      const entry = await d.pool.ensure(dir);
      const sess = await sessionCreate(entry.client!, truncate(text, 60));
      const now = Date.now();
      // Seed the catch-up watermark with the creating message (it IS the
      // newest processed one) — otherwise a freshly-bound thread has no
      // boundary and the sweep could replay its very first prompt.
      const fresh: ThreadState = { sessionId: sess.id, projectDir: dir, verbose: "on", lastSeenTs: msg.ts, createdAt: now, lastUsedAt: now };
      d.state.setThread(threadKey, fresh);
      return fresh;
    })();
    creatingThreads.set(threadKey, create);
    try {
      thread = await create;
    } catch (err) {
      await failBoot(msg, d, ackTs, err);
      return;
    } finally {
      creatingThreads.delete(threadKey);
    }
  }

  let entry: Awaited<ReturnType<typeof d.pool.ensure>>;
  try {
    entry = await d.pool.ensure(thread.projectDir);
  } catch (err) {
    await failBoot(msg, d, ackTs, err);
    return;
  }

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
  }
  await view.beginPrompt(msg.ts);

  await sendPrompt(d, thread, text, entry.client!, threadKey, msg, fileParts);
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
      { unfurl: false },
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
): Promise<void> {
  try {
    await promptAsync(client, thread.sessionId, text, { model: thread.model, agent: thread.agent, files: fileParts });
  } catch (err) {
    const msgText = String((err as Error)?.message ?? err);
    if (/not.?found|404/i.test(msgText)) {
      // Session vanished (server data wiped, etc.) — rebind a fresh session, once.
      let reboundSessionId: string | null = null;
      try {
        const dir = thread.projectDir;
        const entry2 = await d.pool.ensure(dir);
        const sess = await sessionCreate(entry2.client!, truncate(text, 60));
        reboundSessionId = sess.id;
        const now = Date.now();
        const fresh: ThreadState = {
          sessionId: sess.id,
          projectDir: dir,
          verbose: thread.verbose,
          model: thread.model,
          agent: thread.agent,
          lastSeenTs: thread.lastSeenTs ?? msg.ts,
          createdAt: now,
          lastUsedAt: now,
        };
        d.state.setThread(threadKey, fresh);
        // Keep the same view (and its ⏳ → ✅ lifecycle) pointed at the new
        // session, so its SSE events still render and the reaction resolves.
        getView(thread.sessionId)?.retargetSession(sess.id);
        await promptAsync(entry2.client!, sess.id, text, { model: fresh.model, agent: fresh.agent, files: fileParts });
      } catch (err2) {
        // The retried prompt failed too — finalize via the (retargeted) view so
        // the thread gets its ❌ + error line + failure DM instead of hanging at
        // ⏳ until the watchdog. Fallback line only if the view is truly gone.
        const reason = `prompt failed after rebind: ${String((err2 as Error)?.message ?? err2).slice(0, 200)} — \`\\new\` starts a fresh session`;
        const view2 = reboundSessionId ? getView(reboundSessionId) : undefined;
        if (view2) await view2.finalize(reason);
        else {
          await d.render.post(
            msg.channel,
            msg.thread_ts ?? msg.ts,
            `⚠️ ${reason}`,
            undefined,
            { unfurl: false },
          );
        }
      }
      return;
    }
    const view = getView(thread.sessionId);
    await view?.finalize(`prompt failed: ${msgText.slice(0, 200)}`);
  }
}
