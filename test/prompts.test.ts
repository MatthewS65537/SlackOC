import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromptStore } from "../src/prompts.js";
import { getCommand, type CmdCtx } from "../src/commands/registry.js";
import "../src/commands/handlers.js";
import { handleIncomingMessage, type BridgeDeps } from "../src/slack/router.js";
import { registerHome } from "../src/slack/home.js";
import { StateStore } from "../src/state.js";
import { deleteView } from "../src/slack/render.js";
import { timestampFromMs } from "../src/slack/recovery-policy.js";

const FIXTURES = join(import.meta.dirname, ".fixtures", "prompts");
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));
const fresh = (name: string) => { rmSync(join(FIXTURES, name), { recursive: true, force: true }); return join(FIXTURES, name); };

describe("saved prompt store (D1)", () => {
  it("round-trips case-insensitively through an atomic 0600 prompts.json", () => {
    const dir = fresh("store");
    const path = join(dir, "prompts.json");
    const store = new PromptStore(path);
    expect(store.set("Review", "Review the diff.")).toBe("created");
    expect(store.set("__proto__", "odd but valid")).toBe("created");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["prompts.json"]); // no temp file left behind
    const created = store.get("review")!.createdAt;
    expect(store.set("REVIEW", "Review it again.")).toBe("updated");
    const reopened = new PromptStore(path);
    expect(reopened.get("review")).toEqual({ text: "Review it again.", createdAt: created });
    expect(reopened.get("__proto__")?.text).toBe("odd but valid");
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    expect(reopened.delete("Review")).toBe(true);
    expect(new PromptStore(path).list().map(p => p.name)).toEqual(["__proto__"]);
  });

  it("leaves memory unchanged when the write fails", () => {
    const dir = fresh("store-fail");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "not-a-dir"), "");
    const store = new PromptStore(join(dir, "not-a-dir", "prompts.json"));
    expect(() => store.set("x", "y")).toThrow();
    expect(store.get("x")).toBeUndefined();
  });
});

describe("\\save, \\saved, \\unsave", () => {
  function ctx(store: PromptStore) {
    const out: Array<{ text: string; blocks?: any[] }> = [];
    const c = { prompts: store, postToThread: async (text: string, blocks?: any[]) => { out.push({ text, blocks }); } } as unknown as CmdCtx;
    return { c, out, last: () => out.at(-1)! };
  }

  it("validates names and prompts, and says when a save updates", async () => {
    const store = new PromptStore(join(fresh("save"), "prompts.json"));
    const { c, last } = ctx(store);
    const save = getCommand("save")!;
    for (const bad of ["no/slash do it", "has.dot do it", `${"x".repeat(33)} do it`]) {
      await save.run(c, bad);
      expect(last().text).toContain("Prompt names use");
    }
    await save.run(c, "");
    expect(last().text).toContain("Usage");
    await save.run(c, "review");
    expect(last().text).toContain("Add the prompt after the name");
    await save.run(c, "review \\stop");
    expect(last().text).toContain("can't start with");
    expect(store.list()).toEqual([]);
    await save.run(c, "Review Review the diff.\nThen list risks.");
    expect(last().text).toBe("💾 Saved `review`. Run it with `\\run review`.");
    expect(store.get("review")?.text).toBe("Review the diff.\nThen list risks.");
    await save.run(c, "review Shorter.");
    expect(last().text).toContain("Updated `review`");
  });

  it("\\saved explains how to start when empty, else lists rows with ▶ buttons", async () => {
    const store = new PromptStore(join(fresh("saved"), "prompts.json"));
    const { c, last } = ctx(store);
    await getCommand("prompts")!.run(c, ""); // alias
    expect(last().text).toContain("No saved prompts yet");
    expect(last().blocks).toBeUndefined();
    store.set("review", "Review the diff.");
    store.set("ci", "Fix CI.");
    await getCommand("saved")!.run(c, "");
    expect(last().text).toContain("• `ci` — Fix CI.\n• `review` — Review the diff.");
    expect(last().blocks![1].elements.map((b: any) => [b.action_id, b.value])).toEqual([["quick_run_0", "ci"], ["quick_run_1", "review"]]);
    await getCommand("unsave")!.run(c, "CI");
    expect(last().text).toBe("🗑 Deleted `ci`.");
    await getCommand("unsave")!.run(c, "ci");
    expect(last().text).toContain("No saved prompt named `ci`");
  });
});

/** The real router, with Slack and the OpenCode SDK faked at the seams (as in shortcut.test.ts). */
function bridgeRig(name: string) {
  const dir = fresh(name);
  const state = new StateStore(join(dir, "state.json"));
  state.setCurrentProject("/proj");
  const prompts = new PromptStore(join(dir, "prompts.json"));
  prompts.set("review", "Review the diff.");
  const submitted: Array<{ session: string; text: string }> = [];
  const posts: Array<{ channel: string; root: string; text: string; ts: string }> = [];
  const create = vi.fn(async () => ({ data: { id: `ses_${name}` } }));
  const client = { session: { create, messages: async () => ({ data: [] }), get: async () => { throw new Error("no summary"); },
    promptAsync: async (args: any) => { submitted.push({ session: args.path.id, text: args.body.parts[0].text }); return { data: {} }; } } };
  let n = 0;
  const render = { react: async () => {}, unreact: async () => {}, update: async () => {}, delete: async () => {}, upload: async () => {},
    post: async (channel: string, root: string, text: string) => {
      const ts = timestampFromMs(Date.now() - 30_000 + ++n);
      posts.push({ channel, root, text, ts });
      return { ts };
    } };
  const bridge = { state, prompts, config: { ownerSlackUserId: "U1" }, cwd: "/proj", botUserId: "BOT", render, ownerDmChannel: () => "D1",
    pool: { acquire: async () => ({ release() {}, entry: { client } }) } } as unknown as BridgeDeps;
  return { state, bridge, submitted, posts, create, session: `ses_${name}` };
}

describe("\\run", () => {
  afterEach(() => { for (const s of ["ses_run-extra", "ses_quick"]) deleteView(s); });

  it("sends the saved text plus the extra text through the normal prompt path, binding a new DM thread", async () => {
    const { state, bridge, submitted, session } = bridgeRig("run-extra");
    const ts = timestampFromMs(Date.now() - 1_000);
    expect(await handleIncomingMessage({ channel: "D1", channel_type: "im", ts, user: "U1", text: "\\run Review focus on the tests" }, bridge)).toBe("accepted");
    expect(submitted).toEqual([{ session, text: "Review the diff.\n\nfocus on the tests" }]);
    expect(state.getThread(`D1:${ts}`)?.sessionId).toBe(session);
  });

  it("explains an unknown name and sends nothing", async () => {
    const { bridge, submitted, posts, create } = bridgeRig("run-unknown");
    await handleIncomingMessage({ channel: "D1", channel_type: "im", ts: timestampFromMs(Date.now() - 1_000), user: "U1", text: "\\run nope" }, bridge);
    expect(posts.at(-1)?.text).toContain("No saved prompt named `nope`. `\\saved` lists them");
    expect(submitted).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("▶ quick run buttons", () => {
  afterEach(() => deleteView("ses_quick"));

  function homeRig() {
    const rig = bridgeRig("quick");
    const actions: Array<[string | RegExp, any]> = [];
    const app = { event: () => {}, action: (id: string | RegExp, h: any) => actions.push([id, h]), client: { views: { publish: async () => ({}) } } };
    registerHome(app as never, { ownerSlackUserId: "U1", state: rig.state, pool: { get: () => undefined } as never,
      permissions: { list: () => [] }, questions: { list: () => [] }, reports: () => [], threadUrl: () => null, isStopping: () => false, bridge: rig.bridge });
    const click = (body: Record<string, unknown>) => actions.find(([k]) => k instanceof RegExp && k.test("quick_run_0"))![1]({
      ack: async () => {}, respond: vi.fn(), body: { user: { id: "U1" }, ...body }, action: { action_id: "quick_run_0", value: "review" } });
    return { ...rig, click };
  }

  it("from Home: posts a carrier root in the owner DM, binds a session to it, and runs", async () => {
    const { click, posts, submitted, state, session } = homeRig();
    await click({ view: { type: "home" } });
    expect(posts[0]).toMatchObject({ channel: "D1", root: "", text: "▶ *review*" });
    expect(submitted).toEqual([{ session, text: "Review the diff." }]);
    expect(state.getThread(`D1:${posts[0]!.ts}`)?.sessionId).toBe(session); // the carrier is the thread root
  });

  it("under \\saved in a thread: runs in that thread", async () => {
    const { click, posts, submitted, state, session } = homeRig();
    const root = timestampFromMs(Date.now() - 60_000);
    await click({ channel: { id: "C9" }, message: { ts: timestampFromMs(Date.now() - 50_000), thread_ts: root } });
    expect(posts[0]).toMatchObject({ channel: "C9", root, text: "▶ *review*" });
    expect(submitted).toEqual([{ session, text: "Review the diff." }]);
    expect(state.getThread(`C9:${root}`)?.sessionId).toBe(session);
  });
});
