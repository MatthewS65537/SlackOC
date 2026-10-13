import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCommand, type CmdCtx } from "../src/commands/registry.js";
import { newThreadState } from "../src/commands/handlers.js";
import { isPreparingWorktree, registerWorktreeControls, sameProject, STILL_PREPARING, WT_REMOVE_CONFIRM_ACTION, worktreeRisks } from "../src/commands/worktrees.js";
import { handleIncomingMessage, type BridgeDeps, type SlackMsg } from "../src/slack/router.js";
import { SessionView, deleteView, type RenderDeps } from "../src/slack/render.js";
import type { ExecFileFn } from "../src/ship.js";
import type { SlackocConfig } from "../src/config.js";
import { canonicalDir } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { _resetQueueForTests } from "../src/slack/queue.js";

const FIXTURES = join(import.meta.dirname, ".fixtures", "worktrees");
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function gitRepo(name: string): string {
  const dir = join(FIXTURES, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

/** OpenCode client fake: worktree API on v2, sessions on the compat layer. */
function fakeClient(extra: { create?: (input: unknown) => Promise<unknown>; list?: unknown[]; session?: Record<string, unknown> } = {}) {
  return {
    projectId: async () => "prj",
    v2: { worktree: { create: vi.fn(extra.create ?? (async () => ({ directory: "/wt/new" }))), list: vi.fn(async () => extra.list ?? []),
      remove: vi.fn(async () => {}) }, session: { move: vi.fn(async () => {}) } },
    session: { create: vi.fn(async () => ({ data: { id: "ses_wt" } })), promptAsync: vi.fn(async () => ({})), ...extra.session },
  };
}

function fakePool(client: unknown) {
  const ensured: string[] = [];
  const pool = {
    ensured,
    ensure: async (dir: string) => { ensured.push(dir); return { dir, client }; },
    acquire: async (dir: string) => ({ entry: await pool.ensure(dir), release: () => {} }),
    killOne: vi.fn(async () => {}),
    list: () => [],
  };
  return pool;
}

describe("\\new --wt holds prompts until the worktree is bound", () => {
  const NOW = Date.parse("2026-09-22T00:00:00Z");
  const ts = (s: number) => `${1790000000 + s}.000001`;
  const msg = (s: number, text: string): SlackMsg => ({ channel: "C1", ts: ts(s), thread_ts: ts(900), user: "U1", text });

  it("posts the preparing line, refuses a prompt meanwhile, then binds a fresh session in the worktree", async () => {
    let finish!: (v: { directory: string }) => void;
    const client = fakeClient({ create: () => new Promise((resolve) => { finish = resolve; }) });
    const pool = fakePool(client);
    const posted: string[] = [];
    let n = 0;
    const render = { post: async (_c: string, _t: string, text: string) => { posted.push(text); return { ts: `r${++n}` }; },
      update: async () => {}, delete: async () => {}, react: async () => {}, unreact: async () => {} } as unknown as RenderDeps;
    const state = new StateStore(join(FIXTURES, "router", "state.json"), () => NOW);
    const key = `C1:${ts(900)}`;
    state.setThread(key, newThreadState("ses_old", "/repo"));
    const d = { config: { ownerSlackUserId: "U1" } as SlackocConfig, state, pool, render, botUserId: "UBOT", cwd: "/repo" } as unknown as BridgeDeps;

    const command = handleIncomingMessage(msg(901, "\\new --wt feat/x"), d);
    await vi.waitFor(() => expect(client.v2.worktree.create).toHaveBeenCalled());
    expect(client.v2.worktree.create).toHaveBeenCalledWith({ projectID: "prj", branch: "feat/x" }, expect.anything());
    expect(posted).toContain("⏳ preparing worktree…");
    expect(isPreparingWorktree(key)).toBe(true);

    expect(await handleIncomingMessage(msg(902, "fix the bug"), d)).toBe("accepted");
    expect(posted.at(-1)).toBe(STILL_PREPARING);
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(state.getThread(key)?.sessionId).toBe("ses_old");

    finish({ directory: "/wt/feat-x" });
    expect(await command).toBe("accepted");
    expect(isPreparingWorktree(key)).toBe(false);
    expect(pool.ensured).toContain("/wt/feat-x");
    expect(state.getThread(key)).toMatchObject({ sessionId: "ses_wt", projectDir: "/wt/feat-x" });
    expect(posted.at(-1)).toContain("New worktree session");
  });

  function newWtRig(name: string) {
    let finish!: (v: { directory: string }) => void;
    let n = 0;
    const client = fakeClient({ create: () => new Promise((resolve) => { finish = resolve; }),
      session: { create: vi.fn(async () => ({ data: { id: `ses_${++n}` } })) } });
    const posted: string[] = [];
    const render = { post: async (_c: string, _t: string, text: string) => { posted.push(text); return { ts: `r${posted.length}` }; },
      update: async () => {}, delete: async () => {}, react: async () => {}, unreact: async () => {} } as unknown as RenderDeps;
    const state = new StateStore(join(FIXTURES, name, "state.json"), () => NOW);
    const key = `C1:${ts(900)}`;
    state.setThread(key, newThreadState("ses_old", "/repo"));
    const d = { config: { ownerSlackUserId: "U1" } as SlackocConfig, state, pool: fakePool(client), render, botUserId: "UBOT", cwd: "/repo" } as unknown as BridgeDeps;
    return { client, posted, state, key, d, finish: (dir: string) => finish({ directory: dir }) };
  }

  it("a \\new issued while the worktree is prepared wins: the worktree is kept, not bound over it", async () => {
    const r = newWtRig("rebound");
    const command = handleIncomingMessage(msg(901, "\\new --wt"), r.d);
    await vi.waitFor(() => expect(r.client.v2.worktree.create).toHaveBeenCalled());
    expect(await handleIncomingMessage(msg(902, "\\new"), r.d)).toBe("accepted");
    expect(r.state.getThread(r.key)?.sessionId).toBe("ses_1");
    r.finish("/wt/feat-x");
    expect(await command).toBe("accepted");
    expect(r.state.getThread(r.key)).toMatchObject({ sessionId: "ses_1", projectDir: "/repo" });
    expect(r.client.session.create).toHaveBeenCalledTimes(1);
    expect(r.posted.at(-1)).toBe("⏭ The thread was rebound while the worktree was prepared; the worktree `feat-x` is kept. `\\wt` removes it.");
    expect(isPreparingWorktree(r.key)).toBe(false);
  });

  it("a second \\new --wt while one is preparing is refused; the first still binds", async () => {
    const r = newWtRig("twice");
    const first = handleIncomingMessage(msg(901, "\\new --wt"), r.d);
    await vi.waitFor(() => expect(r.client.v2.worktree.create).toHaveBeenCalled());
    expect(await handleIncomingMessage(msg(902, "\\new --wt"), r.d)).toBe("accepted");
    expect(r.posted.at(-1)).toBe(STILL_PREPARING);
    expect(r.client.v2.worktree.create).toHaveBeenCalledTimes(1);
    expect(isPreparingWorktree(r.key)).toBe(true); // the refusal didn't release the first's hold
    r.finish("/wt/one");
    expect(await first).toBe("accepted");
    expect(r.state.getThread(r.key)).toMatchObject({ sessionId: "ses_1", projectDir: "/wt/one" });
    expect(isPreparingWorktree(r.key)).toBe(false);
  });
});

describe("\\fork --wt", () => {
  function forkRig(name: string, create?: (input: unknown) => Promise<unknown>) {
    const state = new StateStore(join(FIXTURES, name, "state.json"));
    state.setThread("C1:T1", { ...newThreadState("ses_orig", "/p", "off"), model: "a/b" });
    let preparingDuringCreate = false;
    const client = fakeClient({
      create: async (input) => { preparingDuringCreate = isPreparingWorktree("C1:R9"); return create ? create(input) : { directory: "/wt/fork" }; },
      session: { messages: async () => ({ data: [] }), fork: async () => ({ data: { id: "ses_forked", directory: "/p", title: "", time: { created: 1, updated: 1 } } }) },
    });
    const posts: Array<{ threadTs: string; text: string }> = [];
    const out: string[] = [];
    const ctx = {
      channelId: "C1", threadTs: "T1", threadKey: "C1:T1", thread: state.getThread("C1:T1"), state, config: null as never, cwd: "/p",
      pool: fakePool(client), threadUrl: (k: string) => `https://x/${k}`,
      render: { post: async (_c: string, threadTs: string, text: string) => { posts.push({ threadTs, text }); return { ts: "R9" }; } },
      postToThread: async (t: string) => void out.push(t), uploadToThread: async () => {},
    } as unknown as CmdCtx;
    return { state, client, posts, out, ctx, preparing: () => preparingDuringCreate };
  }

  it("creates the worktree, moves the forked session into it, and binds the new thread there", async () => {
    const r = forkRig("fork-wt");
    await getCommand("fork")!.run(r.ctx, "--wt");
    expect(r.preparing()).toBe(true);
    expect(r.posts[0]).toMatchObject({ threadTs: "", text: expect.stringContaining("with its own worktree") });
    expect(r.posts.slice(1)).toEqual([
      { threadTs: "R9", text: "⏳ preparing worktree…" },
      { threadTs: "R9", text: "🌳 Worktree ready: `/wt/fork`. Reply here to drive it." },
    ]);
    expect(r.client.v2.session.move).toHaveBeenCalledWith({ sessionID: "ses_forked", directory: "/wt/fork" }, expect.anything());
    expect(r.state.getThread("C1:R9")).toMatchObject({ sessionId: "ses_forked", projectDir: "/wt/fork", model: "a/b", verbose: "off" });
    expect(r.out.at(-1)).toContain("in its own worktree");
    expect(isPreparingWorktree("C1:R9")).toBe(false);
  });

  it("a failed worktree falls back to a plain fork with a warning", async () => {
    const r = forkRig("fork-wt-fail", async () => { throw { name: "WorktreeError", data: { message: "not a git repository" } }; });
    await getCommand("fork")!.run(r.ctx, "--wt");
    expect(r.posts.at(-1)).toEqual({ threadTs: "R9", text: "⚠️ Couldn't prepare a worktree (not a git repository). This thread shares `/p` instead." });
    expect(r.client.v2.session.move).not.toHaveBeenCalled();
    expect(r.state.getThread("C1:R9")).toMatchObject({ sessionId: "ses_forked", projectDir: "/p" });
    expect(r.out.at(-1)).not.toContain("own worktree");
  });

  it("a fork thread rebound while its worktree is prepared keeps that binding", async () => {
    const r = forkRig("fork-wt-rebound", async () => {
      r.state.setThread("C1:R9", newThreadState("ses_other", "/p"));
      return { directory: "/wt/fork" };
    });
    await getCommand("fork")!.run(r.ctx, "--wt");
    expect(r.state.getThread("C1:R9")?.sessionId).toBe("ses_other");
    expect(r.client.v2.session.move).not.toHaveBeenCalled();
    expect(r.posts.at(-1)?.text).toContain("rebound while the worktree was prepared; the worktree `fork` is kept");
    expect(r.out).toEqual([]);
  });
});

describe("\\worktrees", () => {
  it("lists worktrees with their threads; \\wt remove asks before dropping dirty work and the owner-only button removes it", async () => {
    _resetQueueForTests();
    const dirty = gitRepo("wt-dirty");
    writeFileSync(join(dirty, "notes.txt"), "uncommitted");
    const state = new StateStore(join(FIXTURES, "list", "state.json"));
    state.setThread("C1:T1", newThreadState("ses_main", "/p"));
    state.setThread("C1:X", newThreadState("ses_x", dirty));
    const client = fakeClient({ list: [{ directory: dirty }, { directory: "/wt/gone" }] });
    const pool = fakePool(client);
    const notes: Array<[string, string, string]> = [];
    const render = { post: async (c: string, t: string, text: string) => { notes.push([c, t, text]); return { ts: "n1" }; } };
    const out: Array<{ text: string; blocks?: any[] }> = [];
    const ctx = {
      channelId: "C1", threadTs: "T1", threadKey: "C1:T1", thread: state.getThread("C1:T1"), state, config: null as never, cwd: "/p",
      pool, render, threadUrl: (k: string) => `https://x/${k}`,
      postToThread: async (text: string, blocks?: any[]) => void out.push({ text, blocks }), uploadToThread: async () => {},
    } as unknown as CmdCtx;
    const wt = getCommand("wt")!;

    await wt.run(ctx, "remove 1");
    expect(out.at(-1)?.text).toContain("No fresh worktree list");

    await wt.run(ctx, "");
    expect(out.at(-1)?.text).toContain(`1) \`wt-dirty\` — ${canonicalDir(dirty)} · <https://x/C1:X|thread>`);
    expect(out.at(-1)?.text).toContain("2) `gone` — /wt/gone · no thread");

    await wt.run(ctx, "remove 1");
    expect(out.at(-1)?.text).toBe("⚠️ Worktree `wt-dirty` has uncommitted changes and no upstream branch. Removing it may lose that work.");
    const button = out.at(-1)!.blocks![1].elements[0];
    expect(button.action_id).toBe(WT_REMOVE_CONFIRM_ACTION);
    expect(client.v2.worktree.remove).not.toHaveBeenCalled();

    // A folder that's already gone has nothing to lose: removed without asking.
    await wt.run(ctx, "remove 2");
    expect(client.v2.worktree.remove).toHaveBeenCalledWith({ projectID: "prj", directory: "/wt/gone", force: false }, expect.anything());
    expect(out.at(-1)?.text).toBe("🗑 Removed worktree `gone`.");

    const handlers: Array<{ id: string; cb: any }> = [];
    const updates: any[] = [];
    const app = { action: (id: string, cb: any) => handlers.push({ id, cb }),
      client: { chat: { update: async (args: any) => { updates.push(args); return {}; } } } };
    registerWorktreeControls(app as never, { ownerSlackUserId: "U_OWNER", state, pool: pool as never, render: render as never, isStopping: () => false });
    const click = async (user: string, value: string = button.value) => {
      const respond = vi.fn(async () => {});
      const body = { user: { id: user }, container: { channel_id: "C1", message_ts: "CARD" }, message: { ts: "CARD", thread_ts: "T1" } };
      await handlers.find((h) => h.id === WT_REMOVE_CONFIRM_ACTION)!.cb({ ack: async () => {}, body, action: { value }, respond });
      return respond;
    };

    const stranger = await click("U_OTHER");
    expect(stranger).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral", text: expect.stringContaining("Only the paired owner") }));
    expect(client.v2.worktree.remove).toHaveBeenCalledTimes(1);

    // A forced remove re-checks the folder is still one of OpenCode's worktrees, and refuses stale cards.
    const t = JSON.parse(button.value);
    const notListed = await click("U_OWNER", JSON.stringify({ ...t, d: "/not/a/worktree" }));
    expect(notListed).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("isn't one of this project's worktrees") }));
    const stale = await click("U_OWNER", JSON.stringify({ ...t, at: Date.now() - 31 * 60_000 }));
    expect(stale).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("expired") }));
    expect(client.v2.worktree.remove).toHaveBeenCalledTimes(1);

    await click("U_OWNER");
    expect(client.v2.worktree.remove).toHaveBeenLastCalledWith({ projectID: "prj", directory: canonicalDir(dirty), force: true }, expect.anything());
    expect(state.getThread("C1:X")).toBeNull();
    expect(notes).toEqual([["C1", "X", expect.stringContaining("worktree `wt-dirty` was removed, so the thread is unbound")]]);
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_main");
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ ts: "CARD", blocks: [], text: "🗑 Removed worktree `wt-dirty`." }));
  });

  it("a Slack run blocks \\wt remove but a \\watch mirror doesn't; unbound threads get a closed native status", async () => {
    const state = new StateStore(join(FIXTURES, "busy", "state.json"));
    state.setThread("C1:T1", newThreadState("ses_main", "/p"));
    state.setThread("C1:W", newThreadState("ses_w", "/wt/gone"));
    const client = fakeClient({ list: [{ directory: "/wt/gone" }] });
    const statuses: string[] = [];
    const render = { post: async () => ({ ts: "n1" }), update: async () => {}, delete: async () => {}, react: async () => {},
      sessionStatus: async (c: string, t: string, status: string) => void statuses.push(`${c}:${t} ${status}`) } as unknown as RenderDeps;
    const out: string[] = [];
    const ctx = {
      channelId: "C1", threadTs: "T1", threadKey: "C1:T1", thread: state.getThread("C1:T1"), state, config: null as never, cwd: "/p",
      pool: fakePool(client), render, postToThread: async (text: string) => void out.push(text), uploadToThread: async () => {},
    } as unknown as CmdCtx;
    const view = new SessionView({ sessionId: "ses_w", projectDir: "/wt/gone", channel: "C1", threadTs: "W", threadKey: "C1:W",
      client: {} as never, deps: { ...render, sessionStatus: undefined }, state, threadState: state.getThread("C1:W")! });
    try {
      await view.beginPrompt("1.1");
      const wt = getCommand("wt")!;
      await wt.run(ctx, "");
      await wt.run(ctx, "remove 1");
      expect(out.at(-1)).toContain("A run is active");
      expect(client.v2.worktree.remove).not.toHaveBeenCalled();

      state.setThread("C1:W", { ...state.getThread("C1:W")!, watchOnly: true });
      await wt.run(ctx, "remove 1");
      expect(out.at(-1)).toBe("🗑 Removed worktree `gone`.");
      expect(state.getThread("C1:W")).toBeNull();
      expect(statuses).toEqual(["C1:W closed"]);
    } finally { deleteView("ses_w"); }
  });

  it("counts unpushed commits; a clean, pushed worktree has nothing to lose", async () => {
    const exec = (outputs: Record<string, string | Error>): ExecFileFn => async (_f, args) => {
      const v = outputs[args.join(" ")];
      if (v instanceof Error) throw v;
      return { stdout: v ?? "", stderr: "" };
    };
    const dir = import.meta.dirname;
    expect(await worktreeRisks(dir, exec({ "status --porcelain": "", "log --oneline @{u}..": "a1 one\nb2 two\n" }))).toEqual(["2 unpushed commits"]);
    expect(await worktreeRisks(dir, exec({ "status --porcelain": "", "log --oneline @{u}..": "" }))).toEqual([]);
  });
});

describe("channel pins accept worktrees of the pinned project", () => {
  it("\\cd into a worktree of the pinned repo is allowed; another repo is still refused", async () => {
    const main = gitRepo("pin-main");
    const wt = join(FIXTURES, "pin-wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "wt1", wt], { cwd: main, env: GIT_ENV });
    const other = gitRepo("pin-other");
    expect(await sameProject(main, wt)).toBe(true);
    expect(await sameProject(main, other)).toBe(false);

    const state = new StateStore(join(FIXTURES, "pin", "state.json"));
    state.setChannelProject("C1", main);
    state.setThread("C1:T1", newThreadState("ses_main", main));
    const ctx = {
      channelId: "C1", threadTs: "T1", threadKey: "C1:T1", thread: state.getThread("C1:T1"), state, config: null as never, cwd: main,
      pool: fakePool(fakeClient()), postToThread: async () => {}, uploadToThread: async () => {},
    } as unknown as CmdCtx;
    await expect(getCommand("cd")!.run(ctx, other)).rejects.toThrow("pinned");
    await getCommand("cd")!.run(ctx, wt);
    expect(state.getThread("C1:T1")).toMatchObject({ sessionId: "ses_wt", projectDir: canonicalDir(wt) });
  });
});
