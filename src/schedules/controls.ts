import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { App } from "@slack/bolt";
import type { CmdCtx, ScheduleCommands } from "../commands/registry.js";
import { canonicalDir, expandHome } from "../paths.js";
import { chunkText, esc } from "../util.js";
import { ianaZone, nextOccurrence, validDays, validTime } from "./recurrence.js";
import { isGenerationActive, type NewScheduleJob, type ScheduleJob, type ScheduleRun, type ScheduleStore } from "./store.js";

export const SCHEDULE_USAGE = "\\schedule [add|edit|pause|resume|run|history|remove|cancel] [id]";
/** Opens the form for a create or edit draft (the draft decides which). */
const OPEN_ACTION = "schedule_add";
const EDIT_VIEW = "schedule_create";
const CONFIRM_VIEW = "schedule_confirm";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DRAFT_TTL_MS = 15 * 60_000;
const ACTION_ALIASES: Record<string, string> = { change: "edit", update: "edit" };
// Slack must receive the view ack within 3s; an unanswered probe defers to delivery-time errors.
const MEMBERSHIP_PROBE_MS = 2000;
/** Slack caps plain_text_input max_length at 3000; the form and parser share this prompt limit. */
export const PROMPT_MAX = 3000;
const plain = (text: string) => ({ type: "plain_text", text });
const field = (id: string, label: string, element: Record<string, unknown>, optional = false) =>
  ({ type: "input", block_id: id, label: plain(label), optional, element: { ...element, action_id: "value" } });
const textField = (id: string, label: string, initial: string, extra: Record<string, unknown> = {}, optional = false) =>
  field(id, label, { type: "plain_text_input", ...(initial ? { initial_value: initial } : {}), ...extra }, optional);

function scheduleDescription(job: Pick<ScheduleJob, "schedule">): string {
  const { days, time, timezone } = job.schedule;
  return `${days.length === 7 ? "Daily" : days.map(d => DAY_NAMES[d]).join(", ")} ${time} · ${timezone}`;
}

type Defaults = { projectDir: string; model?: string; agent?: string };

/** The create form; passing `job` prefills it for \\schedule edit. */
export function scheduleCreateView(token: string, defaults: Defaults, job?: NewScheduleJob) {
  const days = DAY_NAMES.map((day, i) => ({ text: plain(day), value: String(i) }));
  const targets = [{ text: plain("Your DM"), value: "dm" }, { text: plain("A channel"), value: "channel" }];
  const channel = job?.destination.kind === "channel" ? job.destination.channelId : undefined;
  return {
    type: "modal", callback_id: EDIT_VIEW, private_metadata: token,
    title: plain(job ? "Edit report" : "Schedule a report"), submit: plain("Preview"), close: plain("Cancel"),
    blocks: [
      textField("name", "Report name", job?.name ?? "Daily report", { max_length: 80 }),
      textField("time", "Start time (24-hour HH:mm)", job?.schedule.time ?? "18:00", { max_length: 5 }),
      textField("timezone", "Time zone (confirm explicitly)", job?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, { max_length: 80 }),
      field("days", "Days (all selected = daily)", { type: "multi_static_select", options: days,
        initial_options: job ? days.filter(d => job.schedule.days.includes(Number(d.value))) : days }),
      textField("directory", "Saved project directory", job?.projectDir ?? defaults.projectDir, { max_length: 1000 }),
      textField("prompt", "Report prompt and information sources", job?.prompt ?? "", { multiline: true, max_length: PROMPT_MAX }),
      // Radio + picker instead of one select: conversations_select cannot offer a "Your DM" entry.
      field("destination", "Deliver to", { type: "radio_buttons", options: targets, initial_option: targets[channel ? 1 : 0] }),
      field("channel", "Channel (used with \"A channel\"; invite the bot first)", { type: "conversations_select",
        filter: { include: ["public", "private"], exclude_bot_users: true }, ...(channel ? { initial_conversation: channel } : {}) }, true),
      textField("model", "Model (optional provider/model)", (job ? job.model : defaults.model) ?? "", { max_length: 160 }, true),
      textField("agent", "Agent (optional; read-only policy still applies)", (job ? job.agent : defaults.agent) ?? "", { max_length: 100 }, true),
      textField("timeout", "Runtime limit in minutes (1–60)", job ? String(job.timeoutMs / 60_000) : "15", { max_length: 2 }),
    ],
  };
}

type Values = Record<string, { value?: { value?: string | null; selected_options?: Array<{ value: string }>;
  selected_option?: { value: string } | null; selected_conversation?: string | null } }>;
class ScheduleFieldError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}

export function parseScheduleFields(values: Values): NewScheduleJob {
  const value = (id: string) => values[id]?.value?.value?.trim() ?? "";
  const fail = (id: string, message: string): never => { throw new ScheduleFieldError(id, message); };
  const name = value("name");
  if (!name || name.length > 80) fail("name", "Use a name between 1 and 80 characters.");
  const time = value("time");
  if (!validTime(time)) fail("time", "Use HH:mm, for example 18:00.");
  const timezone = value("timezone");
  if (!timezone || !ianaZone(timezone)) fail("timezone", "Use a valid IANA time zone, such as America/Los_Angeles.");
  const days = [...new Set((values.days?.value?.selected_options ?? []).map(o => Number(o.value)))].sort();
  if (!validDays(days)) fail("days", "Select at least one day.");
  const directory = expandHome(value("directory"));
  if (!directory.startsWith("/") || !statSync(directory, { throwIfNoEntry: false })?.isDirectory()) fail("directory", "Use an existing absolute project directory.");
  const prompt = value("prompt");
  if (!prompt || prompt.length > PROMPT_MAX) fail("prompt", `Describe the report and its sources (1–${PROMPT_MAX} characters).`);
  const target = values.destination?.value?.selected_option?.value === "channel" ? values.channel?.value?.selected_conversation ?? "" : "dm";
  if (target !== "dm" && !/^[CG][A-Z0-9]+$/.test(target)) fail("channel", "Choose a channel, or deliver to your DM.");
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

export function scheduleConfirmView(token: string, input: NewScheduleJob, now: number, editing = false) {
  const next = new Date(nextOccurrence(input.schedule, now)).toLocaleString("en-US", { timeZone: input.schedule.timezone });
  return { type: "modal", callback_id: CONFIRM_VIEW, private_metadata: token,
    title: plain(editing ? "Confirm changes" : "Confirm report"), submit: plain(editing ? "Save changes" : "Create schedule"), close: plain("Cancel"), blocks: [
      { type: "section", text: plain(`${input.name}\n${scheduleDescription(input)}\nNext start: ${next}\nProject: ${input.projectDir}\nDestination: ${input.destination.kind === "dm" ? "your DM" : input.destination.channelId}\nRuntime: ${input.timeoutMs / 60_000} minutes\nModel: ${input.model ?? "OpenCode default"}\nAgent: ${input.agent ?? "OpenCode default"}`) },
      ...(editing ? [{ type: "section", text: plain("Saving keeps this report's ID and run history. Changes apply to future occurrences; a run already in progress keeps its original settings.") }] : []),
      ...chunkText(input.prompt, 2800).map(text => ({ type: "section", text: plain(text) })),
      { type: "section", text: plain("Starts generation at the scheduled time; delivery follows completion. Read-only tools; no shell, edits, subagents or MCP tools. Latest missed run only, within two hours. Approval/questions pause privately until the runtime deadline. Your Mac and bridge must be awake and online.") },
    ] };
}

const RUN_LABELS: Record<ScheduleRun["status"], string> = {
  delivered: "✓ delivered", skipped: "⚠ skipped", failed: "✕ failed", canceled: "✕ canceled", uncertain: "? uncertain",
  claimed: "… running", creating: "… running", submitting: "… running", running: "… running",
  waiting: "… waiting for you", ready: "… delivering", delivering: "… delivering",
};

/** "8:02 AM" today, "Tue 6:00 PM" this week, else "Oct 1 6:00 PM" — in the job's zone. */
function shortTime(at: number, timeZone: string, now: number): string {
  const day = (t: number) => new Date(t).toLocaleDateString("en-US", { timeZone });
  const time = new Date(at).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const date = day(at) === day(now) ? "" : new Date(at).toLocaleDateString("en-US",
    { timeZone, ...(now - at < 6 * 86_400_000 ? { weekday: "short" } : { month: "short", day: "numeric" }) }) + " ";
  return (date + time).replace(/\u202f/g, " ");
}

/** Outcome of the newest run (by start), timed at its occurrence; active runs show no time. */
export function lastRunStatus(runs: ScheduleRun[], timeZone: string, now: number): string | undefined {
  const run = runs.reduce<ScheduleRun | undefined>((a, b) => !a || b.startedAt > a.startedAt ? b : a, undefined);
  if (!run) return undefined;
  const label = RUN_LABELS[run.status];
  return label.startsWith("…") ? label : `${label} ${shortTime(run.scheduledAt, timeZone, now)}`;
}

interface ControlOptions {
  app: App;
  owner: string;
  store: ScheduleStore;
  cancel: (runId: string) => Promise<void>;
  poll: () => Promise<void>;
  now?: () => number;
  stopping: () => boolean;
}

export function installScheduleControls(opts: ControlOptions): Pick<ScheduleCommands, "run"> {
  const now = opts.now ?? Date.now;
  // A draft with jobId edits that job; the job is reread when the form opens and saved via updateJob.
  const drafts = new Map<string, { expires: number; defaults: Defaults; jobId?: string; input?: NewScheduleJob }>();
  const draft = (token: string) => {
    for (const [id, value] of drafts) if (value.expires <= now()) drafts.delete(id);
    return drafts.get(token);
  };
  const newDraft = (defaults: Defaults, jobId?: string) => {
    draft("");
    if (drafts.size >= 100) throw new Error("too many open report drafts; wait for them to expire");
    const token = randomUUID();
    drafts.set(token, { expires: now() + DRAFT_TTL_MS, defaults, ...(jobId ? { jobId } : {}) });
    return token;
  };
  /** True only when Slack says the bot cannot see the channel; other failures surface at delivery. */
  const notMember = (channel: string) => Promise.race([
    opts.app.client.conversations.history({ channel, limit: 1 })
      .then(() => false, (err: { data?: { error?: string } }) => ["not_in_channel", "channel_not_found"].includes(err?.data?.error ?? "")),
    new Promise<boolean>(done => setTimeout(done, MEMBERSHIP_PROBE_MS, false).unref()),
  ]);
  opts.app.action(OPEN_ACTION, async ({ body, action, ack }) => {
    await ack();
    if (body.user.id !== opts.owner || opts.stopping()) return;
    const token = (action as { value?: string }).value ?? "";
    const saved = draft(token);
    if (!saved) return;
    const job = saved.jobId ? opts.store.job(saved.jobId) : undefined;
    if (saved.jobId && !job) return;
    await opts.app.client.views.open({ trigger_id: (body as { trigger_id: string }).trigger_id,
      view: scheduleCreateView(token, saved.defaults, job) as never });
  });
  opts.app.view(EDIT_VIEW, async ({ body, view, ack }) => {
    if (body.user.id !== opts.owner || opts.stopping()) { await ack(); return; }
    const saved = draft(view.private_metadata);
    if (!saved) { await ack({ response_action: "errors", errors: { name: "Draft expired. Start again with \\schedule add." } }); return; }
    try {
      const input = parseScheduleFields(view.state.values as Values);
      if (input.destination.kind === "channel" && await notMember(input.destination.channelId)) {
        throw new ScheduleFieldError("channel", "The bot is not in this channel. Invite it first, or deliver to your DM.");
      }
      saved.input = input;
      await ack({ response_action: "update", view: scheduleConfirmView(view.private_metadata, input, now(), !!saved.jobId) as never });
    } catch (err) {
      await ack({ response_action: "errors", errors: { [err instanceof ScheduleFieldError ? err.field : "name"]: err instanceof Error ? err.message : "Invalid report definition." } });
    }
  });
  opts.app.view(CONFIRM_VIEW, async ({ body, view, ack }) => {
    if (body.user.id !== opts.owner || opts.stopping()) { await ack(); return; }
    const saved = draft(view.private_metadata);
    if (!saved?.input) { await ack(); return; }
    // Synchronous durable save before ack, followed by consuming the token:
    // duplicate Slack submissions cannot create a second schedule or reapply an edit.
    const { input, jobId } = saved;
    try {
      // Edits keep id/history; updateJob recomputes nextRunAt. Active runs use their own snapshot.
      const job = jobId
        ? opts.store.updateJob(jobId, j => { delete j.model; delete j.agent; Object.assign(j, structuredClone(input)); })
        : opts.store.createJob(input);
      drafts.delete(view.private_metadata);
      await ack({ response_action: "update", view: { type: "modal", title: plain(jobId ? "Report updated" : "Report scheduled"), close: plain("Done"),
        blocks: [{ type: "section", text: plain(`${jobId ? "Updated" : "Created"} ${job.name} (${job.id}).\n${scheduleDescription(job)}\nUse \\schedule to view next runs or manage this task.`) }] } as never });
    } catch (err) {
      await ack({ response_action: "update", view: { type: "modal", title: plain(jobId ? "Not saved" : "Not scheduled"), close: plain("Close"),
        blocks: [{ type: "section", text: plain(`${jobId ? "No changes were saved" : "No schedule was created"}: ${err instanceof Error ? err.message : String(err)}`) }] } as never });
    }
  });
  return {
    async run(ctx: CmdCtx, args: string) {
      if (opts.stopping()) throw new Error("bridge stopping");
      const [raw = "list", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      const action = ACTION_ALIASES[raw] ?? raw;
      if (extra.length) throw new Error(`usage: ${SCHEDULE_USAGE}`);
      if (action === "add") {
        if (id) throw new Error("use \\schedule add without arguments");
        const token = newDraft({ projectDir: ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd),
          model: ctx.thread?.model, agent: ctx.thread?.agent });
        await ctx.render?.post(ctx.channelId, ctx.threadTs, "Create a scheduled report — preview and confirmation required.", [
          { type: "section", text: { type: "mrkdwn", text: "Choose a daily/weekly schedule, project, report prompt and destination." } },
          { type: "actions", elements: [{ type: "button", text: plain("Create report"), action_id: OPEN_ACTION, value: token }] },
        ], { lane: "interactive", unfurl: false });
        return;
      }
      if (action === "list") {
        if (id) throw new Error("use \\schedule without an ID to list tasks");
        const jobs = opts.store.jobs();
        const runs = opts.store.runs();
        const last = (job: ScheduleJob) => {
          const status = lastRunStatus(runs.filter(r => r.jobId === job.id), job.schedule.timezone, now());
          return status ? ` · last ${status}` : "";
        };
        const lines = jobs.map(job => `\`${job.id}\` — *${esc(job.name)}* · ${job.enabled ? "on" : "paused"}${last(job)}\n${scheduleDescription(job)} · next ${new Date(job.nextRunAt).toLocaleString("en-US", { timeZone: job.schedule.timezone })}\n${job.destination.kind === "dm" ? "your DM" : `<#${job.destination.channelId}>`} · \`${esc(job.projectDir)}\``);
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
      if (action === "edit") {
        // Older releases saved prompts up to 6000 characters; never truncate one into the form.
        if (job.prompt.length > PROMPT_MAX) throw new Error(`this report's saved prompt is longer than Slack's ${PROMPT_MAX}-character form limit, so it cannot be edited here; it still runs unchanged — remove and re-add it with a shorter prompt to change it`);
        const token = newDraft({ projectDir: job.projectDir }, id);
        await ctx.render?.post(ctx.channelId, ctx.threadTs, `Edit ${esc(job.name)} — preview and confirmation required.`, [
          { type: "section", text: { type: "mrkdwn", text: `Edit *${esc(job.name)}*. Changes apply to future occurrences; a run in progress is unaffected.` } },
          { type: "actions", elements: [{ type: "button", text: plain("Edit report"), action_id: OPEN_ACTION, value: token }] },
        ], { lane: "interactive", unfurl: false });
      } else if (action === "pause" || action === "resume") {
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
      } else throw new Error(`usage: ${SCHEDULE_USAGE}`);
    },
  };
}
