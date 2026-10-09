import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import type { CmdCtx } from "../src/commands/registry.js";
import { execute } from "../src/commands/registry.js";
import "../src/commands/handlers.js";
import { installScheduleControls, lastRunStatus, parseScheduleFields, scheduleConfirmView, scheduleCreateView } from "../src/schedules/controls.js";
import { ScheduleStore, type ScheduleRun } from "../src/schedules/store.js";

const root = resolve("test/.fixtures/schedule-controls");
const NOW = Date.parse("2026-10-03T19:00:00Z");
/** `destination` is the radio choice; `channel` is the conversations_select value. */
function fields(overrides: Record<string, string | null> = {}) {
  const { destination = "dm", channel = null, ...rest } = overrides;
  const values: any = Object.fromEntries(Object.entries({ name: "Daily report", time: "18:00", timezone: "America/Los_Angeles",
    directory: root, prompt: "Summarize the project files; do not edit.", model: "", agent: "", timeout: "15", ...rest })
    .map(([id, value]) => [id, { value: { value } }]));
  values.days = { value: { selected_options: [0, 1, 2, 3, 4, 5, 6].map(d => ({ value: String(d) })) } };
  values.destination = { value: { selected_option: { value: destination } } };
  values.channel = { value: { selected_conversation: channel } };
  return values;
}
function setup() {
  const actions = new Map<string, Function>();
  const views = new Map<string, Function>();
  const app = { action: (id: string, fn: Function) => actions.set(id, fn), view: (id: string, fn: Function) => views.set(id, fn),
    client: { views: { open: vi.fn(async (_: any) => ({})) }, conversations: { history: vi.fn(async (_: any) => ({ ok: true })) } } };
  const store = new ScheduleStore(`${root}/schedules.json`, () => NOW);
  const poll = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const controls = installScheduleControls({ app: app as unknown as App, owner: "UOWNER", store, now: () => NOW,
    cancel, poll, stopping: () => false });
  const ctx = { channelId: "DOWNER", threadTs: "100.001", thread: null, state: { currentProjectDir: root }, cwd: root,
    render: { post: vi.fn(async () => ({ ts: "101.001" })) }, postToThread: vi.fn(async () => {}) } as unknown as CmdCtx;
  return { app, actions, views, store, controls, ctx, poll, cancel };
}
beforeEach(() => mkdirSync(root, { recursive: true }));
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scheduled report controls", () => {
  it("validates explicit zone, project, days, time, target and runtime", () => {
    expect(parseScheduleFields(fields())).toMatchObject({ projectDir: root, timeoutMs: 900_000, destination: { kind: "dm" } });
    const invalid: Array<Record<string, string>> = [{ time: "6pm" }, { timezone: "not/a-zone" }, { directory: "/missing-project-fixture" },
      { destination: "channel" }, { timeout: "0" }, { model: "guess" }, { prompt: "" }];
    for (const overrides of invalid) {
      expect(() => parseScheduleFields(fields(overrides))).toThrow();
    }
    const noDays = fields(); noDays.days.value.selected_options = [];
    expect(() => parseScheduleFields(noDays)).toThrow("Select at least one day");
  });

  it("builds bounded native modals and a plain-text confirmation", () => {
    const form = scheduleCreateView("draft", { projectDir: root });
    expect(form.blocks).toHaveLength(11);
    expect(form.title.text.length).toBeLessThanOrEqual(24);
    const preview = scheduleConfirmView("draft", parseScheduleFields(fields({ name: "<@UALL>" })), NOW);
    expect(preview.blocks.every(b => b.text.type === "plain_text")).toBe(true);
    expect(preview.blocks.map(b => b.text.text).join(" ")).toContain("Read-only tools");
  });

  it("parses the DM choice and the channel picker's selected_conversation", () => {
    expect(parseScheduleFields(fields({ destination: "channel", channel: "C0REPORTS" })).destination).toEqual({ kind: "channel", channelId: "C0REPORTS" });
    expect(parseScheduleFields(fields({ destination: "dm", channel: "C0REPORTS" })).destination).toEqual({ kind: "dm" });
    expect(() => parseScheduleFields(fields({ destination: "channel", channel: null }))).toThrow("Choose a channel");
  });

  it("prefills the edit form from the saved job", () => {
    const job = { ...parseScheduleFields(fields({ time: "07:30", destination: "channel", channel: "C0REPORTS", timeout: "20", model: "p/m" })),
      schedule: { time: "07:30", timezone: "Asia/Tokyo", days: [1, 3] } };
    const form = scheduleCreateView("draft", { projectDir: "/elsewhere", model: "other/model" }, job);
    const el = (id: string) => form.blocks.find(b => b.block_id === id)!.element as any;
    expect(form.title.text).toBe("Edit report");
    expect([el("time").initial_value, el("timezone").initial_value, el("timeout").initial_value, el("model").initial_value, el("directory").initial_value])
      .toEqual(["07:30", "Asia/Tokyo", "20", "p/m", root]);
    expect(el("days").initial_options.map((o: any) => o.value)).toEqual(["1", "3"]);
    expect(el("destination").initial_option.value).toBe("channel");
    expect(el("channel")).toMatchObject({ type: "conversations_select", initial_conversation: "C0REPORTS",
      filter: { include: ["public", "private"], exclude_bot_users: true } });
    expect(el("agent").initial_value).toBeUndefined();
  });

  it("edit keeps the id and history, recomputes the next run, and leaves active runs alone", async () => {
    const s = setup(); const job = s.store.createJob(parseScheduleFields(fields()));
    const run = s.store.claim(job.id, NOW, true);
    await s.controls.run(s.ctx, `change ${job.id}`);
    const token = (s.ctx.render!.post as any).mock.calls[0][3][1].elements[0].value;
    const ack = vi.fn(async (_?: any) => {});
    await s.actions.get("schedule_add")!({ body: { user: { id: "UOWNER" }, trigger_id: "trigger" }, action: { value: token }, ack });
    expect(s.app.client.views.open.mock.calls[0]![0].view.title.text).toBe("Edit report");
    const submission = { body: { user: { id: "UOWNER" } }, view: { private_metadata: token,
      state: { values: fields({ time: "09:15", destination: "channel", channel: "C0REPORTS" }) } }, ack };
    await s.views.get("schedule_create")!(submission);
    const preview = ack.mock.calls.at(-1)![0].view;
    expect(preview.submit.text).toBe("Save changes");
    expect(preview.blocks.map((b: any) => b.text.text).join(" ")).toContain("a run already in progress keeps its original settings");
    await s.views.get("schedule_confirm")!(submission);
    await s.views.get("schedule_confirm")!(submission);
    const saved = s.store.jobs();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: job.id, createdAt: job.createdAt, destination: { kind: "channel", channelId: "C0REPORTS" } });
    expect(saved[0]!.nextRunAt).toBe(Date.parse("2026-10-03T16:15:00Z") + 86_400_000);
    expect(s.store.run(run.id)).toMatchObject({ status: "claimed", snapshot: { schedule: { time: "18:00" } } });
  });

  it("refuses a channel the bot is not in", async () => {
    const s = setup();
    s.app.client.conversations.history.mockRejectedValueOnce(Object.assign(new Error("x"), { data: { error: "not_in_channel" } }));
    await s.controls.run(s.ctx, "add");
    const token = (s.ctx.render!.post as any).mock.calls[0][3][1].elements[0].value;
    const ack = vi.fn(async (_?: any) => {});
    await s.views.get("schedule_create")!({ body: { user: { id: "UOWNER" } },
      view: { private_metadata: token, state: { values: fields({ destination: "channel", channel: "C0REPORTS" }) } }, ack });
    expect(ack).toHaveBeenCalledWith({ response_action: "errors", errors: { channel: expect.stringContaining("not in this channel") } });
  });

  it("shows the newest run's outcome in the job's zone", async () => {
    const tz = "America/Los_Angeles"; // NOW is Sat 12:00 PM there
    const run = (status: ScheduleRun["status"], scheduledAt: string, startedAt = Date.parse(scheduledAt)) =>
      ({ status, scheduledAt: Date.parse(scheduledAt), startedAt }) as ScheduleRun;
    expect(lastRunStatus([], tz, NOW)).toBeUndefined();
    expect(lastRunStatus([run("failed", "2026-10-02T15:00:00Z"), run("delivered", "2026-10-03T15:02:00Z")], tz, NOW)).toBe("✓ delivered 8:02 AM");
    expect(lastRunStatus([run("failed", "2026-09-29T01:00:00Z")], tz, NOW)).toBe("✕ failed Mon 6:00 PM");
    expect(lastRunStatus([run("skipped", "2026-09-20T16:00:00Z")], tz, NOW)).toBe("⚠ skipped Sep 20 9:00 AM");
    expect(lastRunStatus([run("uncertain", "2026-10-03T15:00:00Z")], tz, NOW)).toBe("? uncertain 8:00 AM");
    expect(lastRunStatus([run("waiting", "2026-10-03T15:00:00Z")], tz, NOW)).toBe("… waiting for you");
    // Newest by start: a manual run started later wins over a later-scheduled skip.
    expect(lastRunStatus([run("skipped", "2026-10-03T18:00:00Z", 1), run("running", "2026-10-03T17:00:00Z", 2)], tz, NOW)).toBe("… running");

    const s = setup(); const job = s.store.createJob(parseScheduleFields(fields()));
    s.store.skipOccurrence(job.id, Date.parse("2026-10-03T16:00:00Z"), "missed");
    await s.controls.run(s.ctx, "");
    expect(s.ctx.postToThread).toHaveBeenCalledWith(expect.stringContaining("· on · last ⚠ skipped 9:00 AM\n"));
  });

  it("owner-only preview and explicit confirmation create exactly one task", async () => {
    const s = setup();
    await s.controls.run(s.ctx, "add");
    const blocks = (s.ctx.render!.post as any).mock.calls[0][3];
    const token = blocks[1].elements[0].value;
    const ack = vi.fn(async (_?: any) => {});
    await s.actions.get("schedule_add")!({ body: { user: { id: "UOTHER" }, trigger_id: "trigger" }, action: { value: token }, ack });
    expect(s.app.client.views.open).not.toHaveBeenCalled();
    await s.actions.get("schedule_add")!({ body: { user: { id: "UOWNER" }, trigger_id: "trigger" }, action: { value: token }, ack });
    expect(s.app.client.views.open).toHaveBeenCalledOnce();
    const submission = { body: { user: { id: "UOWNER" } }, view: { private_metadata: token, state: { values: fields() } }, ack };
    await s.views.get("schedule_create")!(submission);
    expect(s.store.jobs()).toHaveLength(0);
    expect(ack.mock.calls.at(-1)?.[0]?.response_action).toBe("update");
    await s.views.get("schedule_confirm")!(submission);
    await s.views.get("schedule_confirm")!(submission);
    expect(s.store.jobs()).toHaveLength(1);
    expect(s.store.jobs()[0]!.nextRunAt).toBeGreaterThan(NOW);
    expect(s.poll).not.toHaveBeenCalled();
  });

  it("does not save unauthorized or unpreviewed submissions", async () => {
    const s = setup();
    await s.controls.run(s.ctx, "add");
    const token = (s.ctx.render!.post as any).mock.calls[0][3][1].elements[0].value;
    const ack = vi.fn(async (_?: any) => {});
    await s.views.get("schedule_confirm")!({ body: { user: { id: "UOWNER" } }, view: { private_metadata: token }, ack });
    await s.views.get("schedule_create")!({ body: { user: { id: "UOTHER" } }, view: { private_metadata: token, state: { values: fields() } }, ack });
    expect(s.store.jobs()).toHaveLength(0);
  });

  it("pause and remove retain active runs; manual run has a separate occurrence", async () => {
    const s = setup(); const job = s.store.createJob(parseScheduleFields(fields()));
    await s.controls.run(s.ctx, `run ${job.id}`);
    const run = s.store.runs()[0]!;
    expect(run.manual).toBe(true);
    await expect(s.controls.run(s.ctx, `run ${job.id}`)).rejects.toThrow("another scheduled report");
    await s.controls.run(s.ctx, `pause ${job.id}`);
    expect(s.store.job(job.id)?.enabled).toBe(false);
    await s.controls.run(s.ctx, `resume ${job.id}`);
    expect(s.store.job(job.id)?.nextRunAt).toBeGreaterThan(NOW);
    await s.controls.run(s.ctx, `remove ${job.id}`);
    expect(s.store.job(job.id)).toBeUndefined();
    expect(s.store.run(run.id)?.status).toBe("claimed");
  });

  it("command registry delegates and reports scheduler unavailability", async () => {
    const s = setup(); s.ctx.schedules = { ...s.controls, busy: () => false, cancelThread: async () => {} };
    await execute({ name: "schedule", args: "" }, s.ctx);
    expect(s.ctx.postToThread).toHaveBeenCalledWith(expect.stringContaining("No scheduled reports"));
    s.ctx.schedules = undefined;
    await execute({ name: "schedule", args: "" }, s.ctx);
    expect(s.ctx.postToThread).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });
});
