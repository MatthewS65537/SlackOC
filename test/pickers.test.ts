import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelSearch, registerPickerActions } from "../src/slack/pickers.js";
import { runPickedCommand } from "../src/slack/router.js";
import { configProviders } from "../src/opencode/client.js";
import { _resetQueueForTests } from "../src/slack/queue.js";

vi.mock("../src/slack/router.js", () => ({ runPickedCommand: vi.fn(async () => {}) }));
vi.mock("../src/opencode/client.js", () => ({
  configProviders: vi.fn(async (c: { dir: string }) => ({ default: {}, providers: [{ id: c.dir.slice(1), name: c.dir,
    models: { [`only-in-${c.dir.slice(1)}`]: { id: `only-in-${c.dir.slice(1)}`, name: `Model for ${c.dir}` } } }] })),
}));
vi.mock("../src/opencode/favorites.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/opencode/favorites.js")>(), readFavorites: () => [] }));

const OWNER = "U_OWNER";
const ROOT = "1791400000.000100";
const CARD = "1791400050.000200";
const user = (id = OWNER) => ({ id, username: "owner", name: "owner", team_id: "T1" });
/** Shape of a real block_actions payload from a threaded bot reply: the container has no thread_ts. */
const pickAction = (channel: string, message: Record<string, unknown>, value: string, actor = OWNER) => ({
  type: "block_actions", user: user(actor), api_app_id: "A1", token: "tok", trigger_id: "1.2.abc",
  team: { id: "T1", domain: "team" }, enterprise: null, is_enterprise_install: false,
  container: { type: "message", message_ts: message.ts, channel_id: channel, is_ephemeral: false },
  channel: { id: channel, name: "dev" }, state: { values: {} }, response_url: "https://hooks.slack.com/actions/T1/1/x",
  message: { type: "message", user: "U_BOT", bot_id: "B1", text: "Choose", blocks: [], ...message },
  actions: [{ type: "static_select", action_id: "pick_agent", block_id: "b1", action_ts: "1791400060.000001",
    selected_option: { text: { type: "plain_text", text: value }, value } }],
});
/** block_suggestion: `message` is included when Slack sends it, otherwise only the container identifies the card. */
const suggestion = (channel: string, value: string, message?: Record<string, unknown>, actor = OWNER) => ({
  type: "block_suggestion", user: user(actor), api_app_id: "A1", token: "tok", action_id: "pick_model", block_id: "b1", value,
  team: { id: "T1", domain: "team" }, enterprise: null, is_enterprise_install: false,
  container: { type: "message", message_ts: CARD, channel_id: channel, is_ephemeral: false },
  channel: { id: channel, name: "dev" }, ...(message ? { message: { type: "message", user: "U_BOT", text: "Model", ...message } } : {}),
});

function harness(bindings: Record<string, string> = {}) {
  _resetQueueForTests();
  const handlers: Record<string, any> = {};
  const updates: any[] = [];
  const replies = vi.fn(async (_args: any): Promise<any> => ({ messages: [] }));
  const app: any = {
    action: (_id: unknown, cb: any) => { handlers.action = cb; },
    options: (_id: unknown, cb: any) => { handlers.options = cb; },
    client: { chat: { update: async (args: any) => { updates.push(args); return {}; } }, conversations: { replies } },
  };
  const state: any = { currentProjectDir: "/global-a", defaultDir(): string { return this.currentProjectDir; }, threadKey: (c: string, t: string) => `${c}:${t}`,
    getThread: (key: string) => bindings[key] ? { sessionId: "ses_1", projectDir: bindings[key] } : null };
  const ensure = vi.fn(async (dir: string) => ({ client: { dir } }));
  const bridge: any = { state, pool: { ensure }, cwd: "/cwd" };
  registerPickerActions(app, { bridge, ownerSlackUserId: OWNER, isStopping: () => false });
  registerModelSearch(app, { bridge, ownerSlackUserId: OWNER });
  const select = async (payload: ReturnType<typeof pickAction>) => {
    const respond = vi.fn(async () => {});
    await handlers.action({ ack: async () => {}, body: payload, action: payload.actions[0], respond });
    return respond;
  };
  const search = async (payload: ReturnType<typeof suggestion>) => {
    const ack = vi.fn(async (_r: any) => {});
    await handlers.options({ ack, body: payload });
    return ack.mock.calls[0]![0];
  };
  return { app, bridge, updates, replies, ensure, select, search };
}
const optionValues = (response: any): string[] =>
  (response.option_groups ?? [{ options: response.options }]).flatMap((g: any) => g.options.map((o: any) => o.value));

beforeEach(() => { vi.mocked(runPickedCommand).mockClear(); vi.mocked(configProviders).mockClear(); });

describe("picker selections (#15)", () => {
  it.each(["\\model prov/m", "\\agent build", "\\cd /work/b", "\\resume ses_9"])("runs %s against the parent thread root, not the card", async value => {
    const h = harness();
    await h.select(pickAction("C1", { ts: CARD, thread_ts: ROOT }, value));
    expect(h.updates).toEqual([expect.objectContaining({ channel: "C1", ts: CARD, blocks: [] })]);
    expect(runPickedCommand).toHaveBeenCalledWith(h.bridge, "C1", ROOT, CARD, value);
  });

  it("routes a top-level card to its own timestamp", async () => {
    const h = harness();
    await h.select(pickAction("D1", { ts: CARD }, "\\agent plan"));
    expect(runPickedCommand).toHaveBeenCalledWith(h.bridge, "D1", CARD, CARD, "\\agent plan");
  });

  it("does nothing without the source message rather than guessing the card is a root", async () => {
    const h = harness();
    const payload: any = pickAction("C1", { ts: CARD, thread_ts: ROOT }, "\\agent build");
    delete payload.message;
    await h.select(payload);
    expect(h.updates).toEqual([]);
    expect(runPickedCommand).not.toHaveBeenCalled();
  });

  it("rejects non-owners without touching the card or running the command", async () => {
    const h = harness();
    const respond = await h.select(pickAction("C1", { ts: CARD, thread_ts: ROOT }, "\\cd /x", "U_OTHER"));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
    expect(h.updates).toEqual([]);
    expect(runPickedCommand).not.toHaveBeenCalled();
  });
});

describe("model search suggestions (#15)", () => {
  it("loads the card's thread project, not the global current project", async () => {
    const h = harness({ [`C2:${ROOT}`]: "/proj-b" });
    const res = await h.search(suggestion("C2", "", { ts: CARD, thread_ts: ROOT }));
    expect(h.ensure).toHaveBeenCalledWith("/proj-b");
    expect(optionValues(res)).toEqual(["\\model proj-b/only-in-proj-b"]);
    expect(h.replies).not.toHaveBeenCalled();
  });

  it("finds the parent from the card's history when the payload omits the message, and keeps projects isolated", async () => {
    const otherRoot = "1791400000.000300";
    const h = harness({ [`C3:${ROOT}`]: "/proj-c", [`C4:${otherRoot}`]: "/proj-d" });
    h.replies.mockImplementation(async (args: any) => ({ messages: [{ type: "message", user: "U_BOT", ts: args.ts,
      thread_ts: args.channel === "C3" ? ROOT : otherRoot }], has_more: false }));
    const c = await h.search(suggestion("C3", ""));
    const d = await h.search(suggestion("C4", ""));
    await h.search(suggestion("C3", "only")); // cached root and catalog
    expect(optionValues(c)).toEqual(["\\model proj-c/only-in-proj-c"]);
    expect(optionValues(d)).toEqual(["\\model proj-d/only-in-proj-d"]);
    expect(h.replies.mock.calls.map(([a]) => [a.channel, a.ts])).toEqual([["C3", CARD], ["C4", CARD]]);
    expect(configProviders).toHaveBeenCalledTimes(2);
  });

  it("falls back like \\model only for a known-but-unbound thread", async () => {
    const h = harness();
    const res = await h.search(suggestion("C5", "", { ts: CARD, thread_ts: ROOT }));
    expect(h.ensure).toHaveBeenCalledWith("/global-a");
    expect(optionValues(res)).toEqual(["\\model global-a/only-in-global-a"]);
  });

  it.each([
    ["history is unreadable", async () => { throw new Error("not_in_channel"); }],
    ["history has no such card", async () => ({ messages: [] })],
  ])("returns no options when the parent is unknown and %s", async (_label, impl) => {
    const h = harness();
    h.replies.mockImplementation(impl as never);
    expect(await h.search(suggestion("C6", ""))).toEqual({ options: [] });
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("returns no options for non-owners", async () => {
    const h = harness({ [`C7:${ROOT}`]: "/proj-b" });
    expect(await h.search(suggestion("C7", "", { ts: CARD, thread_ts: ROOT }, "U_OTHER"))).toEqual({ options: [] });
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
