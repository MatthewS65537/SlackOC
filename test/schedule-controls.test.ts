import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "@slack/bolt";
import type { CmdCtx } from "../src/commands/registry.js";
import { execute } from "../src/commands/registry.js";
import "../src/commands/handlers.js";
import { installScheduleControls, parseScheduleFields, scheduleConfirmView, scheduleCreateView } from "../src/schedules/controls.js";
import { ScheduleStore } from "../src/schedules/store.js";

const root = resolve("test/.fixtures/schedule-controls");
const NOW = Date.parse("2026-10-03T19:00:00Z");
function fields(overrides: Record<string, string> = {}) {
  const values: any = Object.fromEntries(Object.entries({ name: "Daily report", time: "18:00", timezone: "America/Los_Angeles",
    directory: root, prompt: "Summarize the project files; do not edit.", destination: "dm", model: "", agent: "", timeout: "15", ...overrides })
    .map(([id, value]) => [id, { value: { value } }]));
  values.days = { value: { selected_options: [0, 1, 2, 3, 4, 5, 6].map(d => ({ value: String(d) })) } };
  return values;
}
function setup() {
  const actions = new Map<string, Function>();
  const views = new Map<string, Function>();
  const app = { action: (id: string, fn: Function) => actions.set(id, fn), view: (id: string, fn: Function) => views.set(id, fn),
    client: { views: { open: vi.fn(async () => ({})) } } };
  const store = new ScheduleStore(`${root}/schedules.json`, () => NOW);
  const poll = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const controls = installScheduleControls({ app: app as unknown as App, owner: "UOWNER", store, now: () => NOW,
    busy: () => false, cancelThread: vi.fn(async () => {}), cancel, poll, stopping: () => false });
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
      { destination: "#general" }, { timeout: "0" }, { model: "guess" }, { prompt: "" }];
    for (const overrides of invalid) {
      expect(() => parseScheduleFields(fields(overrides))).toThrow();
    }
    const noDays = fields(); noDays.days.value.selected_options = [];
    expect(() => parseScheduleFields(noDays)).toThrow("Select at least one day");
  });

  it("builds bounded native modals and a plain-text confirmation", () => {
    const form = scheduleCreateView("draft", { projectDir: root });
    expect(form.blocks).toHaveLength(10);
    expect(form.title.text.length).toBeLessThanOrEqual(24);
    const preview = scheduleConfirmView("draft", parseScheduleFields(fields({ name: "<@UALL>" })), NOW);
    expect(preview.blocks.every(b => b.text.type === "plain_text")).toBe(true);
    expect(preview.blocks.map(b => b.text.text).join(" ")).toContain("Read-only tools");
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
    const s = setup(); s.ctx.schedules = s.controls;
    await execute({ name: "schedule", args: "" }, s.ctx);
    expect(s.ctx.postToThread).toHaveBeenCalledWith(expect.stringContaining("No scheduled reports"));
    s.ctx.schedules = undefined;
    await execute({ name: "schedule", args: "" }, s.ctx);
    expect(s.ctx.postToThread).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });
});
