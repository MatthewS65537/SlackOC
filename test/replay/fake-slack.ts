/**
 * Fake Slack for transcript replays. A fake Web API client is plugged into the
 * REAL createRenderDeps adapter, so every call takes the production path:
 * unicodeEmoji conversion, the per-channel write lane in slack/queue.ts (strict
 * per-thread FIFO, ~1/s post pacing, 429 back-off, drop tagging) and reactions
 * bypassing the queue. Each call Slack applies is recorded once, in the order
 * Slack applied it. Callers must reset the queue (_resetQueueForTests) and run
 * under fake timers: pacing and back-off are real setTimeouts.
 */
import type { App } from "@slack/bolt";
import { createRenderDeps } from "../../src/slack/render-deps.js";
import type { RenderDeps } from "../../src/slack/render.js";

export type SlackOpKind = "post" | "update" | "delete" | "react" | "unreact" | "upload";

export interface SlackOp {
  op: SlackOpKind;
  channel: string;
  /** Thread the op belongs to ("" = top level). */
  thread: string;
  /** Message created or targeted ("" for a post Slack refused). */
  ts: string;
  text?: string;
  blocks?: unknown[];
  /** Sent with unfurl_links:false. render.ts does this for system chatter, never for answer text. */
  unfurl?: false;
  /** Reaction name, or the uploaded filename. */
  name?: string;
  /** An injected failure. "rate_limited" attempts are retried by the queue; "dropped" ones are lost. */
  fault?: "dropped" | "rate_limited";
  /** Fake-clock time Slack applied (or refused) the call. */
  at: number;
}

export interface FakeSlackKnobs {
  /** The nth chat.postMessage call (1-based, counting attempts) fails permanently, so the queue drops it. */
  dropNth?: number;
  /** The nth chat.postMessage call (1-based) gets one HTTP 429; the queue backs off and retries it. */
  rateLimitNth?: number;
  /** Latency of every write call, or per kind (e.g. `{ update: 2500 }` for slow edits). */
  latencyMs?: number | Partial<Record<"post" | "update" | "delete" | "upload", number>>;
}

export interface FakeMessage {
  ts: string;
  channel: string;
  thread: string;
  text: string;
  blocks?: unknown[];
  unfurl?: false;
  deleted: boolean;
  reactions: Set<string>;
}

type Args = Record<string, unknown> & { channel?: string; ts?: string; text?: string; thread_ts?: string };

const slackError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), {
  code: "slack_webapi_platform_error", data: { ok: false, error: code },
});

export function createFakeSlack(knobs: FakeSlackKnobs = {}) {
  const timeline: SlackOp[] = [];
  const messages = new Map<string, FakeMessage>();
  let seq = 0;
  let postCalls = 0;
  const latency = (kind: "post" | "update" | "delete" | "upload") => {
    const ms = typeof knobs.latencyMs === "number" ? knobs.latencyMs : knobs.latencyMs?.[kind] ?? 0;
    return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : undefined;
  };
  const live = (ts: unknown) => {
    const m = messages.get(String(ts));
    if (!m || m.deleted) throw slackError("message_not_found");
    return m;
  };

  const client = {
    chat: {
      postMessage: async (a: Args) => {
        const n = ++postCalls;
        await latency("post");
        const base = { op: "post" as const, channel: String(a.channel), thread: a.thread_ts ?? "", text: a.text ?? "",
          ...(a.blocks ? { blocks: a.blocks as unknown[] } : {}), ...(a.unfurl_links === false ? { unfurl: false as const } : {}) };
        if (n === knobs.rateLimitNth) {
          timeline.push({ ...base, ts: "", fault: "rate_limited", at: Date.now() });
          throw Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 1 });
        }
        if (n === knobs.dropNth) {
          timeline.push({ ...base, ts: "", fault: "dropped", at: Date.now() });
          throw slackError("internal_error");
        }
        const ts = `1900000000.${String(++seq).padStart(6, "0")}`; // never collides with prompt ts
        messages.set(ts, { ts, channel: base.channel, thread: base.thread, text: base.text, blocks: base.blocks, unfurl: base.unfurl,
          deleted: false, reactions: new Set() });
        timeline.push({ ...base, ts, at: Date.now() });
        return { ok: true, ts };
      },
      update: async (a: Args) => {
        await latency("update");
        const m = live(a.ts);
        m.text = a.text ?? "";
        timeline.push({ op: "update", channel: m.channel, thread: m.thread, ts: m.ts, text: m.text, at: Date.now() });
        return { ok: true };
      },
      delete: async (a: Args) => {
        await latency("delete");
        const m = live(a.ts);
        m.deleted = true;
        timeline.push({ op: "delete", channel: m.channel, thread: m.thread, ts: m.ts, at: Date.now() });
        return { ok: true };
      },
    },
    reactions: {
      add: async (a: Args & { timestamp?: string; name?: string }) => {
        const m = live(a.timestamp);
        if (m.reactions.has(a.name!)) throw slackError("already_reacted");
        m.reactions.add(a.name!);
        timeline.push({ op: "react", channel: m.channel, thread: m.thread, ts: m.ts, name: a.name, at: Date.now() });
        return { ok: true };
      },
      remove: async (a: Args & { timestamp?: string; name?: string }) => {
        const m = live(a.timestamp);
        if (!m.reactions.delete(a.name!)) throw slackError("no_reaction");
        timeline.push({ op: "unreact", channel: m.channel, thread: m.thread, ts: m.ts, name: a.name, at: Date.now() });
        return { ok: true };
      },
    },
    filesUploadV2: async (a: Args & { channel_id?: string; filename?: string; initial_comment?: string }) => {
      await latency("upload");
      timeline.push({ op: "upload", channel: String(a.channel_id), thread: a.thread_ts ?? "", ts: "", name: a.filename,
        text: a.initial_comment, at: Date.now() });
      return { ok: true };
    },
  };

  const deps: RenderDeps = createRenderDeps({ client } as unknown as App, {
    isStopping: () => false, dmChannel: () => "D-owner", viewThread: () => "",
  });

  return {
    deps, timeline, messages,
    /** Seed a human message (e.g. the prompt that starts the thread) so reactions can target it. */
    addUserMessage(channel: string, ts: string, thread: string): void {
      messages.set(ts, { ts, channel, thread, text: "", deleted: false, reactions: new Set() });
    },
  };
}

export type FakeSlack = ReturnType<typeof createFakeSlack>;
