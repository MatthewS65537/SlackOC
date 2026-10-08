import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { App } from "@slack/bolt";
import type { CmdCtx, ScheduleCommands } from "../commands/registry.js";
import { canonicalDir } from "../paths.js";
import { chunkText, esc } from "../util.js";
import { nextOccurrence } from "./recurrence.js";
import { isGenerationActive, type NewScheduleJob, type ScheduleJob, type ScheduleStore } from "./store.js";

const ADD_ACTION = "schedule_add";
const EDIT_VIEW = "schedule_create";
const CONFIRM_VIEW = "schedule_confirm";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DRAFT_TTL_MS = 15 * 60_000;
const plain = (text: string) => ({ type: "plain_text", text });
const field = (id: string, label: string, element: Record<string, unknown>, optional = false) =>
  ({ type: "input", block_id: id, label: plain(label), optional, element: { ...element, action_id: "value" } });
const textField = (id: string, label: string, initial: string, extra: Record<string, unknown> = {}, optional = false) =>
  field(id, label, { type: "plain_text_input", ...(initial ? { initial_value: initial } : {}), ...extra }, optional);

export function scheduleDescription(job: Pick<ScheduleJob, "schedule">): string {
  const { days, time, timezone } = job.schedule;
  return `${days.length === 7 ? "Daily" : days.map(d => DAY_NAMES[d]).join(", ")} ${time} · ${timezone}`;
}

export function scheduleCreateView(token: string, defaults: { projectDir: string; model?: string; agent?: string }) {
  const days = DAY_NAMES.map((day, i) => ({ text: plain(day), value: String(i) }));
  return {
    type: "modal", callback_id: EDIT_VIEW, private_metadata: token,
    title: plain("Schedule a report"), submit: plain("Preview"), close: plain("Cancel"),
    blocks: [
      textField("name", "Report name", "Daily report", { max_length: 80 }),
      textField("time", "Start time (24-hour HH:mm)", "18:00", { max_length: 5 }),
      textField("timezone", "Time zone (confirm explicitly)", Intl.DateTimeFormat().resolvedOptions().timeZone, { max_length: 80 }),
      field("days", "Days (all selected = daily)", { type: "multi_static_select", options: days, initial_options: days }),
      textField("directory", "Saved project directory", defaults.projectDir, { max_length: 1000 }),
      textField("prompt", "Report prompt and information sources", "", { multiline: true, max_length: 6000 }),
      textField("destination", "Destination: dm or channel ID (C…)", "dm", { max_length: 80 }),
      textField("model", "Model (optional provider/model)", defaults.model ?? "", { max_length: 160 }, true),
      textField("agent", "Agent (optional; read-only policy still applies)", defaults.agent ?? "", { max_length: 100 }, true),
      textField("timeout", "Runtime limit in minutes (1–60)", "15", { max_length: 2 }),
    ],
  };
}

type Values = Record<string, { value?: { value?: string | null; selected_options?: Array<{ value: string }> } }>;
export class ScheduleFieldError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}

export function parseScheduleFields(values: Values): NewScheduleJob {
  const value = (id: string) => values[id]?.value?.value?.trim() ?? "";
  const fail = (id: string, message: string): never => { throw new ScheduleFieldError(id, message); };
  const name = value("name");
  if (!name || name.length > 80) fail("name", "Use a name between 1 and 80 characters.");
  const time = value("time");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("time", "Use HH:mm, for example 18:00.");
  const timezone = value("timezone");
  try { if (!timezone) throw new Error(); new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { fail("timezone", "Use a valid IANA time zone, such as America/Los_Angeles."); }
  const days = [...new Set((values.days?.value?.selected_options ?? []).map(o => Number(o.value)))].sort();
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail("days", "Select at least one day.");
  let directory = value("directory");
  if (directory === "~") directory = homedir();
  else if (directory.startsWith("~/")) directory = resolve(homedir(), directory.slice(2));
  if (!directory.startsWith("/") || !statSync(directory, { throwIfNoEntry: false })?.isDirectory()) fail("directory", "Use an existing absolute project directory.");
  const prompt = value("prompt");
  if (!prompt || prompt.length > 6000) fail("prompt", "Describe the report and its sources (1–6000 characters).");
  const target = value("destination");
  if (target !== "dm" && !/^C[A-Z0-9]+$/.test(target)) fail("destination", "Use dm or a channel ID starting with C. Invite the bot first.");
  const timeout = Number(value("timeout"));
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) fail("timeout", "Use a runtime limit from 1 to 60 minutes.");
  const model = value("model");
  if (model && !/^[^\s/]+\/[^\s/]+$/.test(model)) fail("model", "Use provider/model, or leave this blank.");
  const agent = value("agent");
  if (agent && (agent.length > 100 || /\s/.test(agent))) fail("agent", "Use one agent ID, or leave this blank.");
  return { name, projectDir: canonicalDir(directory), prompt, schedule: { time, timezone, days },
    destination: target === "dm" ? { kind: "dm" } : { kind: "channel", channelId: target },
    timeoutMs: timeout * 60_000, ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
}

export function scheduleConfirmView(token: string, input: NewScheduleJob, now: number) {
  const next = new Date(nextOccurrence(input.schedule, now)).toLocaleString("en-US", { timeZone: input.schedule.timezone });
  return { type: "modal", callback_id: CONFIRM_VIEW, private_metadata: token,
    title: plain("Confirm report"), submit: plain("Create schedule"), close: plain("Cancel"), blocks: [
      { type: "section", text: plain(`${input.name}\n${scheduleDescription(input)}\nNext start: ${next}\nProject: ${input.projectDir}\nDestination: ${input.destination.kind === "dm" ? "your DM" : input.destination.channelId}\nRuntime: ${input.timeoutMs / 60_000} minutes\nModel: ${input.model ?? "OpenCode default"}\nAgent: ${input.agent ?? "OpenCode default"}`) },
      ...chunkText(input.prompt, 2800).map(text => ({ type: "section", text: plain(text) })),
      { type: "section", text: plain("Starts generation at the scheduled time; delivery follows completion. Read-only tools; no shell, edits, subagents or MCP tools. Latest missed run only, within two hours. Approval/questions pause privately until the runtime deadline. Your Mac and bridge must be awake and online.") },
    ] };
}

export interface ControlOptions {
  app: App;
  owner: string;
  store: ScheduleStore;
  busy: ScheduleCommands["busy"];
  cancelThread: ScheduleCommands["cancelThread"];
  cancel: (runId: string) => Promise<void>;
  poll: () => Promise<void>;
  now?: () => number;
  stopping: () => boolean;
}

export function installScheduleControls(opts: ControlOptions): ScheduleCommands {
  const now = opts.now ?? Date.now;
  const drafts = new Map<string, { expires: number; defaults: { projectDir: string; model?: string; agent?: string }; input?: NewScheduleJob }>();
  const draft = (token: string) => {
    for (const [id, value] of drafts) if (value.expires <= now()) drafts.delete(id);
    return drafts.get(token);
  };
  opts.app.action(ADD_ACTION, async ({ body, action, ack }) => {
    await ack();
    if (body.user.id !== opts.owner || opts.stopping()) return;
    const token = (action as { value?: string }).value ?? "";
    const saved = draft(token);
    if (!saved) return;
    await opts.app.client.views.open({ trigger_id: (body as { trigger_id: string }).trigger_id,
      view: scheduleCreateView(token, saved.defaults) as never });
  });
  opts.app.view(EDIT_VIEW, async ({ body, view, ack }) => {
    if (body.user.id !== opts.owner || opts.stopping()) { await ack(); return; }
    const saved = draft(view.private_metadata);
    if (!saved) { await ack({ response_action: "errors", errors: { name: "Draft expired. Start again with \\schedule add." } }); return; }
    try {
      const input = parseScheduleFields(view.state.values as Values);
      saved.input = input;
      await ack({ response_action: "update", view: scheduleConfirmView(view.private_metadata, input, now()) as never });
    } catch (err) {
      await ack({ response_action: "errors", errors: { [err instanceof ScheduleFieldError ? err.field : "name"]: err instanceof Error ? err.message : "Invalid report definition." } });
    }
  });
  opts.app.view(CONFIRM_VIEW, async ({ body, view, ack }) => {
    if (body.user.id !== opts.owner || opts.stopping()) { await ack(); return; }
    const saved = draft(view.private_metadata);
    if (!saved?.input) { await ack(); return; }
    // Synchronous durable creation before ack, followed by consuming the token:
    // duplicate Slack submissions cannot create a second schedule.
    try {
      const job = opts.store.createJob(saved.input);
      drafts.delete(view.private_metadata);
      await ack({ response_action: "update", view: { type: "modal", title: plain("Report scheduled"), close: plain("Done"),
        blocks: [{ type: "section", text: plain(`Created ${job.name} (${job.id}).\n${scheduleDescription(job)}\nUse \\schedule to view next runs or manage this task.`) }] } as never });
    } catch (err) {
      await ack({ response_action: "update", view: { type: "modal", title: plain("Not scheduled"), close: plain("Close"),
        blocks: [{ type: "section", text: plain(`No schedule was created: ${err instanceof Error ? err.message : String(err)}`) }] } as never });
    }
  });
  return {
    busy: opts.busy, cancelThread: opts.cancelThread,
    async run(ctx: CmdCtx, args: string) {
      if (opts.stopping()) throw new Error("bridge stopping");
      const [action = "list", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length) throw new Error("usage: \\schedule [add|pause|resume|run|history|remove|cancel] [id]");
      if (action === "add") {
        if (id) throw new Error("use \\schedule add without arguments");
        draft("");
        if (drafts.size >= 100) throw new Error("too many open report drafts; wait for them to expire");
        const token = randomUUID();
        drafts.set(token, { expires: now() + DRAFT_TTL_MS, defaults: { projectDir: ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd,
          model: ctx.thread?.model, agent: ctx.thread?.agent } });
        await ctx.render?.post(ctx.channelId, ctx.threadTs, "Create a scheduled report — preview and confirmation required.", [
          { type: "section", text: { type: "mrkdwn", text: "Choose a daily/weekly schedule, project, report prompt and destination." } },
          { type: "actions", elements: [{ type: "button", text: plain("Create report"), action_id: ADD_ACTION, value: token }] },
        ], { lane: "interactive", unfurl: false });
        return;
      }
      if (action === "list") {
        if (id) throw new Error("use \\schedule without an ID to list tasks");
        const jobs = opts.store.jobs();
        const lines = jobs.map(job => `\`${job.id}\` — *${esc(job.name)}* · ${job.enabled ? "on" : "paused"}\n${scheduleDescription(job)} · next ${new Date(job.nextRunAt).toLocaleString("en-US", { timeZone: job.schedule.timezone })}\n${job.destination.kind === "dm" ? "your DM" : `<#${job.destination.channelId}>`} · \`${esc(job.projectDir)}\``);
        for (const text of chunkText(lines.length ? lines.join("\n\n") : "No scheduled reports. Use `\\schedule add` to create one.")) await ctx.postToThread(text);
        return;
      }
      if (action === "history") {
        const runs = opts.store.runs(id).sort((a, b) => b.startedAt - a.startedAt).slice(0, 12);
        for (const text of chunkText(runs.map(r => `\`${r.id}\` · ${esc(r.snapshot.name)} · *${r.status}* · ${new Date(r.scheduledAt).toISOString()}${r.error ? `\n${esc(r.error)}` : ""}`).join("\n\n") || "No report runs recorded.")) await ctx.postToThread(text);
        return;
      }
      if (!id) throw new Error(`usage: \\schedule ${action} <id>`);
      if (action === "cancel") { await opts.cancel(id); await ctx.postToThread("Report run canceled; future occurrences are unchanged."); return; }
      const job = opts.store.job(id);
      if (!job) throw new Error("unknown schedule ID — use \\schedule");
      if (action === "pause" || action === "resume") {
        opts.store.updateJob(id, j => { j.enabled = action === "resume"; j.nextRunAt = nextOccurrence(j.schedule, now()); });
        await ctx.postToThread(`${action === "pause" ? "Paused" : "Resumed"} *${esc(job.name)}*. ${action === "pause" ? "Active work is unchanged; use \\schedule cancel <run-id> to stop it." : "Next future occurrence only; no backfill."}`);
      } else if (action === "remove") {
        opts.store.removeJob(id);
        await ctx.postToThread(`Removed *${esc(job.name)}*. Run history and any active occurrence are retained.`);
      } else if (action === "run") {
        if (opts.store.runs().some(r => isGenerationActive(r, now()))) throw new Error("another scheduled report is active or uncertain — inspect \\schedule history first");
        const run = opts.store.claim(id, now(), true);
        await ctx.postToThread(`Queued report \`${run.id}\`. Its saved destination and read-only policy apply.`);
        void opts.poll();
      } else throw new Error("usage: \\schedule [add|pause|resume|run|history|remove|cancel] [id]");
    },
  };
}
