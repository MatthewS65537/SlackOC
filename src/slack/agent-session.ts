import type { App } from "@slack/bolt";
import { logErr } from "../log.js";
import { truncate } from "../util.js";
import { classifyTransport, enqueue } from "./queue.js";
import { isRateLimited, retryAfterSeconds, slackErrorCode } from "./transport.js";
import { SESSION_STATUS_REFRESH_MS, type RenderDeps, type SessionStatus } from "./render.js";

/**
 * Slack's native agent sessions (A1, web/slack-agent-sessions.md): one session
 * per thread whose status drives Slack's own "Working…" bar and Stop button.
 * Only apps declared with `features.agent_view` may use them, so the first
 * refusal that isn't about one channel turns the feature off for this process
 * (one log line) — an app that wasn't reinstalled behaves exactly as before.
 */

/** Refusals about one channel or thread: the feature still works elsewhere. */
const CHANNEL_SCOPED = new Set([
  "channel_not_found", "not_in_channel", "thread_not_found", "is_archived", "restricted_action",
  "restricted_action_read_only_channel", "restricted_action_thread_only_channel", "method_not_supported_for_channel",
  "cannot_reply_to_message", "message_not_found", "user_not_in_channel",
]);
const STOP_WARNING = "missing_agent_session_stopped_event_subscription";
const MAX_TRACKED_THREADS = 1_000;

type CallResult = { response_metadata?: { warnings?: string[] }; warning?: string };
type Outcome = { result: CallResult } | { error: unknown };

export function createSessionDeps(app: App, opts: { owner?: string; isStopping: () => boolean }): Required<Pick<RenderDeps, "sessionStatus" | "sessionRename">> {
  let disabled = false;
  let stopWarned = false;
  let renameWarned = false;
  /** Last status sent per thread. A repeat within half the keep-alive period is a duplicate; a later one is the keep-alive. */
  const last = new Map<string, { status: SessionStatus; at: number }>();

  /** Interactive write in the thread's lane. Slack's refusal comes back as a value, so the queue doesn't log it as a dropped op. */
  const call = (channel: string, threadTs: string, method: string, run: () => Promise<CallResult>): Promise<Outcome | null> =>
    enqueue(async (): Promise<Outcome> => {
      try { return { result: await run() }; }
      catch (err) {
        // Rate limits and network failures keep the queue's retry, brake and drop handling.
        if (isRateLimited(err) || retryAfterSeconds(err) !== undefined || classifyTransport(err)) throw err;
        return { error: err };
      }
    }, { channel, method, lane: "interactive", thread: threadTs }).catch(() => null); // dropped: the queue already logged it

  // Resolved per call: clients without the agents API (test fakes) make both methods no-ops.
  const sessions = () => (app.client as Partial<App["client"]>).agents?.sessions;

  return {
    sessionStatus: async (channel, threadTs, status, o) => {
      const api = sessions();
      if (!api || disabled || opts.isStopping()) return;
      const key = `${channel}:${threadTs}`;
      const prev = last.get(key);
      const now = Date.now();
      if (prev?.status === status && now - prev.at < SESSION_STATUS_REFRESH_MS / 2) return;
      // setStatus creates a missing session: never create one just to close it.
      if (status === "closed" && !prev) return;
      const sent = { status, at: now };
      last.delete(key); // re-insert: Map order is the eviction order
      last.set(key, sent);
      if (last.size > MAX_TRACKED_THREADS) last.delete(last.keys().next().value!);
      const initiator = o?.initiatorUserId ?? opts.owner;
      const out = await call(channel, threadTs, "agents.sessions.setStatus", () => api.setStatus({
        channel_id: channel, thread_ts: threadTs, status,
        // Both only apply when Slack creates the session.
        ...(o?.title ? { title: truncate(o.title, 200) } : {}),
        ...(initiator ? { initiator_user_id: initiator } : {}),
      }));
      if (!out || "error" in out) {
        // Not delivered: forget it so a retry isn't a duplicate (Slack still has the previous status, if any).
        if (last.get(key) === sent) { if (prev) last.set(key, prev); else last.delete(key); }
        const code = out ? slackErrorCode(out.error) : undefined;
        if (!out || (code && CHANNEL_SCOPED.has(code))) return;
        disabled = true;
        logErr(`slackoc: native Slack thread status is off until the bridge restarts (agents.sessions.setStatus: ${code ?? String((out.error as Error)?.message ?? out.error)}) — ` +
          "add features.agent_view to the app manifest and reinstall the app to enable it.");
        return;
      }
      const warnings = [...(out.result.response_metadata?.warnings ?? []), ...(out.result.warning?.split(",") ?? [])];
      if (!stopWarned && warnings.includes(STOP_WARNING)) {
        stopWarned = true;
        logErr(`slackoc: Slack warns ${STOP_WARNING} — subscribe the app to the agent_session_stopped bot event (current manifest) and reinstall, or Slack's Stop button does nothing.`);
      }
    },
    sessionRename: async (channel, threadTs, title) => {
      const api = sessions();
      // Only threads this process opened a session for: rename never creates one.
      if (!api || disabled || opts.isStopping() || !title.trim() || !last.has(`${channel}:${threadTs}`)) return;
      const out = await call(channel, threadTs, "agents.sessions.rename",
        () => api.rename({ channel_id: channel, thread_ts: threadTs, title: truncate(title.trim(), 200) }));
      if (out && "error" in out && !renameWarned) {
        renameWarned = true;
        logErr(`slackoc: agent session rename failed (${slackErrorCode(out.error) ?? String(out.error)}); later failures are not logged.`);
      }
    },
  };
}
