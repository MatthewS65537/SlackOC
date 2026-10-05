import { dirname, join } from "node:path";
import type { App } from "@slack/bolt";
import type { ScheduleCommands } from "../commands/registry.js";
import type { ServerPool } from "../opencode/server.js";
import type { StateStore } from "../state.js";
import { enqueue } from "../slack/queue.js";
import { esc, mdToMrkdwn, truncate } from "../util.js";
import { installScheduleControls } from "./controls.js";
import { ReportRunner } from "./runner.js";
import { ScheduleStore, type ScheduleRun } from "./store.js";
import { Scheduler } from "./scheduler.js";

export interface ScheduledReports {
  commands: ScheduleCommands;
  eligible(threadKey: string, sessionId: string): boolean;
  poll(): Promise<void>;
  close(): void;
}

interface Options {
  app: App;
  pool: ServerPool;
  state: StateStore;
  statePath: string;
  owner: string;
  botUserId: string;
  ownerDm: () => string | null;
  signal: AbortSignal;
  stopping: () => boolean;
  onError: (error: unknown) => void;
}

const contextMarker = (id: string) => `slackoc-schedule-context:${id}`;
const reportMarker = (id: string) => `slackoc-schedule-report:${id}`;

/** One writer, one existing Slack connection, and no synthetic inbound messages. */
export function createScheduledReports(opts: Options): ScheduledReports {
  const store = new ScheduleStore(join(dirname(opts.statePath), "schedules.json"));
  const allowed = (id: string) => {
    const run = store.run(id);
    return !!run && !opts.stopping() && !opts.signal.aborted &&
      !["canceled", "failed", "skipped"].includes(run.status) &&
      (run.output !== undefined || Date.now() < run.deadlineAt);
  };
  const active = (run: ScheduleRun) => ["creating", "submitting", "running", "waiting", "uncertain"].includes(run.status) &&
    !run.output && Date.now() < run.deadlineAt;
  const eligible = (threadKey: string, sessionId: string) => {
    const thread = opts.state.getThread(threadKey);
    const run = thread?.scheduledRunId ? store.run(thread.scheduledRunId) : undefined;
    return !!run && !opts.stopping() && active(run) && run.sessionId === sessionId &&
      run.snapshot.projectDir === thread?.projectDir && `${run.context?.channel}:${run.context?.ts}` === threadKey;
  };
  const bindContext = (run: ScheduleRun, context: { channel: string; ts: string }) => {
    if (!run.sessionId || !allowed(run.id)) return;
    const key = opts.state.threadKey(context.channel, context.ts);
    const bound = opts.state.getThread(key);
    if (bound && (bound.sessionId !== run.sessionId || bound.scheduledRunId !== run.id)) throw new Error("scheduled report context was rebound; refusing to overwrite it");
    if (!bound) opts.state.setThread(key, { sessionId: run.sessionId, projectDir: run.snapshot.projectDir,
      verbose: "off", scheduledRunId: run.id, model: run.snapshot.model, agent: run.snapshot.agent,
      createdAt: Date.now(), lastUsedAt: Date.now(), historyCursorTs: context.ts });
  };
  const find = async (channel: string, marker: string, since: number) => {
    const result = await enqueue(() => opts.app.client.conversations.history({ channel,
      oldest: String(Math.max(0, since - 60_000) / 1000), inclusive: true, limit: 100 }),
    { channel, method: "conversations.history" });
    const message = result.messages?.find(m => m.user === opts.botUserId && m.ts && m.text?.includes(marker));
    return message?.ts ? { channel, ts: message.ts } : undefined;
  };
  const runner = new ReportRunner({
    store, pool: opts.pool, signal: opts.signal,
    ensureContext: async run => {
      if (!allowed(run.id)) throw new Error("scheduled report canceled or bridge stopping");
      const current = store.run(run.id)!;
      if (current.context) { bindContext(current, current.context); return current.context; }
      const channel = opts.ownerDm();
      if (!channel) throw new Error("owner DM unavailable; report cannot route approvals safely");
      if (current.contextAttemptedAt) {
        const copy = await find(channel, contextMarker(run.id), current.contextAttemptedAt);
        if (!copy) throw new Error("private report context delivery uncertain; no automatic repost");
        if (!allowed(run.id)) throw new Error("scheduled report canceled");
        store.updateRun(run.id, r => { r.context = copy; });
        bindContext(store.run(run.id)!, copy);
        return copy;
      }
      store.updateRun(run.id, r => { r.contextAttemptedAt = Date.now(); });
      const result = await enqueue(() => {
        if (!allowed(run.id)) throw new Error("scheduled report canceled");
        return opts.app.client.chat.postMessage({ channel,
          text: `⏳ *${esc(run.snapshot.name)}* — generating a scheduled report. Approval/questions appear here; use \`\\stop\` in this thread to cancel.\n\`${contextMarker(run.id)}\``,
          unfurl_links: false, unfurl_media: false });
      }, { channel });
      if (!result.ts) throw new Error("Slack did not confirm the report context timestamp");
      const context = { channel, ts: result.ts };
      if (!allowed(run.id)) throw new Error("scheduled report canceled");
      store.updateRun(run.id, r => { r.context = context; });
      bindContext(store.run(run.id)!, context);
      return context;
    },
    deliver: async run => {
      const channel = run.snapshot.destination.kind === "dm" ? run.context?.channel : run.snapshot.destination.channelId;
      if (!channel) throw new Error("report destination unavailable");
      const formatted = mdToMrkdwn(run.output ?? "");
      const content = truncate(formatted, 35_000);
      const text = `*${esc(run.snapshot.name)}* · ${new Date(run.scheduledAt).toLocaleString("en-US", { timeZone: run.snapshot.schedule.timezone })}\n\n${content}${formatted.length > content.length ? "\n\n_Report shortened in Slack; the full response remains in this session (use \\history)._" : ""}\n\n\`${reportMarker(run.id)}\``;
      const result = await enqueue(async () => {
        if (!allowed(run.id)) throw new Error("scheduled report canceled");
        const response = run.snapshot.destination.kind === "dm"
          ? await opts.app.client.chat.update({ channel, ts: run.context!.ts, text, blocks: [] })
          : await opts.app.client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
        return { ts: response.ts };
      }, { channel, method: run.snapshot.destination.kind === "dm" ? "chat.update" : "chat.postMessage" });
      const ts = result.ts ?? (run.snapshot.destination.kind === "dm" ? run.context?.ts : undefined);
      if (!ts) throw new Error("Slack did not confirm the report timestamp");
      return { channel, ts };
    },
    findDelivery: async run => {
      const channel = run.snapshot.destination.kind === "dm" ? run.context?.channel : run.snapshot.destination.channelId;
      if (!channel) return undefined;
      return find(channel, reportMarker(run.id), run.startedAt);
    },
    notify: async (run, message) => {
      if (opts.stopping() || opts.signal.aborted) return;
      const channel = opts.ownerDm();
      if (!channel) throw new Error("owner DM unavailable");
      const text = `⚠️ *${esc(run.snapshot.name)}* — ${esc(message)}\nRun \`${run.id}\` · use \`\\schedule history\` to inspect.`;
      await enqueue(async () => {
        if (opts.stopping()) throw new Error("bridge stopping");
        if (run.context) await opts.app.client.chat.update({ channel: run.context.channel, ts: run.context.ts, text, blocks: [] });
        else await opts.app.client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
      }, { channel, method: run.context ? "chat.update" : "chat.postMessage" });
    },
    onDelivered: async snapshot => {
      const run = store.run(snapshot.id);
      if (!run?.delivery?.ts || !run.sessionId || run.status !== "delivered") return;
      const key = opts.state.threadKey(run.delivery.channel, run.delivery.ts);
      const bound = opts.state.getThread(key);
      if (bound && bound.sessionId !== run.sessionId) return;
      if (run.context) {
        const oldKey = opts.state.threadKey(run.context.channel, run.context.ts);
        const old = opts.state.getThread(oldKey);
        if (oldKey !== key && old?.scheduledRunId === run.id && old.sessionId === run.sessionId) opts.state.deleteThread(oldKey);
      }
      opts.state.setThread(key, { sessionId: run.sessionId, projectDir: run.snapshot.projectDir, verbose: "off",
        model: run.snapshot.model, agent: run.snapshot.agent, createdAt: Date.now(), lastUsedAt: Date.now(),
        historyCursorTs: run.delivery.ts });
      if (run.snapshot.destination.kind === "channel" && run.context) {
        await enqueue(() => opts.app.client.chat.update({ channel: run.context!.channel, ts: run.context!.ts,
          text: `✅ *${esc(run.snapshot.name)}* delivered to <#${run.delivery!.channel}>.`, blocks: [] }),
        { channel: run.context.channel, method: "chat.update" }).catch(opts.onError);
      }
    },
  });
  const scheduler = new Scheduler({ store, tickRun: run => runner.tick(run), onError: opts.onError });
  const poll = () => opts.stopping() ? Promise.resolve() : scheduler.poll();
  const commands = installScheduleControls({ app: opts.app, owner: opts.owner, store, poll, stopping: opts.stopping,
    busy: key => {
      const thread = opts.state.getThread(key);
      return !!thread?.scheduledRunId && eligible(key, thread.sessionId);
    },
    cancel: async id => {
      const run = store.run(id);
      if (!run) throw new Error("unknown report run ID — use \\schedule history");
      if (["delivered", "failed", "canceled", "skipped"].includes(run.status)) throw new Error(`Report run is already ${run.status}.`);
      await runner.cancel(id);
    },
    cancelThread: async key => {
      const id = opts.state.getThread(key)?.scheduledRunId;
      if (id) await runner.cancel(id);
    },
  });
  return { commands, eligible, poll, close: () => scheduler.close() };
}
