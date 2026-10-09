import type { App } from "@slack/bolt";
import { appendSectionSuffix } from "./blocks.js";
import { unicodeEmoji } from "./emoji.js";
import { enqueue } from "./queue.js";
import { SLACK_UPLOAD_TIMEOUT_MS } from "./transport.js";
import type { RenderDeps } from "./render.js";

/**
 * The renderer's Slack adapter. All outbound calls go through the per-channel,
 * two-tier queue (slack/queue.ts): ~1/s pacing per channel lane, interactive
 * ops ahead of background stream traffic, a shared 429 brake, and a per-op
 * timeout so one stalled call can never freeze its lane.
 */
export function createRenderDeps(app: App, opts: {
  isStopping: () => boolean;
  dmChannel: () => string | null;
  viewThread: (channel: string, threadTs: string) => string;
}): RenderDeps {
  const { isStopping, viewThread } = opts;
  const dmChannelId = opts.dmChannel;
  return {
    post: async (channel, threadTs, text, blocks, opts) => {
      if (isStopping()) throw new Error("bridge isStopping()");
      const r = await enqueue(
        () =>
          app.client.chat.postMessage({
            channel,
            ...(threadTs ? { thread_ts: threadTs } : {}), // "" posts top-level (shortcut carrier in the DM)
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
      if (!dmChannelId()) throw new Error("owner DM channel unavailable");
      const link = viewThread(channel, threadTs);
      // With blocks present, `text` is only the notification fallback — graft
      // the link onto the first section so the RENDERED DM keeps it too.
      const outBlocks = blocks && link ? appendSectionSuffix(blocks, link) : blocks;
      const r = await enqueue(
        () =>
          app.client.chat.postMessage({
            channel: dmChannelId()!,
            text: unicodeEmoji(`${text}${link}`),
            mrkdwn: true,
            ...(outBlocks ? { blocks: outBlocks } : {}),
          }),
        { channel: dmChannelId()!, lane: opts?.lane },
      );
      return { ts: r.ts as string };
    },
  };
}
