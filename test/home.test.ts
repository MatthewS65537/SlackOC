import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME_PERM_DENY, HOME_PERM_ONCE, HOME_REFRESH_MS, HOME_STOP, homeView, notOwnerView, registerHome } from "../src/slack/home.js";
import { PermissionDeliveryStore, PermissionResponder, type PermissionRecord } from "../src/slack/permissions.js";
import { describeActiveRuns } from "../src/slack/render.js";

vi.mock("../src/slack/render.js", async (importOriginal) => ({ ...await importOriginal<object>(), describeActiveRuns: vi.fn(() => []) }));

const text = (v: { blocks: unknown[] }) => JSON.stringify(v.blocks);

describe("Home tab (C2)", () => {
  it("lists runs, waiting items, reports and usage with thread links", () => {
    const v = homeView({
      runs: [{ project: "slackoc", url: "https://x.slack.com/archives/C1/p1", elapsedMs: 65_000, queued: 1 }],
      waiting: [{ kind: "permission", title: "bash: rm -rf dist", project: "slackoc", url: null, detail: ["command: `rm -rf dist`"] }],
      reports: [{ name: "Morning brief", enabled: true, nextRunAt: 1_800_000_000_000 }, { name: "Old", enabled: false, nextRunAt: 0 }],
      usage: "*$1.82*\n1.2M tokens · 4 sessions · 1 active day",
    });
    expect(v.type).toBe("home");
    const t = text(v);
    expect(t).toContain("▶ <https://x.slack.com/archives/C1/p1|slackoc> · 1m 5s · 1 queued");
    expect(t).toContain("🔐 slackoc · bash: rm -rf dist\\ncommand: `rm -rf dist`"); // what Approve would allow (JSON-escaped newline)
    expect(t).toContain("<!date^1800000000^");
    expect(t).toContain("⏸ *Old* · paused");
    expect(t).toContain("$1.82");
  });

  it("shows a report's last outcome on its row, so a skip is visible (#34)", () => {
    const t = text(homeView({ runs: [], waiting: [], usage: null,
      reports: [{ name: "News", enabled: true, nextRunAt: 1_800_000_000_000, last: "⚠ skipped 8:00 AM" }, { name: "Fresh", enabled: true, nextRunAt: 0 }] }));
    expect(t).toMatch(/\*News\* · next <!date\^1800000000\^[^>]*> · last ⚠ skipped 8:00 AM/);
    expect(t).not.toMatch(/\*Fresh\*[^"]*last/);
  });

  it("shows empty states instead of blank sections", () => {
    const t = text(homeView({ runs: [], waiting: [], reports: [], usage: null }));
    expect(t).toContain("Nothing running.");
    expect(t).toContain("Nothing is waiting on you.");
    expect(t).toContain("Usage is unavailable");
  });

  it("gives non-owners a one-line stub", () => {
    expect(text(notOwnerView())).toContain("belongs to someone else");
  });
});

describe("live Home tab (E2)", () => {
  const FIXTURES = join(import.meta.dirname, ".fixtures", "home");
  afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));
  afterEach(() => { vi.useRealTimers(); });
  const KEY = "C1:100.000001";
  const record = (): PermissionRecord => ({
    projectDir: "/project", sessionId: "ses_1", requestId: "per_1", generation: 2, threadKey: KEY,
    permission: { id: "per_1", sessionID: "ses_1", type: "bash", title: "Run tests" },
    ownerActivityTs: "100.000001", firstObservedAt: 1, updatedAt: 1,
    thread: { format: "card", status: "new", attempts: 0 }, dm: { format: "card", status: "new", attempts: 0 },
    response: { status: "pending" },
  });

  /** registerHome on a fake Bolt app; `respond` stands in for bridge.permissions.respond. */
  function rig(opts: { records?: PermissionRecord[]; respond?: (input: any) => Promise<any> } = {}) {
    const events = new Map<string, any>();
    const actions: Array<[string | RegExp, any]> = [];
    const publish = vi.fn(async (_args: any) => ({}));
    const app = { event: (n: string, h: any) => events.set(n, h), action: (id: string | RegExp, h: any) => actions.push([id, h]), client: { views: { publish } } };
    const posts: string[] = [];
    const ensure = vi.fn(async () => ({ client: { v2: { session: { inbox: { list: async () => [] } } } } }));
    const state = { currentProjectDir: undefined, cancelRecovery: () => {}, getThread: (k: string) => k === KEY ? { sessionId: "ses_1", projectDir: "/project" } : undefined };
    const respond = vi.fn(opts.respond ?? (async () => ({ status: "resolved", text: "ok" })));
    const bridge = { state, pool: { ensure }, config: { ownerSlackUserId: "U1" }, ownerDmChannel: () => "D1",
      render: { post: async (_c: string, _t: string, text: string) => { posts.push(text); return { ts: "1.1" }; } },
      permissions: { list: async () => "", respond } };
    const home = registerHome(app as never, { ownerSlackUserId: "U1", state: state as never, pool: { get: () => undefined } as never,
      permissions: { list: () => opts.records ?? [] }, questions: { list: () => [] }, reports: () => [], threadUrl: () => null,
      isStopping: () => false, bridge: bridge as never });
    const open = (user: string) => events.get("app_home_opened")({ event: { user, tab: "home" } });
    const click = (id: string, user: string, value: string) => actions.find(([k]) => typeof k === "string" ? k === id : k.test(id))![1]({
      ack: async () => {}, respond: vi.fn(async () => {}), body: { user: { id: user }, view: { type: "home" } }, action: { action_id: id, value } });
    const lastView = () => publish.mock.calls.at(-1)![0].view as { blocks: any[] };
    return { home, publish, open, click, posts, ensure, respond, lastView };
  }

  it("coalesces a burst of changes into one publish, and never publishes before the owner opened Home", async () => {
    vi.useFakeTimers();
    const { home, publish, open } = rig();
    await open("U2"); // a non-owner's open doesn't arm the owner's refreshes
    home.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(publish.mock.calls.map(c => c[0].user_id)).toEqual(["U2"]);
    await open("U1");
    expect(publish).toHaveBeenCalledTimes(2);
    home.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(1_000);
    home.scheduleRefresh(); home.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(HOME_REFRESH_MS - 1_001);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2]![0].user_id).toBe("U1");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("ignores every Home button from anyone but the owner", async () => {
    const { click, publish, posts, ensure, respond } = rig({ records: [record()] });
    const perm = JSON.stringify({ k: KEY, s: "ses_1", p: "per_1", g: 2 });
    await click(HOME_STOP, "U2", KEY);
    await click(HOME_PERM_ONCE, "U2", perm);
    await click(HOME_PERM_DENY, "U2", perm);
    await click("quick_run_0", "U2", "review");
    expect(ensure).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("lists a \\watch run without Stop: the TUI is driving that session", async () => {
    vi.mocked(describeActiveRuns).mockReturnValueOnce([
      { projectDir: "/p/tui", sessionId: "s1", threadKey: "C1:1.1", elapsedMs: 1000, queued: 0, watching: true },
      { projectDir: "/p/slack", sessionId: "s2", threadKey: "C1:2.2", elapsedMs: 1000, queued: 0, watching: false },
    ]);
    const { open, lastView } = rig();
    await open("U1");
    expect(text(lastView())).toContain("tui");
    expect(lastView().blocks.filter(b => b.accessory?.action_id === HOME_STOP).map(b => b.accessory.value)).toEqual(["C1:2.2"]);
  });

  it("Stop runs the \\stop path for that thread and republishes", async () => {
    const { click, posts, ensure, publish } = rig();
    await click(HOME_STOP, "U1", KEY);
    expect(ensure).toHaveBeenCalledWith("/project");
    expect(posts).toEqual(["Nothing running in this thread."]); // no live view in this test
    expect(publish).toHaveBeenCalledOnce();
  });

  it("Approve once and Deny go through the card buttons' responder; a refused reply shows on Home", async () => {
    mkdirSync(FIXTURES, { recursive: true });
    const store = new PermissionDeliveryStore(join(FIXTURES, "permissions.json"));
    store.put(record());
    const server = {};
    let generation = 2;
    const reply = vi.fn(async () => {});
    const resolved = vi.fn(async () => {});
    const responder = new PermissionResponder({ ownerSlackUserId: "U1", store, getRunning: () => server,
      getBinding: () => ({ projectDir: "/project", sessionId: "ses_1", generation }),
      findPending: async () => [record().permission], respond: reply, resolved });
    const { open, click, lastView } = rig({ records: store.list(), respond: input => responder.respond(input) });
    await open("U1");
    const buttons = lastView().blocks.find(b => b.type === "actions" && b.elements[0].action_id === HOME_PERM_ONCE).elements;
    expect(buttons.map((b: any) => b.action_id)).toEqual([HOME_PERM_ONCE, HOME_PERM_DENY]);
    await click(HOME_PERM_ONCE, "U1", buttons[0].value);
    // The same OpenCode reply and resolution (card collapse) as the card's ✓ Approve once.
    expect(reply).toHaveBeenCalledWith(server, record().permission, "once");
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ requestId: "per_1" }), expect.stringContaining("Approved (once)"));
    expect(JSON.stringify(lastView().blocks)).not.toContain("⚠️");

    store.put(record()); // a fresh pending ask, but its thread was rebound meanwhile
    generation = 3;
    await click(HOME_PERM_DENY, "U1", buttons[1].value);
    expect(reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(lastView().blocks)).toContain("⚠️ That permission's session or binding is no longer current.");
  });

  it("says when it was updated, not that it's a snapshot", () => {
    const t = text(homeView({ runs: [], waiting: [], reports: [], usage: null }));
    expect(t).toMatch(/Updated <!date\^\d+\^/);
    expect(t).not.toContain("Snapshot");
  });

  it("stays under Slack's 100-block limit with every section full", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const v = homeView({
      runs: many(40).map(i => ({ project: `p${i}`, url: null, elapsedMs: 1000, queued: 0, threadKey: `C:${i}` })),
      waiting: many(40).map(i => ({ kind: "permission" as const, title: "t", project: "p", url: null, perm: { k: `C:${i}`, s: "s", p: "p", g: 0 } })),
      prompts: many(40).map(i => `p${i}`),
      reports: many(40).map(i => ({ name: `r${i}`, enabled: true, nextRunAt: 0 })), usage: "x", notice: "n",
    });
    expect(v.blocks.length).toBeLessThan(100);
    expect(text(v)).toContain("…and 30 more");
    const quick = v.blocks.find((b: any) => b.type === "actions" && b.elements[0].action_id === "quick_run_0") as any;
    expect(quick.elements).toHaveLength(25);
  });
});
