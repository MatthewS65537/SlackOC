import { afterAll, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCommand, allCommands, execute, registerCommand, resolveCommandName, type CmdCtx } from "../src/commands/registry.js";
import { newThreadState, HELP_SECTIONS, stopThreadFromButton } from "../src/commands/handlers.js";
import { StateStore } from "../src/state.js";
import { canonicalDir } from "../src/paths.js";
import { pickerList } from "../src/commands/picker.js";

const IDENTITY_FIXTURES = join(import.meta.dirname, ".fixtures", "commands-identity");
afterAll(() => rmSync(IDENTITY_FIXTURES, { recursive: true, force: true }));

/** Minimal CmdCtx with recording output; command fakes add what they need. */
function baseCtx(state: StateStore, out: string[], thread: CmdCtx["thread"] = null, extra: Partial<CmdCtx> = {}) {
  return {
    channelId: "C1",
    threadTs: "T1",
    threadKey: "C1:T1",
    thread,
    state,
    config: null as never,
    cwd: "/",
    postToThread: async (t: string) => {
      out.push(t);
    },
    uploadToThread: async () => {},
    ...extra,
  } as unknown as CmdCtx;
}

function hushCtx(state: StateStore) {
  const out: string[] = [];
  return {
    ctx: {
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: state.getThread("C1:T1"),
      state,
      config: null as never,
      pool: null as never,
      cwd: "/",
      postToThread: async (text: string) => {
        out.push(text);
      },
      uploadToThread: async () => {},
    } as CmdCtx & { postToThread: (text: string) => Promise<void> },
    out,
  };
}

describe("canonical project choices", () => {
  it("deduplicates real aliases, keeps same basenames distinct, and selects the displayed number after pool reorder", async () => {
    const a = join(IDENTITY_FIXTURES, "a", "project");
    const b = join(IDENTITY_FIXTURES, "b", "project");
    const c = join(IDENTITY_FIXTURES, "c", "project");
    for (const dir of [a, b, c]) mkdirSync(dir, { recursive: true });
    const alias = join(IDENTITY_FIXTURES, "alias");
    symlinkSync(a, alias);
    const state = new StateStore(join(IDENTITY_FIXTURES, "state.json"));
    state.setCurrentProject(alias + "/./");
    state.touchProject(a + "/");
    state.touchProject(b);
    state.touchProject(c);
    let listed = [alias, b, c];
    const acquired: string[] = [];
    const release = vi.fn();
    const client = { session: { create: async () => ({ data: { id: "identity-new" } }) } };
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { cwd: a, threadKey: "identity:1", pool: {
      list: () => listed.map((dir) => ({ dir, status: "ready" })),
      acquire: async (dir: string) => { acquired.push(dir); return { entry: { client }, release }; },
    } as never });
    await getCommand("project")!.run(ctx, "");
    expect(out.at(-1)).toContain(`*Current:* \`${canonicalDir(a)}\``);
    expect(out.at(-1)).toContain(`1) \`project\` — ${canonicalDir(b)}`);
    expect(out.at(-1)).toContain(`2) \`project\` — ${canonicalDir(c)}`);
    expect(out.at(-1)).not.toContain("3)");
    listed = [c, a, b];
    state.setCurrentProject(b); // another thread changed the global default too
    await getCommand("project")!.run(ctx, "2");
    expect(acquired).toEqual([canonicalDir(c)]);
    expect(release).toHaveBeenCalledOnce();
    expect(state.getThread(ctx.threadKey)?.projectDir).toBe(canonicalDir(c));

    const sessionCtx = { ...ctx, thread: null, cwd: alias, pool: { ensure: async () => ({ client: {
      session: { list: async () => ({ data: [
        { id: "in", directory: alias, title: "in", time: { updated: Date.now() } },
        { id: "out", directory: b, title: "out", time: { updated: Date.now() } },
      ] }) },
    } }) } as never };
    state.setCurrentProject(a);
    const scoped = await pickerList(sessionCtx, { scope: "project" });
    expect(scoped.refs.map((r) => r.sessionId)).toEqual(["in"]);
    expect(scoped.refs[0]?.projectDir).toBe(canonicalDir(a));
  });

  it("an exact project name wins over substring matches; a partial name stays ambiguous (#47)", async () => {
    const state = new StateStore(join(IDENTITY_FIXTURES, "exact-state.json"));
    state.setCurrentProject("/launch");
    const [app, appWeb] = ["app", "app-web"].map((name) => join(IDENTITY_FIXTURES, "code", name));
    for (const dir of [app!, appWeb!]) mkdirSync(dir, { recursive: true }); // \project stats its pick (#48)
    const client = { session: { create: async () => ({ data: { id: "exact-new" } }) } };
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { threadKey: "exact:1", pool: {
      list: () => [{ dir: app, status: "ready" }, { dir: appWeb, status: "ready" }],
      acquire: async () => ({ entry: { client }, release: () => {} }),
    } as never });
    await getCommand("project")!.run(ctx, "ap");
    expect(out.at(-1)).toContain("Ambiguous");
    await getCommand("project")!.run(ctx, "app");
    expect(state.getThread("exact:1")?.projectDir).toBe(canonicalDir(app!));
  });

  it("\\cd resolves relative paths against the thread's project, not the launch dir (#48)", async () => {
    const root = join(IDENTITY_FIXTURES, "relative");
    const [projA, projB, launch] = ["projA", "projB", "elsewhere/launch"].map((name) => join(root, name));
    for (const dir of [projA!, projB!, join(launch!, "only-here")]) mkdirSync(dir, { recursive: true });
    const state = new StateStore(join(root, "state.json"));
    state.setThread("C1:T1", newThreadState("ses_rel", projA!));
    const calls: string[] = [];
    const client = { session: { create: async () => ({ data: { id: "ses_rel_new" } }),
      abort: async () => void calls.push("abort"), delete: async () => void calls.push("delete") } };
    const pool = { acquire: async () => ({ entry: { client }, release: () => {} }), killOne: async () => {}, list: () => [] } as never;
    const ctx = () => baseCtx(state, [], state.getThread("C1:T1"), { cwd: launch!, pool });
    await expect(getCommand("cd")!.run(ctx(), "only-here")).rejects.toThrow("is not a directory");
    expect(calls).toEqual([]); // refused before the old session was torn down
    await getCommand("cd")!.run(ctx(), "../projB");
    expect(state.getThread("C1:T1")?.projectDir).toBe(canonicalDir(projB!));
  });

  it("\\project refuses a remembered folder that is gone, keeping this thread's session (#48)", async () => {
    const root = join(IDENTITY_FIXTURES, "gone");
    const here = join(root, "here");
    mkdirSync(here, { recursive: true });
    const state = new StateStore(join(root, "state.json"));
    state.setCurrentProject(here);
    state.touchProject(join(root, "vanished"));
    state.setThread("C1:T1", newThreadState("ses_keep", here));
    const create = vi.fn();
    const abort = vi.fn();
    const pool = { acquire: async () => ({ entry: { client: { session: { create, abort, delete: abort } } }, release: () => {} }),
      killOne: async () => {}, list: () => [] } as never;
    await expect(getCommand("project")!.run(baseCtx(state, [], state.getThread("C1:T1"), { pool }), "vanished")).rejects.toThrow("is not a directory");
    expect(create).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_keep");
  });

  it("requires a fresh successfully displayed per-thread list for numeric choices", async () => {
    const state = new StateStore(join(IDENTITY_FIXTURES, "fresh-state.json"));
    state.setCurrentProject("/current");
    const create = vi.fn();
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { pool: {
      list: () => [{ dir: "/other", status: "ready" }],
      ensure: async () => ({ client: { session: { create } } }),
    } as never });
    await getCommand("project")!.run(ctx, "1");
    expect(out.at(-1)).toContain("No fresh project list");
    await getCommand("project")!.run(ctx, "");
    await getCommand("project")!.run({ ...ctx, threadKey: "another:thread" }, "1");
    expect(out.at(-1)).toContain("No fresh project list");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      await getCommand("project")!.run(ctx, "1");
      expect(out.at(-1)).toContain("No fresh project list");
    } finally { clock.mockRestore(); }
    await expect(getCommand("project")!.run({ ...ctx, postToThread: async () => { throw new Error("Slack offline"); } }, ""))
      .rejects.toThrow("Slack offline");
    await getCommand("project")!.run(ctx, "1");
    expect(out.at(-1)).toContain("No fresh project list");
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * CmdCtx wired to a stubbed OpenCode server that returns a fixture providers map.
 * `cfgModel` = the server's configured default model (GET /config); null = none.
 * `favorites` lands in a fixture TUI state file (never the real ~/.local/state).
 */
function modelListCtx(out: string[], threadModel?: string, cfgModel: string | null = "anthropic/claude-sonnet-4-5",
  opts: { favorites?: string[]; blocks?: unknown[][] } = {}) {
  const stateHome = join(import.meta.dirname, ".fixtures", "model-state");
  mkdirSync(join(stateHome, "opencode"), { recursive: true });
  writeFileSync(join(stateHome, "opencode", "model.json"), JSON.stringify({ favorite: (opts.favorites ?? []).map(id => {
    const [providerID, modelID] = id.split("/");
    return { providerID, modelID };
  }) }));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  const state = new StateStore(`${import.meta.dirname}/.fixtures/model/state.json`);
  state.setThread("C1:T1", newThreadState("s1", "/p"));
  const client = {
    config: {
      get: async () => ({ data: cfgModel ? { model: cfgModel } : {} }),
      providers: async () => ({
        data: {
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
                "claude-opus-4-1": { id: "claude-opus-4-1", name: "Claude Opus 4.1", capabilities: { reasoning: true } },
              },
            },
            {
              id: "openai",
              name: "OpenAI",
              models: { "gpt-5": { id: "gpt-5", name: "GPT-5", capabilities: { reasoning: true } } },
            },
          ],
          default: { anthropic: "claude-sonnet-4-5" },
        },
      }),
    },
    // Live-probe target: what a bare prompt would ACTUALLY resolve to. Deliberately
    // distinct from providers[0]'s default (anthropic/claude-sonnet-4-5) so a test
    // can prove the probe — not the old first-provider guess — drove the result.
    session: {
      create: async () => ({ data: { id: "ses_probe" } }),
      promptAsync: async () => ({ data: {} }),
      messages: async () => [
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant", providerID: "openai", modelID: "gpt-5" }, parts: [] },
      ],
      abort: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    },
  };
  return {
    channelId: "C1",
    threadTs: "T1",
    threadKey: "C1:T1",
    thread: state.getThread("C1:T1") && threadModel
      ? { ...newThreadState("s1", "/p"), model: threadModel }
      : state.getThread("C1:T1"),
    state,
    config: null as never,
    pool: { ensure: async () => ({ client }) } as never,
    cwd: "/",
    postToThread: async (text: string, blocks?: unknown[]) => {
      out.push(text);
      if (blocks) opts.blocks?.push(blocks);
    },
    uploadToThread: async () => {},
  } as unknown as CmdCtx;
}

describe("command registry (user-mandated surface)", () => {
  it("new threads default to verbose=on, not hushed", () => {
    const t = newThreadState("s1", "/p");
    expect(t.verbose).toBe("on");
    expect(t.hushed).toBeUndefined();
  });

  it("\\verbose is channel-wide: existing threads, new threads, other channels untouched", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/verbose-channel/state.json`);
    state.setThread("C1:T1", newThreadState("s1", "/p"));
    state.setThread("C1:T2", newThreadState("s2", "/p"));
    state.setThread("C2:T3", newThreadState("s3", "/p"));
    state.setThread("C1:T4", { ...newThreadState("s4", "/p", "off"), scheduledRunId: "r1" });
    const { ctx, out } = hushCtx(state);
    await getCommand("verbose")!.run(ctx, "full");
    expect(state.getThread("C1:T1")!.verbose).toBe("full");
    expect(state.getThread("C1:T2")!.verbose).toBe("full");
    expect(state.getThread("C2:T3")!.verbose).toBe("on");
    expect(state.getThread("C1:T4")!.verbose).toBe("off"); // scheduled reports stay silent
    expect(state.channelVerbose("C1")).toBe("full");
    expect(state.channelVerbose("C2")).toBe("on");
    await getCommand("verbose")!.run(ctx, "");
    expect(out.at(-1)).toContain("`full`");
  });

  it("\\hush toggles the thread state and announces it", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/hush/state.json`);
    state.setThread("C1:T1", newThreadState("s1", "/p"));

    const hush = getCommand("hush");
    expect(hush).toBeDefined();

    // Each Slack message builds a fresh CmdCtx (ctx.thread is a snapshot).
    const first = hushCtx(state);
    await hush!.run(first.ctx, "");
    expect(state.getThread("C1:T1")?.hushed).toBe(true);
    expect(first.out.at(-1)).toContain("Hushed");

    const second = hushCtx(state);
    await hush!.run(second.ctx, "");
    expect(state.getThread("C1:T1")?.hushed).toBe(false);
    expect(second.out.at(-1)).toContain("Awake");
  });

  it("\\help's sections cover every registered command exactly once", () => {
    const listed = HELP_SECTIONS.flatMap((s) => s.names);
    const all = allCommands().map((c) => c.name);
    for (const name of all) expect(listed).toContain(name);
    expect(new Set(listed).size).toBe(listed.length); // no duplicates
  });

  it("\\help lists one line per command; \\help <cmd> shows its detail", async () => {
    const out: string[] = [];
    const ctx = { postToThread: async (t: string) => { out.push(t); } } as unknown as CmdCtx;
    await execute({ name: "help", args: "" }, ctx);
    expect(out.at(-1)).not.toContain("Applies to the whole channel");
    await execute({ name: "help", args: "\\listen" }, ctx);
    expect(out.at(-1)).toContain("Applies to the whole channel");
  });

  it("no \\server command (folded into \\status)", () => {
    expect(getCommand("server")).toBeUndefined();
  });

  it("aliases resolve to one command, collide loudly, and show in \\help", async () => {
    expect(resolveCommandName("ABORT")).toBe("stop");
    expect(resolveCommandName("nope")).toBe("nope");
    expect(getCommand("cancel")).toBe(getCommand("stop"));
    expect(allCommands().some((c) => c.name === "abort")).toBe(false);
    // Collisions throw in both directions: alias vs existing name, name vs existing alias.
    expect(() => registerCommand({ name: "__a__", aliases: ["stop"], usage: "", summary: "", run: async () => {} })).toThrow(/collision/);
    expect(() => registerCommand({ name: "abort", usage: "", summary: "", run: async () => {} })).toThrow(/collision/);
    const out: string[] = [];
    const ctx = { postToThread: async (t: string) => { out.push(t); } } as unknown as CmdCtx;
    await execute({ name: "help", args: "" }, ctx);
    expect(out.at(-1)).toContain("Abort the running task _(also \\abort, \\cancel)_");
    await execute({ name: "help", args: "\\commands" }, ctx);
    expect(out.at(-1)).toContain("_(also \\cmds, \\command, \\commands)_");
    expect(out.at(-1)).toContain("same as typing the command");
  });

  it("aliases execute their target command", async () => {
    // \projects (alias of \project) with no args → the numbered listing
    const state = new StateStore(`${import.meta.dirname}/.fixtures/alias/state.json`);
    state.setCurrentProject("/code/cowork");
    state.touchProject("/code/other-app");
    const out: string[] = [];
    const ctx = {
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: null,
      state,
      config: null as never,
      cwd: "/code/cowork",
      postToThread: async (t: string) => {
        out.push(t);
      },
      uploadToThread: async () => {},
      pool: { list: () => [], ensure: async () => ({ client: null }), killOne: async () => {} } as never,
    } as unknown as CmdCtx;
    await execute({ name: "projects", args: "" }, ctx);
    expect(out.join("\n")).toContain("1) `other-app`");
  });

  it("\\model bare posts one searchable card (no numbered list) with the current model preselected", async () => {
    const out: string[] = [], blocks: unknown[][] = [];
    await getCommand("model")!.run(modelListCtx(out, "openai/gpt-5", undefined, { blocks }), "");
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("1)");
    const section = blocks[0]![0] as any;
    expect(section.text.text).toBe("*Model* — current: `openai/gpt-5`");
    expect(section.accessory).toMatchObject({ type: "external_select", action_id: "pick_model", min_query_length: 0 });
    expect(section.accessory.initial_option).toEqual({ text: { type: "plain_text", text: "GPT-5 · openai" }, value: "\\model openai/gpt-5" });
  });

  it("\\model with no thread override preselects the server's configured default", async () => {
    const out: string[] = [], blocks: unknown[][] = [];
    await getCommand("model")!.run(modelListCtx(out, undefined, undefined, { blocks }), "");
    const section = blocks[0]![0] as any;
    expect(section.text.text).toBe("*Model* — current: `anthropic/claude-sonnet-4-5`");
    expect(section.accessory.initial_option.value).toBe("\\model anthropic/claude-sonnet-4-5");
  });

  it("\\model does not invent a default when the server reports none", async () => {
    const out: string[] = [], blocks: unknown[][] = [];
    await getCommand("model")!.run(modelListCtx(out, undefined, null, { blocks }), "");
    const section = blocks[0]![0] as any;
    expect(section.text.text).toBe("*Model*");
    expect(section.accessory.initial_option).toBeUndefined();
  });

  it("\\model <#> and filters number OpenCode favorites first", async () => {
    const out: string[] = [];
    await getCommand("model")!.run(modelListCtx(out, undefined, undefined, { favorites: ["openai/gpt-5", "gone/model"] }), "1");
    expect(out.join("\n")).toContain("set to `openai/gpt-5`");
    const listed: string[] = [];
    await getCommand("model")!.run(modelListCtx(listed, undefined, undefined, { favorites: ["anthropic/claude-opus-4-1"] }), "claude");
    expect(listed.join("\n")).toContain("1) `anthropic/claude-opus-4-1`\n2) `anthropic/claude-sonnet-4-5` ★");
  });

  it("\\model <#> selects from the same ordering the listing showed", async () => {
    const out: string[] = [];
    const model = getCommand("model");
    await model!.run(modelListCtx(out), "2");
    const text = out.join("\n");
    expect(text).toContain("set to `anthropic/claude-opus-4-1`");
  });

  it("\\model still accepts plain provider/model", async () => {
    const out: string[] = [];
    const model = getCommand("model");
    await model!.run(modelListCtx(out), "openai/gpt-5");
    expect(out.join("\n")).toContain("set to `openai/gpt-5`");
  });

  it("\\agent lists numbered and accepts a number", async () => {
    const out: string[] = [];
    const state = new StateStore(`${import.meta.dirname}/.fixtures/agent/state.json`);
    state.setThread("C1:T1", newThreadState("s1", "/p"));
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }] }) },
    };
    const ctx = {
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: state.getThread("C1:T1"),
      state,
      config: null as never,
      pool: { ensure: async () => ({ client }) } as never,
      cwd: "/",
      postToThread: async (t: string) => {
        out.push(t);
      },
      uploadToThread: async () => {},
    } as unknown as CmdCtx;

    const agent = getCommand("agent");
    await agent!.run(ctx, "");
    const text = out.join("\n");
    expect(text).toContain("1) `build`");
    expect(text).toContain("2) `plan`");
    await agent!.run(ctx, "2");
    expect(out.at(-1)).toContain("set to `plan`");
  });

  it("\\cd accepts ~ paths and rebinds the thread to a FRESH session in the new dir", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/cd/state.json`);
    const home = homedir(); // guaranteed to exist on every machine — the test only proves ~ expansion
    const target = home;
    const oldSessionId = "ses_oldoldold";
    state.setThread("C1:T1", { ...newThreadState(oldSessionId, "/old/dir"), hushed: true });

    let deleted = false;
    let killed = false;
    let createdIn = "";
    const out: string[] = [];
    const ctx = {
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: state.getThread("C1:T1"),
      state,
      config: null as never,
      cwd: "/",
      postToThread: async (text: string) => {
        out.push(text);
      },
      uploadToThread: async () => {},
      pool: {
        async acquire(this: { ensure(dir: string): Promise<unknown> }, dir: string) { return { entry: await this.ensure(dir), release: () => {} }; },
        ensure: async (dir: string) => {
          createdIn = dir;
          return {
            client: {
              session: {
                // abort/delete of the old session, create of the new one
                abort: async () => ({ data: {} }),
                delete: async () => {
                  deleted = true;
                  return { data: {} };
                },
                create: async () => ({ data: { id: "ses_newnewnew", title: "t" } }),
              },
            },
          };
        },
        killOne: async () => {
          killed = true;
        },
      } as never,
    } as unknown as CmdCtx;

    await getCommand("cd")!.run(ctx, "~");
    expect(createdIn).toBe(target); // ~ expanded, no hard-coding
    const th = state.getThread("C1:T1");
    expect(th?.projectDir).toBe(target);
    expect(th?.sessionId).toBe("ses_newnewnew");
    expect(th?.sessionId).not.toBe(oldSessionId);
    // per-thread state reset (fresh session), old session + server torn down
    expect(th?.hushed).toBeUndefined();
    expect(deleted).toBe(true);
    expect(killed).toBe(true);
    expect(out.join("\n")).toContain("Switched project");
  });

  it("\\project <name|#> fuzzy-swaps through the same fresh rebind", async () => {
    const root = join(import.meta.dirname, ".fixtures", "project-swap");
    rmSync(root, { recursive: true, force: true });
    const [cowork, other] = ["cowork", "other-app"].map((name) => join(root, "code", name));
    for (const dir of [cowork!, other!]) mkdirSync(dir, { recursive: true }); // \project stats its pick (#48)
    const state = new StateStore(join(root, "state.json"));
    state.setCurrentProject(cowork!);
    state.touchProject(other!); // known project to swap to
    const out: string[] = [];
    const mkCtx = (threadModel?: string) => ({
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: threadModel ? ({ ...newThreadState("ses_old", cowork!) } as never) : null,
      state,
      config: null as never,
      cwd: cowork!,
      postToThread: async (t: string) => {
        out.push(t);
      },
      uploadToThread: async () => {},
      pool: {
        list: () => [],
        async acquire(this: { ensure(dir: string): Promise<unknown> }, dir: string) { return { entry: await this.ensure(dir), release: () => {} }; },
        ensure: async () => ({
          client: { session: { create: async () => ({ data: { id: "ses_fresh", title: "t" } }), abort: async () => ({ data: {} }), delete: async () => ({ data: {} }) } },
        }),
        killOne: async () => {},
      } as never,
    } as unknown as CmdCtx);

    const project = getCommand("project");
    expect(project).toBeDefined();

    // fuzzy name (case-insensitive substring of basename)
    await project!.run(mkCtx("x"), "OTHER");
    expect(state.currentProjectDir).toBe(canonicalDir(other!));
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_fresh");
    expect(out.at(-1)).toContain("other-app");

    // bare listing numbers the (non-current) candidates
    out.length = 0;
    await project!.run(mkCtx(), "");
    expect(out.join("\n")).toContain(`*Current:* \`${canonicalDir(other!)}\``);
    expect(out.join("\n")).toContain("1) `cowork`");

    // swap by number (relative to the current listing)
    await project!.run(mkCtx(), "1");
    expect(state.currentProjectDir).toBe(canonicalDir(cowork!));
  });
});

describe("QoL round (Sep 2026)", () => {
  it("\\model <filter> lists matches with GLOBAL numbers when ambiguous", async () => {
    const out: string[] = [];
    await getCommand("model")!.run(modelListCtx(out), "claude");
    const text = out.join("\n");
    expect(text).toContain("*Models matching* `claude` (2)");
    expect(text).toContain("1) `anthropic/claude-sonnet-4-5` ★"); // resolved server default (no override set)
    expect(text).toContain("2) `anthropic/claude-opus-4-1`");
    expect(text).toContain("numbers are global");
  });

  it("\\model <filter> with one hit sets it directly", async () => {
    const out: string[] = [];
    await getCommand("model")!.run(modelListCtx(out), "gpt");
    expect(out.join("\n")).toContain("set to `openai/gpt-5`");
  });

  it("\\model <filter> with zero hits errors", async () => {
    const out: string[] = [];
    await expect(getCommand("model")!.run(modelListCtx(out), "zzz")).rejects.toThrow(/no model matches/);
  });

  it("\\new unbinds only: old session kept on the server (\\resume recovers it)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/new-unbind/state.json`);
    state.setCurrentProject("/old/dir");
    state.setThread("C1:T1", newThreadState("ses_oldoldold", "/old/dir"));
    let aborted = false;
    let deleted = false;
    let killed = false;
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        async acquire(this: { ensure(dir: string): Promise<unknown> }, dir: string) { return { entry: await this.ensure(dir), release: () => {} }; },
        ensure: async () => ({
          client: {
            session: {
              abort: async () => {
                aborted = true;
                return { data: {} };
              },
              delete: async () => {
                deleted = true;
                return { data: {} };
              },
              create: async () => ({ data: { id: "ses_newnewnew", title: "t" } }),
            },
          },
        }),
        killOne: async () => {
          killed = true;
        },
      } as never,
    });
    await getCommand("new")!.run(ctx, "");
    expect(aborted).toBe(false);
    expect(deleted).toBe(false);
    expect(killed).toBe(false);
    const th = state.getThread("C1:T1");
    expect(th?.sessionId).toBe("ses_newnewnew");
    const reply = out.join("\n");
    expect(reply).toContain("kept");
    expect(reply).toContain("ses_oldoldold".slice(4, 14)); // shortId of the kept session
  });

  it("bare \\new stays in the thread's project unless the channel is pinned (#36)", async () => {
    const state = new StateStore(join(IDENTITY_FIXTURES, "new-thread-project.json"));
    state.setThread("C1:T1", newThreadState("ses_projbbbb", "/projB"));
    state.setCurrentProject("/launch"); // a restart (or a \cd in another thread) moved the global default
    const client = { session: { create: async () => ({ data: { id: "ses_newnewnew", title: "t" } }) } };
    const ctx = baseCtx(state, [], state.getThread("C1:T1"), { pool: {
      acquire: async () => ({ entry: { client }, release: () => {} }), ensure: async () => ({ client }), killOne: async () => {},
    } as never });
    await getCommand("new")!.run(ctx, "");
    expect(state.getThread("C1:T1")?.projectDir).toBe("/projB");
    expect(state.currentProjectDir).toBe("/launch");
    state.setChannelProject("C1", "/pinned");
    await getCommand("new")!.run({ ...ctx, thread: state.getThread("C1:T1") }, "");
    expect(state.getThread("C1:T1")?.projectDir).toBe("/pinned");
  });

  it("\\stop with nothing running or parked says so and never interrupts", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/stop-idle/state.json`);
    state.setThread("C1:T1", newThreadState("s-stop-idle", "/p"));
    let aborted = false;
    const out: string[] = [];
    const client = {
      v2: { session: { inbox: { list: async () => [] } } },
      session: { abort: async () => { aborted = true; return { data: {} }; } },
    };
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), { pool: { ensure: async () => ({ client }) } as never });
    await getCommand("stop")!.run(ctx, "");
    expect(aborted).toBe(false);
    expect(out.join("\n")).toContain("Nothing running");
  });

  it("\\stop with OpenCode down: idle says nothing is running; with a live view it still fails", async () => {
    const { SessionView, deleteView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/stop-down/state.json`);
    state.setThread("C1:T1", newThreadState("s-stop-down", "/p"));
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), { pool: { ensure: async () => { throw new Error("opencode unreachable"); } } as never });
    await getCommand("stop")!.run(ctx, "");
    expect(out).toEqual(["Nothing running in this thread."]);
    new SessionView({ sessionId: "s-stop-down", projectDir: "/p", channel: "C1", threadTs: "T1", threadKey: "C1:T1",
      client: {} as never, deps: fakeViewDeps([]), state, threadState: state.getThread("C1:T1")! });
    try {
      await expect(getCommand("stop")!.run(ctx, "")).rejects.toThrow("opencode unreachable");
    } finally { deleteView("s-stop-down"); }
  });

  it("\\stop with no live view still cancels parked prompts and reports them (0.2b)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/stop-parked-noview/state.json`);
    state.setThread("C1:T1", newThreadState("s-stop-noview", "/p"));
    const calls: string[] = [];
    const client = {
      v2: { session: { inbox: { list: async () => [{ type: "user", id: "msg_a" }, { type: "user", id: "msg_b" }] } } },
      session: {
        inboxCancel: async ({ body }: any) => void calls.push(`cancel ${body.inboxID}`),
        abort: async () => void calls.push("abort"),
      },
    };
    const out: string[] = [];
    await getCommand("stop")!.run(baseCtx(state, out, state.getThread("C1:T1"), { pool: { ensure: async () => ({ client }) } as never }), "");
    expect(calls).toEqual(["cancel msg_a", "cancel msg_b"]); // no view: nothing to interrupt
    expect(out.at(-1)).toBe("🛑 Cancelled 2 queued messages.");
  });

  it("\\stop cancels this session's parked prompts before interrupting", async () => {
    const { SessionView, deleteView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/stop-parked/state.json`);
    state.setThread("C1:T1", newThreadState("s-stop-parked", "/p"));
    const calls: string[] = [];
    const client = {
      v2: { session: { inbox: { list: async () => [{ type: "user", id: "msg_q" }, { type: "compaction", id: "c1" }] } } },
      session: {
        inboxCancel: async ({ body }: any) => void calls.push(`cancel ${body.inboxID}`),
        abort: async () => void calls.push("abort"),
      },
    };
    new SessionView({ sessionId: "s-stop-parked", projectDir: "/p", channel: "C1", threadTs: "T1", threadKey: "C1:T1",
      client: {} as never, deps: fakeViewDeps([]), state, threadState: state.getThread("C1:T1")! });
    const out: string[] = [];
    await getCommand("stop")!.run(baseCtx(state, out, state.getThread("C1:T1"), { pool: { ensure: async () => ({ client }) } as never }), "");
    deleteView("s-stop-parked");
    expect(calls).toEqual(["cancel msg_q", "abort"]);
    expect(out.at(-1)).toBe("🛑 Aborted. Cancelled 1 queued message.");
  });

  it("\\diff full posts a small unified diff inline", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/diff-full/state.json`);
    state.setThread("C1:T1", newThreadState("s-diff", "/p"));
    const out: string[] = [];
    const uploads: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        ensure: async () => ({
          client: {
            session: {
              diff: async () => ({
                data: [{ file: "src/x.ts", patch: "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n", additions: 1, deletions: 1 }],
              }),
            },
          },
        }),
      } as never,
      uploadToThread: async (filename: string) => {
        uploads.push(filename);
      },
    });
    await getCommand("diff")!.run(ctx, "full");
    const text = out.join("\n");
    expect(text).toContain("+1/−1");
    expect(text).toContain("```diff");
    expect(text).toContain("-b");
    expect(text).toContain("+B");
    expect(uploads).toEqual([]);
  });

  it("\\diff full uploads large diffs as a .diff snippet", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/diff-full-big/state.json`);
    state.setThread("C1:T1", newThreadState("s-diff-big", "/p"));
    const out: string[] = [];
    const uploads: Array<{ filename: string; content: string }> = [];
    // A fully-rewritten 4000-char line → patch body far over the inline cap.
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        ensure: async () => ({
          client: {
            session: {
              diff: async () => ({
                data: [{ file: "src/big.txt", patch: `@@ -1 +1 @@\n-${"a".repeat(4000)}\n+${"b".repeat(4000)}\n`, additions: 1, deletions: 1 }],
              }),
            },
          },
        }),
      } as never,
      uploadToThread: async (filename: string, content: string) => {
        uploads.push({ filename, content });
      },
    });
    await getCommand("diff")!.run(ctx, "full");
    expect(uploads.length).toBe(1);
    expect(uploads[0]!.filename).toMatch(/\.diff$/);
    expect(uploads[0]!.content).toContain("b".repeat(100));
    expect(out.join("\n")).not.toContain("```diff");
  });

  it("unknown commands suggest the closest match (did-you-mean)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/dym/state.json`);
    const out: string[] = [];
    await execute({ name: "hlep", args: "" }, baseCtx(state, out));
    expect(out.join("\n")).toContain("did you mean `\\help`");
    out.length = 0;
    await execute({ name: "zzzzzz", args: "" }, baseCtx(state, out));
    expect(out.join("\n")).toContain("Unknown command");
    expect(out.join("\n")).not.toContain("did you mean");
  });
});

describe("remote-work round (Sep 2026)", () => {
  it("\\cd does NOT kill a server another thread still uses (B1)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/cd-shared/state.json`);
    // Two threads bound to DIFFERENT sessions on the SAME project dir.
    state.setThread("C1:T1", newThreadState("ses_mine", "/old/dir"));
    state.setThread("C1:T2", newThreadState("ses_theirs", "/old/dir"));
    let killed = false;
    let deletedMine = false;
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        async acquire(this: { ensure(dir: string): Promise<unknown> }, dir: string) { return { entry: await this.ensure(dir), release: () => {} }; },
        ensure: async (dir: string) => ({
          client: {
            session: {
              abort: async () => ({ data: {} }),
              delete: async () => {
                if (dir === "/old/dir") deletedMine = true;
                return { data: {} };
              },
              create: async () => ({ data: { id: "ses_fresh", title: "t" } }),
            },
          },
        }),
        killOne: async () => {
          killed = true;
        },
      } as never,
    });
    await getCommand("cd")!.run(ctx, "/tmp");
    expect(deletedMine).toBe(true); // own session still torn down…
    expect(killed).toBe(false); // …but the SHARED server survives for C1:T2
    expect(state.getThread("C1:T2")?.sessionId).toBe("ses_theirs");
  });

  it("\\cd DOES kill the server when it is the last thread on that project (B1)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/cd-solo/state.json`);
    state.setThread("C1:T1", newThreadState("ses_mine", "/old/dir"));
    let killed = false;
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        async acquire(this: { ensure(dir: string): Promise<unknown> }, dir: string) { return { entry: await this.ensure(dir), release: () => {} }; },
        ensure: async () => ({
          client: {
            session: {
              abort: async () => ({ data: {} }),
              delete: async () => ({ data: {} }),
              create: async () => ({ data: { id: "ses_fresh", title: "t" } }),
            },
          },
        }),
        killOne: async () => {
          killed = true;
        },
      } as never,
    });
    await getCommand("cd")!.run(ctx, "/tmp");
    expect(killed).toBe(true);
  });

  it("\\resume detaches the old session's live view (B5)", async () => {
    const { SessionView, getView, deleteView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/resume-detach/state.json`);
    state.setThread("C1:T1", newThreadState("ses_old", "/p"));
    // Simulate a live view still rendering the old session.
    new SessionView({
      sessionId: "ses_old",
      projectDir: "/p",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: {} as never,
      deps: {
        post: async () => ({ ts: "x" }),
        update: async () => {},
        delete: async () => {},
        react: async () => {},
        unreact: async () => {},
        upload: async () => {},
      },
      state,
      threadState: state.getThread("C1:T1")!,
    });
    expect(getView("ses_old")).toBeDefined();
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        ensure: async () => ({
          client: {
            session: {
              list: async () => ({ data: [{ id: "ses_target", title: "t", time: { updated: 1 } }] }),
              get: async () => ({ data: { id: "ses_target" } }),
            },
          },
        }),
      } as never,
    });
    await getCommand("resume")!.run(ctx, "ses_target");
    expect(getView("ses_old")).toBeUndefined(); // ghost view detached
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_target");
    deleteView("ses_target");
  });

  it("\\notify toggles per-thread completion DMs", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/notify/state.json`);
    state.setThread("C1:T1", newThreadState("s1", "/p"));
    const out: string[] = [];
    const notify = getCommand("notify");
    await notify!.run(baseCtx(state, out, state.getThread("C1:T1")), "");
    expect(out.at(-1)).toContain("`off`");
    await notify!.run(baseCtx(state, out, state.getThread("C1:T1")), "on");
    expect(state.getThread("C1:T1")?.notify).toBe(true);
    expect(out.at(-1)).toContain("DM you when runs");
    await notify!.run(baseCtx(state, out, state.getThread("C1:T1")), "off");
    expect(state.getThread("C1:T1")?.notify).toBe(false);
    await expect(notify!.run(baseCtx(state, out, state.getThread("C1:T1")), "sideways")).rejects.toThrow("usage");
  });

  it("\\logs posts recent bridge log lines", async () => {
    const { pushLog, clearLogs } = await import("../src/log.js");
    clearLogs();
    const logs = getCommand("logs");
    const out0: string[] = [];
    await logs!.run(baseCtx(new StateStore(`${import.meta.dirname}/.fixtures/logs-empty/state.json`), out0), "");
    expect(out0.join("\n")).toContain("no bridge log lines");
    pushLog("something happened");
    const out1: string[] = [];
    await logs!.run(baseCtx(new StateStore(`${import.meta.dirname}/.fixtures/logs-full/state.json`), out1), "");
    expect(out1.join("\n")).toContain("something happened");
    clearLogs();
  });

  it("\\status reports bridge uptime + owner-DM reachability", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/status-bridge/state.json`);
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, {
      pool: { list: () => [] } as never,
      bridgeInfo: { startedAt: Date.now() - 65_000, dmAvailable: () => true },
    });
    await getCommand("status")!.run(ctx, "");
    const text = out.join("\n");
    expect(text).toContain("*Bridge:* up 1m");
    expect(text).toContain("owner DMs :white_check_mark:");
  });
});

describe("remote-work round 2 (Sep 2026)", () => {
  it("\\restart kills then respawns the thread's server; thread bindings survive", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/restart/state.json`);
    state.setThread("C1:T1", newThreadState("ses_a", "/p"));
    const calls: string[] = [];
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        ensure: async (dir: string) => {
          calls.push(`ensure:${dir}`);
          return { url: "http://127.0.0.1:9" };
        },
        reconnect: async () => { calls.push("reconnect"); },
      } as never,
    });
    await getCommand("restart")!.run(ctx, "");
    expect(calls).toEqual(["reconnect", "ensure:/p"]);
    expect(out.at(-1)).toContain("Reconnected");
    expect(out.at(-1)).toContain("/p");
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_a"); // sessions persist on disk — binding kept
  });

  it("\\restart with no bound thread targets the current project", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/restart-nothread/state.json`);
    state.setCurrentProject("/cur");
    const calls: string[] = [];
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, {
      pool: {
        ensure: async (dir: string) => {
          calls.push(`ensure:${dir}`);
          return { url: "http://127.0.0.1:9" };
        },
        reconnect: async () => { calls.push("reconnect"); },
      } as never,
    });
    await getCommand("restart")!.run(ctx, "");
    expect(calls).toEqual(["reconnect", "ensure:/cur"]);
    expect(out.at(-1)).toContain("Reconnected");
  });
});
describe("remote-work round 3 (Sep 2026)", () => {
  it("\\resume refuses to steal a session bound to another thread (RB4)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/resume-steal/state.json`);
    state.setThread("C1:T1", newThreadState("ses_mine", "/p"));
    state.setThread("C2:T2", newThreadState("ses_theirs", "/p"));
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: {
        ensure: async () => ({
          client: {
            session: {
              list: async () => ({ data: [{ id: "ses_theirs", title: "t", time: { updated: 1 } }] }),
              get: async () => ({ data: { id: "ses_theirs" } }),
            },
          },
        }),
      } as never,
    });
    await expect(getCommand("resume")!.run(ctx, "ses_theirs")).rejects.toThrow(/another thread/);
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_mine"); // binding untouched
    expect(state.getThread("C2:T2")?.sessionId).toBe("ses_theirs");
  });

  it("\\status lists runs in flight with elapsed time (RQ1)", async () => {
    const { SessionView, deleteView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/status-runs/state.json`);
    new SessionView({
      sessionId: "ses_run",
      projectDir: "/p",
      channel: "C1",
      threadTs: "T9",
      threadKey: "C1:T9",
      client: {} as never,
      deps: {
        post: async () => ({ ts: "x" }),
        update: async () => {},
        delete: async () => {},
        react: async () => {},
        unreact: async () => {},
        upload: async () => {},
      },
      state,
      threadState: { sessionId: "ses_run", projectDir: "/p", verbose: "off", createdAt: 1, lastUsedAt: 1 },
    });
    const { getView } = await import("../src/slack/render.js");
    await getView("ses_run")!.beginPrompt("1.1");
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, {
      pool: { list: () => [] } as never,
      threadUrl: () => "https://x/archives/C1/p9",
    });
    await getCommand("status")!.run(ctx, "");
    const text = out.join("\n");
    expect(text).toContain("*Runs in flight:*");
    expect(text).toContain("*p*");
    expect(text).toContain("https://x/archives/C1/p9");
    deleteView("ses_run");
  });

  it("\\status stays section-free when nothing runs (RQ1 empty state)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/status-empty/state.json`);
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { pool: { list: () => [] } as never });
    await getCommand("status")!.run(ctx, "");
    expect(out.join("\n")).not.toContain("Runs in flight");
  });

  it("\\status shows the Slack queue line with the oldest pending op's age (C2)", async () => {
    const { enqueue, _resetQueueForTests, queueDepth } = await import("../src/slack/queue.js");
    vi.useFakeTimers();
    _resetQueueForTests();
    try {
      // A stuck op occupies C9's drain; a second op queues behind it.
      void enqueue(() => new Promise(() => {}), { channel: "C9" }).catch(() => {});
      void enqueue(() => Promise.resolve(), { channel: "C9" }).catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000); // drain picks the stuck op; pending op ages ≥1s
      expect(queueDepth()).toBe(1);
      const state = new StateStore(`${import.meta.dirname}/.fixtures/status-queue/state.json`);
      const out: string[] = [];
      const ctx = baseCtx(state, out, null, { pool: { list: () => [] } as never });
      await getCommand("status")!.run(ctx, "");
      expect(out.join("\n")).toMatch(/\*Slack queue:\* 1 pending \(oldest .+?\) · 0 dropped/);
    } finally {
      _resetQueueForTests();
      vi.useRealTimers();
    }
  });

  it("\\logs [filter] narrows the ring buffer (RQ4)", async () => {
    const { pushLog } = await import("../src/log.js");
    pushLog(`needle-${Date.now()} unique line for the filter test`);
    pushLog("hay line that must not match");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/logs-filter/state.json`);
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { pool: null as never });
    await getCommand("logs")!.run(ctx, "needle");
    const text = out.join("\n");
    expect(text).toContain("needle-");
    expect(text).not.toContain("hay line");
  });
});

describe("command liveness ack (👀 → ✅/❌)", () => {
  // Records the react sequence; add=false is tagged "name!" to distinguish remove.
  function ackCtx(reactLog: string[], out: string[]) {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/ack/state.json`);
    return {
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: null,
      state,
      config: null as never,
      cwd: "/",
      postToThread: async (t: string) => {
        out.push(t);
      },
      uploadToThread: async () => {},
      react: async (name: string, add = true) => {
        reactLog.push(add ? name : `${name}!`);
      },
    } as unknown as CmdCtx;
  }

  it("adds 👀 then swaps to ✅ when the command succeeds", async () => {
    const log: string[] = [];
    const out: string[] = [];
    await execute({ name: "help", args: "" }, ackCtx(log, out));
    expect(log).toEqual(["eyes", "eyes!", "white_check_mark"]);
  });

  it("swaps to ❌ and still reports the error when the command throws", async () => {
    registerCommand({ name: "__ack_throw__", usage: "", summary: "", run: async () => { throw new Error("kaboom"); } });
    const log: string[] = [];
    const out: string[] = [];
    await execute({ name: "__ack_throw__", args: "" }, ackCtx(log, out));
    expect(log).toEqual(["eyes", "eyes!", "x"]);
    expect(out.join("\n")).toContain("failed: kaboom");
  });

  it("does NOT react on unknown commands (they reply instantly)", async () => {
    const log: string[] = [];
    const out: string[] = [];
    await execute({ name: "zzzzzz", args: "" }, ackCtx(log, out));
    expect(log).toEqual([]);
    expect(out.join("\n")).toContain("Unknown command");
  });
});

// ---------------------------------------------------------------------------
// Sessions: picker, summary, watch

import type { RenderDeps } from "../src/slack/render.js";
import type { OcSession } from "../src/opencode/api.js";
import { invalidatePickerCache, noteSessionActivity } from "../src/commands/picker.js";

let pickerFixture = 0;

function ocSess(id: string, dir: string, title: string, ageMs: number): OcSession {
  const updated = Date.now() - ageMs;
  return { id, directory: dir, title, time: { created: updated - 1000, updated } };
}

/** Stub server pool: `list` sessions are machine-global (spike 2); other session fakes configurable. */
function poolWith(sessions: OcSession[], extra: Record<string, unknown> = {}): never {
  return {
    // Mirrors ServerPool.acquire: a lease over ensure().
    async acquire(this: { ensure(dir: string): Promise<unknown> }, dir: string) { return { entry: await this.ensure(dir), release: () => {} }; },
    ensure: async (dir: string) => ({
      dir,
      client: {
        session: {
          list: async () => ({ data: sessions }),
          ...extra,
        },
      },
    }),
    list: () => [],
  } as never;
}

function fakeViewDeps(posted: string[], deleted: string[] = []): RenderDeps {
  return {
    post: async (_c, _t, text) => {
      posted.push(text);
      return { ts: `posted-${posted.length}` };
    },
    update: async () => {},
    delete: async (_c, ts) => void deleted.push(ts),
    react: async () => {},
    unreact: async () => {},
    upload: async () => {},
  };
}

describe("sessions picker + resume", () => {
  it("\\sessions bare lists the current project with markers; `all` lists machine-wide", async () => {
    const { invalidatePickerCache } = await import("../src/commands/picker.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/sessions-scope/state.json`);
    state.setThread("C1:T1", newThreadState("ses_mine", "/p"));
    const out: string[] = [];
    const mk = () => baseCtx(state, out, state.getThread("C1:T1"), {
      pool: poolWith([ocSess("ses_mine", "/p", "Mine", 5_000), ocSess("ses_theirs", "/elsewhere", "Theirs", 1_000)]),
    } as never);
    await getCommand("sessions")!.run(mk(), "");
    let text = out.at(-1)!;
    expect(text).toContain("*Sessions in* `/p`");
    expect(text).toContain("ses_mine".slice(4, 14));
    expect(text).not.toContain("Theirs");
    out.length = 0;
    invalidatePickerCache("C1:T1");
    await getCommand("sessions")!.run(mk(), "all");
    text = out.at(-1)!;
    expect(text).toContain("machine-wide");
    expect(text).toContain("Theirs");
    invalidatePickerCache("C1:T1");
  });

  it("\\sessions <filter> narrows machine-wide and caps with the (+N older) hint", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/sessions-filter/state.json`);
    const many = Array.from({ length: 13 }, (_, i) => ocSess(`ses_f${String(i).padStart(2, "0")}`, "/p", `fix ${i}`, i * 1000));
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { pool: poolWith(many) } as never);
    await getCommand("sessions")!.run(ctx, "fix");
    const text = out.at(-1)!;
    expect(text).toContain("13 sessions");
    expect(text).toContain("(+3 older");
    invalidatePickerCache("C1:T1");
  });

  it("\\resume <#> binds the session the user actually saw, even after the order drifts", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/resume-stable/state.json`);
    const a = ocSess("ses_aaa", "/p", "Alpha", 20_000);
    const b = ocSess("ses_bbb", "/p", "Beta", 10_000);
    const out: string[] = [];
    const ctx1 = baseCtx(state, out, null, { pool: poolWith([a, b]) } as never);
    await getCommand("sessions")!.run(ctx1, "all"); // displayed: 1=b, 2=a
    // Server order now drifts — \resume 2 must still bind what "2" showed.
    const ctx2 = baseCtx(state, out, null, {
      pool: poolWith([b, a], { get: async () => ({ data: { id: "ses_aaa" } }) }),
    } as never);
    await getCommand("resume")!.run(ctx2, "2");
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_aaa");
    invalidatePickerCache("C1:T1");
  });

  it("\\resume on an expired list re-lists instead of guessing", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/resume-stale/state.json`);
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { pool: poolWith([ocSess("ses_aaa", "/p", "Alpha", 10_000)]) } as never);
    await getCommand("sessions")!.run(ctx, "all");
    invalidatePickerCache("C1:T1");
    await getCommand("resume")!.run(ctx, "1");
    expect(out.at(-1)).toContain("expired");
    expect(out.at(-1)).toContain("pick again");
    expect(state.getThread("C1:T1")).toBeNull(); // nothing bound
    invalidatePickerCache("C1:T1");
  });

  it("\\resume rebinding a watched session lifts the read-only gate", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/resume-unwatch/state.json`);
    state.setThread("C1:T1", { sessionId: "ses_old", projectDir: "/p", verbose: "on", watchOnly: true, createdAt: 1, lastUsedAt: 1 });
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: poolWith([ocSess("ses_target", "/p", "T", 1_000)], { get: async () => ({ data: { id: "ses_target" } }) }),
    } as never);
    await getCommand("resume")!.run(ctx, "ses_target");
    expect(state.getThread("C1:T1")?.watchOnly).toBe(false);
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_target");
    invalidatePickerCache("C1:T1");
  });

  it("\\help groups watch/unwatch/history/summary/usage under Monitoring", () => {
    const monitoring = HELP_SECTIONS.find((s) => s.title === "Monitoring");
    expect(monitoring?.names).toEqual(["watch", "unwatch", "history", "summary", "usage"]);
  });
});

describe("\\history", () => {
  const transcript = [
    { info: { id: "m1", sessionID: "s", role: "user" }, parts: [{ id: "p1", type: "text", text: "fix the login bug" }] },
    {
      info: { id: "m2", sessionID: "s", role: "assistant" },
      parts: [
        { id: "p2", type: "text", text: "Looking at the auth module.\n\nFound the wrong key." },
        { id: "p3", type: "tool", tool: "read" },
        { id: "p4", type: "tool", tool: "edit" },
      ],
    },
    { info: { id: "m3", sessionID: "s", role: "user" }, parts: [{ id: "p5", type: "text", text: "add tests" }] },
    { info: { id: "m4", sessionID: "s", role: "assistant" }, parts: [{ id: "p6", type: "text", text: "Added two cases." }] },
  ];

  it("digests the thread's session tail: you/agent lines + tool counts", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/history-digest/state.json`);
    state.setThread("C1:T1", newThreadState("ses_hist", "/p"));
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: poolWith([], { messages: async () => ({ data: transcript }) }),
    } as never);
    await getCommand("history")!.run(ctx, "1");
    const text = out.at(-1)!;
    expect(text).toContain("*you* add tests");
    expect(text).toContain("*agent* Added two cases.");
    expect(text).not.toContain("fix the login bug"); // tail 1 turn only
  });

  it("targets a picker session and counts tool calls", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/history-target/state.json`);
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, {
      pool: poolWith([ocSess("ses_target", "/elsewhere", "T", 1_000)], { messages: async () => ({ data: transcript }) }),
    } as never);
    await getCommand("history")!.run(ctx, "ses_target");
    const text = out.join("\n");
    expect(text).toContain("ses_target".slice(4, 14));
    expect(text).toContain("2 tool calls");
    invalidatePickerCache("C1:T1");
  });

  it("renderHistoryDigest: first line only for user, first paragraph for agent", async () => {
    const { renderHistoryDigest } = await import("../src/commands/handlers.js");
    const digest = renderHistoryDigest("ses_x", [
      { info: { id: "m1", sessionID: "s", role: "user" }, parts: [{ id: "p1", type: "text", text: "line one\nline two" }] },
      { info: { id: "m2", sessionID: "s", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "para one\n\npara two" }] },
    ], 10);
    expect(digest).toContain("*you* line one");
    expect(digest).not.toContain("line two");
    expect(digest).toContain("*agent* para one");
    expect(digest).not.toContain("para two");
  });
});

describe("\\summary", () => {
  function summaryClient(opts: { summary?: string; tailIncomplete?: boolean } = {}) {
    const calls: { abort: number; delete: number; promptBody?: Record<string, unknown> } = { abort: 0, delete: 0 };
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_throwaway" } }),
        promptAsync: async (o: { body: Record<string, unknown> }) => {
          calls.promptBody = o.body;
          return { data: {} };
        },
        messages: async () => ({
          data: opts.tailIncomplete
            ? [
                { info: { id: "m1", sessionID: "s", role: "user" }, parts: [{ id: "p1", type: "text", text: "hello" }] },
                { info: { id: "m2", sessionID: "s", role: "assistant", time: { created: Date.now() } }, parts: [] },
              ]
            : [
                { info: { id: "m1", sessionID: "s", role: "user" }, parts: [{ id: "p1", type: "text", text: "please refactor auth" }] },
                { info: { id: "m2", sessionID: "s", role: "assistant", time: { completed: 1 } }, parts: [{ id: "p2", type: "text", text: "Done — extracted the token store." }] },
              ],
        }),
        abort: async () => {
          calls.abort += 1;
          return { data: {} };
        },
        delete: async () => {
          calls.delete += 1;
          return { data: {} };
        },
      },
    };
    return { client, calls };
  }

  it("summarizes via a throwaway session and cleans it up (abort + delete)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/summary-ok/state.json`);
    state.setThread("C1:T1", { ...newThreadState("ses_target", "/p"), model: "prov/m" });
    const out: string[] = [];
    const { client, calls } = summaryClient({ summary: "S" });
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), { pool: poolWith([], client.session) } as never);
    await getCommand("summary")!.run(ctx, "");
    const text = out.join("\n");
    expect(text).toContain("Summary of");
    expect(text).toContain("Done — extracted the token store.");
    expect(calls.abort).toBe(1);
    expect(calls.delete).toBe(1);
    // Thread's model override drives the throwaway run; transcript rides along.
    expect(calls.promptBody?.model).toEqual({ providerID: "prov", modelID: "m" });
    expect(JSON.stringify(calls.promptBody)).toContain("please refactor auth");
  });

  it("refuses while the target looks mid-run (incomplete recent assistant reply)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/summary-busy/state.json`);
    state.setThread("C1:T1", newThreadState("ses_target", "/p"));
    const out: string[] = [];
    const { client, calls } = summaryClient({ tailIncomplete: true });
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), { pool: poolWith([], client.session) } as never);
    await expect(getCommand("summary")!.run(ctx, "")).rejects.toThrow(/mid-run/);
    expect(calls.abort).toBe(0); // never spawned
  });
});

describe("\\watch / \\unwatch", () => {
  it("binds the thread read-only, attaches a live view, and writes NO pendingRun tombstone", async () => {
    const { getView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/watch-attach/state.json`);
    const posted: string[] = [];
    const deleted: string[] = [];
    // Transcript: old completed content + a live post-attach assistant message
    // (incomplete → the settle timer never fires mid-test).
    const msgs = [
      { info: { id: "m0", sessionID: "s", role: "user", time: { created: 1 } }, parts: [] },
      { info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ id: "p0", type: "text", text: "old content" }] },
      { info: { id: "m2", sessionID: "s", role: "assistant", time: { created: Date.now() } }, parts: [{ id: "p1", type: "text", text: "streaming…" }] },
    ];
    const ctx = baseCtx(state, [], null, {
      pool: poolWith([ocSess("ses_watchme", "/comp/dir", "Live", 1_000)], { messages: async () => ({ data: msgs }) }),
      render: fakeViewDeps(posted, deleted),
    } as never);
    await getCommand("watch")!.run(ctx, "ses_watchme");
    await new Promise((r) => setTimeout(r, 20)); // let the immediate first poll land
    const th = state.getThread("C1:T1");
    expect(th?.watchOnly).toBe(true);
    expect(th?.projectDir).toBe("/comp/dir");
    expect(th?.pendingRun).toBeUndefined(); // the boot sweep must never ❌ this thread
    expect(getView("ses_watchme")).toBeDefined();
    expect(posted.join("\n")).toContain("watching");
    // A stale Home Stop must not interrupt the session the computer is driving.
    await stopThreadFromButton({ state, pool: ctx.pool, render: ctx.render! }, "C1:T1");
    expect(posted.at(-1)).toContain("mirrored with `\\watch` and driven elsewhere");
    expect(getView("ses_watchme")).toBeDefined();
    await getCommand("unwatch")!.run({ ...ctx, thread: state.getThread("C1:T1") } as never, "");
    expect(state.getThread("C1:T1")?.watchOnly).toBe(false);
    expect(getView("ses_watchme")).toBeUndefined();
    expect(deleted.length).toBeGreaterThan(0); // watching status line removed
  });

  it("refuses to watch a session bound to another thread (one view per session)", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/watch-conflict/state.json`);
    state.setThread("C2:T9", newThreadState("ses_theirs", "/p"));
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, {
      pool: poolWith([ocSess("ses_theirs", "/p", "Theirs", 1_000)]),
      render: fakeViewDeps([]),
    } as never);
    await expect(getCommand("watch")!.run(ctx, "ses_theirs")).rejects.toThrow(/another thread/);
    expect(state.getThread("C1:T1")).toBeNull();
  });

  it("\\unwatch without a watch says so and touches nothing", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/watch-none/state.json`);
    const out: string[] = [];
    const ctx = baseCtx(state, out, null, { pool: poolWith([]) } as never);
    await getCommand("unwatch")!.run(ctx, "");
    expect(out.at(-1)).toContain("isn't watching");
  });
});

describe("\\fork / \\undo", () => {
  it("\\fork 1 forks before the last real user turn, posts top-level, and binds the new thread with inherited settings", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/fork/state.json`);
    state.setThread("C1:T1", { ...newThreadState("ses_orig", "/p", "off"), model: "a/b", agent: "plan", stream: false, hushed: true });
    const msgs = [
      { info: { id: "u1", sessionID: "s", role: "user" }, parts: [{ id: "p1", type: "text", text: "one" }] },
      { info: { id: "u2", sessionID: "s", role: "user" }, parts: [{ id: "p2", type: "text", text: "two" }] },
      { info: { id: "q1", sessionID: "s", role: "user" }, parts: [] }, // parked inbox item, not a turn
    ];
    const fork = vi.fn(async () => ({ data: { id: "ses_forked", directory: "/p", title: "", time: { created: 1, updated: 1 } } }));
    const posts: Array<{ threadTs: string; text: string }> = [];
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: poolWith([], { messages: async () => ({ data: msgs }), fork }),
      render: { post: async (_c: string, threadTs: string, text: string) => { posts.push({ threadTs, text }); return { ts: "R9" }; } },
      threadUrl: (k: string) => `https://x/${k}`,
    } as never);
    await getCommand("fork")!.run(ctx, "1");
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_orig" }, body: { before: "u2" } }));
    expect(posts).toEqual([expect.objectContaining({ threadTs: "" })]);
    expect(posts[0]!.text).toContain("shares the same working directory");
    expect(state.getThread("C1:R9")).toMatchObject({ sessionId: "ses_forked", projectDir: "/p", verbose: "off", model: "a/b", agent: "plan", stream: false });
    expect(state.getThread("C1:R9")?.hushed).toBeUndefined();
    expect(out.at(-1)).toContain("<https://x/C1:R9|new thread>");
    await getCommand("fork")!.run(ctx, "3");
    expect(out.at(-1)).toBe("Only 2 turns in this session.");
  });

  it("\\undo 2 stages at the second-to-last real user turn, posts a card listing the files, and refuses while the view is active", async () => {
    const { SessionView, deleteView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/undo/state.json`);
    state.setThread("C1:T1", newThreadState("ses_undo", "/p"));
    const msgs = [
      { info: { id: "u1", sessionID: "s", role: "user" }, parts: [{ id: "p1", type: "text", text: "refactor the parser" }] },
      { info: { id: "u2", sessionID: "s", role: "user" }, parts: [{ id: "p2", type: "text", text: "add tests" }] },
      { info: { id: "q1", sessionID: "s", role: "user" }, parts: [] },
    ];
    const revertStage = vi.fn(async () => ({ data: { messageID: "u1", files: [{ file: "src/parse.ts", additions: 0, deletions: 42, patch: "" }] } }));
    const posts: Array<{ text: string; blocks?: any[] }> = [];
    const ctx = baseCtx(state, [], state.getThread("C1:T1"), {
      pool: poolWith([], { messages: async () => ({ data: msgs }), get: async () => ({ data: { id: "ses_undo" } }), revertStage }),
      postToThread: async (text: string, blocks?: any[]) => void posts.push({ text, blocks }),
    } as never);
    const view = new SessionView({ sessionId: "ses_undo", projectDir: "/p", channel: "C1", threadTs: "T1", threadKey: "C1:T1",
      client: {} as never, deps: fakeViewDeps([]), state, threadState: state.getThread("C1:T1")! });
    await view.beginPrompt("1.1");
    await getCommand("undo")!.run(ctx, "2");
    expect(revertStage).not.toHaveBeenCalled();
    expect(posts.at(-1)!.text).toContain("Use `\\stop` first");
    deleteView("ses_undo");

    await getCommand("undo")!.run(ctx, "2");
    expect(revertStage).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_undo" }, body: { messageID: "u1" } }));
    const card = posts.at(-1)!;
    expect(card.text).toContain("Rewound 2 turns (“refactor the parser”)");
    expect(card.text).toContain("`+0/−42` src/parse.ts");
    expect(card.blocks?.[1].elements.map((e: any) => e.text.text)).toEqual(["Keep", "Put it back"]);
    expect(JSON.parse(card.blocks?.[1].elements[0].value)).toEqual({ s: "ses_undo", m: "u1", n: 2 });
  });
});

describe("\\listen", () => {
  const dir = join(import.meta.dirname, ".fixtures", "listen");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is off by default and toggles per channel, persisting across reloads", async () => {
    rmSync(dir, { recursive: true, force: true });
    const state = new StateStore(join(dir, "state.json"));
    const out: string[] = [];
    const ctx = baseCtx(state, out);
    expect(state.isAlwaysOn("C1")).toBe(false);
    await execute({ name: "listen", args: "" }, ctx);
    expect(new StateStore(join(dir, "state.json")).isAlwaysOn("C1")).toBe(true);
    expect(state.isAlwaysOn("C2")).toBe(false);
    await execute({ name: "listen", args: "" }, ctx);
    expect(state.isAlwaysOn("C1")).toBe(false);
    await execute({ name: "listen", args: "on" }, ctx);
    await execute({ name: "listen", args: "on" }, ctx);
    expect(state.isAlwaysOn("C1")).toBe(true);
    await execute({ name: "listen", args: "off" }, ctx);
    expect(new StateStore(join(dir, "state.json")).isAlwaysOn("C1")).toBe(false);
  });

  it("explains that DMs always listen", async () => {
    const out: string[] = [];
    const state = new StateStore(join(dir, "dm-state.json"));
    await execute({ name: "listen", args: "on" }, baseCtx(state, out, null, { channelId: "D1" }));
    expect(out.at(-1)).toMatch(/DMs always listen/);
    expect(state.isAlwaysOn("D1")).toBe(false);
  });
});

describe("\\cmd", () => {
  const leasePool = (client: unknown) => ({ acquire: async () => ({ entry: { client }, release: () => {} }) }) as never;

  it("bare \\cmd lists the project's native commands", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/cmd-list/state.json`);
    const out: string[] = [];
    const client = { commands: async () => ({ data: [{ name: "compact", description: "Summarize context" }, { name: "init" }] }) };
    await getCommand("commands")!.run(baseCtx(state, out, null, { cwd: "/p", pool: leasePool(client) }), "");
    expect(out.at(-1)).toBe("*OpenCode commands in* `/p`\n• `compact` — Summarize context\n• `init`\n\nRun one with `\\cmd <command> [args]`.");
  });

  it("\\cmd hands its message to a live view, so the queued run streams and finalizes like a prompt (#31)", async () => {
    const { getView, deleteView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/cmd-view/state.json`);
    state.setThread("C1:T1", newThreadState("ses_cmd_view", "/p"));
    const command = vi.fn(async () => undefined); // V2: queued, no output in the reply
    const posted: string[] = [];
    const reactions: string[] = [];
    const render = { ...fakeViewDeps(posted),
      react: async (_c: string, ts: string, name: string) => void reactions.push(`+${name} ${ts}`),
      unreact: async (_c: string, ts: string, name: string) => void reactions.push(`-${name} ${ts}`) };
    const ctx = baseCtx(state, [], state.getThread("C1:T1"), { pool: leasePool({ session: { command } }), render, messageTs: "M1",
      react: async (name: string, add = true) => void reactions.push(`${add ? "+" : "-"}${name} M1`) });
    try {
      await execute({ name: "cmd", args: "review src/x.ts" }, ctx);
      expect(command).toHaveBeenCalledWith(expect.objectContaining({ body: { command: "review", arguments: "src/x.ts" } }));
      const view = getView("ses_cmd_view");
      expect(view?.isActive).toBe(true);
      expect(reactions).toEqual(["+eyes M1"]); // execute leaves the outcome to the view
      await view!.handle({ type: "message.part.updated",
        properties: { part: { id: "p1", messageID: "m1", type: "text", text: "Review: looks good", time: { end: 1 } } } } as never);
      await view!.finalize();
      expect(posted.some((p) => p.includes("Review: looks good"))).toBe(true);
      expect(posted.some((p) => p.includes("no text output"))).toBe(false);
      expect(reactions.slice(1)).toEqual(["-eyes M1", "+white_check_mark M1"]);
    } finally { deleteView("ses_cmd_view"); }
  });

  it("\\cmd that fails to queue drops the view it attached", async () => {
    const { getView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/cmd-fail/state.json`);
    state.setThread("C1:T1", newThreadState("ses_cmd_fail", "/p"));
    const client = { session: { command: async () => { throw new Error("unknown command"); } } };
    const ctx = baseCtx(state, [], state.getThread("C1:T1"), { pool: leasePool(client), render: fakeViewDeps([]), messageTs: "M1" });
    await expect(getCommand("cmd")!.run(ctx, "nope")).rejects.toThrow("unknown command");
    expect(getView("ses_cmd_fail")).toBeUndefined();
  });
});

describe("\\usage", () => {
  const stats = (over: Record<string, unknown> = {}) => ({
    range: { from: 0, to: 1 }, sessions: 14, subagents: 0, prompts: 30, steps: 90,
    tokens: { input: 900_000, output: 250_000, reasoning: 50_000, cache: { read: 3_000_000, write: 400_000 } },
    cost: 12.345, tools: {}, activeDays: 5, streak: 2, models: [],
    activity: [{ date: "2026-10-02", steps: 4 }, { date: "2026-10-04", steps: 32 }, { date: "2026-10-08", steps: 16 }],
    ...over,
  }) as never;

  it("parses range and scope in any order and rejects unknown words", async () => {
    const { parseUsageArgs } = await import("../src/commands/usage.js");
    expect(parseUsageArgs("")).toEqual({ range: "7d", all: false });
    expect(parseUsageArgs("ALL 30d")).toEqual({ range: "30d", all: true });
    expect(parseUsageArgs("today")).toEqual({ range: "today", all: false });
    expect(() => parseUsageArgs("week")).toThrow(/unknown argument `week`/);
  });

  it("maps steps onto eight bar heights with '·' for idle days", async () => {
    const { sparkline } = await import("../src/commands/usage.js");
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7, 8])).toBe("·▁▂▃▄▅▆▇█");
    expect(sparkline([0, 0])).toBe("··");
    expect(sparkline([1, 100])).toBe("▁█");
  });

  it("formats a stats fixture with today's cost and an oldest→today sparkline", async () => {
    const { formatUsage, dayKeys } = await import("../src/commands/usage.js");
    const days = dayKeys(new Date(2026, 9, 2), 7, Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(days).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(formatUsage(stats(), { scope: "slackoc", range: "7d", days, todayCost: 1.819 })).toBe([
      "*Usage · slackoc · last 7 days*",
      "*$12.35* · today $1.82",
      "1.2M tokens (+3.4M cached) · 14 sessions · 5 active days",
      "▁·█···▄",
    ].join("\n"));
    // A single day has no sparkline and no redundant "today" figure.
    expect(formatUsage(stats({ sessions: 1, activeDays: 1 }), { scope: "all projects", range: "today", days: ["2026-10-08"], todayCost: 9 }))
      .toBe("*Usage · all projects · today*\n*$12.35*\n1.2M tokens (+3.4M cached) · 1 session · 1 active day");
  });

  it("queries the thread's project by ID, or every project with `all`", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/usage/state.json`);
    state.setThread("C1:T1", newThreadState("ses_u", "/code/slackoc"));
    const calls: Array<Record<string, unknown>> = [];
    const client = { projectId: async () => "prj_1", stats: async (input: Record<string, unknown>) => { calls.push(input); return stats(); } };
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), { pool: { acquire: async () => ({ entry: { client }, release: () => {} }) } as never });
    await execute({ name: "cost", args: "" }, ctx);
    expect(out.at(-1)).toMatch(/^\*Usage · slackoc · last 7 days\*/);
    expect(calls).toHaveLength(2); // range + today
    expect(calls.every((c) => c.project === "prj_1" && typeof c.timezone === "string")).toBe(true);
    calls.length = 0;
    await execute({ name: "usage", args: "today all" }, ctx);
    expect(out.at(-1)).toMatch(/^\*Usage · all projects · today\*/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.project).toBeUndefined();
  });
});

describe("overlapping rebinds (#12)", () => {
  const FIX = join(IDENTITY_FIXTURES, "rebind-race");
  const dirA = join(FIX, "a"), dirB = join(FIX, "b");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const A = canonicalDir(dirA), B = canonicalDir(dirB);

  /** Every session create/abort waits until the test resolves it. */
  function rig(name: string, bound?: string) {
    const state = new StateStore(join(FIX, name, "state.json"));
    state.setCurrentProject(A);
    if (bound) state.setThread("C1:T1", newThreadState(bound, A));
    const creates: Array<{ dir: string; done: (id: string) => void }> = [];
    const aborts: Array<() => void> = [];
    const killed: string[] = [];
    const out: string[] = [];
    const client = (dir: string) => ({ session: {
      create: () => new Promise((res) => creates.push({ dir, done: (id) => res({ data: { id } }) })),
      abort: () => new Promise((res) => aborts.push(() => res({ data: {} }))),
      delete: async () => ({ data: {} }),
    } });
    const pool = { acquire: async (dir: string) => ({ entry: { client: client(dir) }, release: () => {} }),
      killOne: async (dir: string) => { killed.push(dir); } };
    /** Starts a command the way the router does: thread read when it arrives. */
    const run = (name: string, args: string, messageTs: string) => getCommand(name)!.run(baseCtx(state, out,
      state.getThread("C1:T1"), { pool: pool as never, messageTs }), args);
    return { state, creates, aborts, killed, out, run };
  }

  it("a delayed older \\new cannot replace a newer completed binding", async () => {
    const { state, creates, out, run } = rig("existing", "ses_old");
    const older = run("new", "", "1.1");
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    const newer = run("new", dirB, "1.2");
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[1]!.done("ses_fast");
    await newer;
    creates[0]!.done("ses_slow");
    await older;
    expect(state.getThread("C1:T1")).toMatchObject({ sessionId: "ses_fast", projectDir: B });
    expect(state.currentProjectDir).toBe(B);
    expect(out.at(-1)).toContain("Superseded");
  });

  it.each([["newer", 1, 0], ["older", 0, 1]])("an initially unbound thread keeps the newer \\new when the %s finishes first", async (_label, first, second) => {
    const { state, creates, run } = rig(`unbound-${first}`);
    const runs = [run("new", "", "2.1")];
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    runs.push(run("new", dirB, "2.2"));
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[first]!.done(`ses_${first}`);
    await runs[first];
    creates[second]!.done(`ses_${second}`);
    await runs[second];
    expect(state.getThread("C1:T1")).toMatchObject({ sessionId: "ses_1", projectDir: B });
  });

  it("a superseded \\cd skips the rest of its teardown, sparing the newer session's server", async () => {
    const { state, creates, aborts, killed, run } = rig("teardown", "ses_old");
    const older = run("cd", dirB, "3.1");
    await vi.waitFor(() => expect(aborts).toHaveLength(1));
    const newer = run("new", dirA, "3.2"); // back in project A, so A's server must survive
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    creates[0]!.done("ses_new");
    await newer;
    aborts[0]!();
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[1]!.done("ses_stale");
    await older;
    expect(killed).toEqual([]);
    expect(state.getThread("C1:T1")).toMatchObject({ sessionId: "ses_new", projectDir: A });
  });
});


describe("\\pin (channel project lock)", () => {
  const FIX = `${import.meta.dirname}/.fixtures/pin/state.json`;
  afterAll(() => rmSync(`${import.meta.dirname}/.fixtures/pin`, { recursive: true, force: true }));
  const pinned = canonicalDir(homedir());
  const other = canonicalDir(import.meta.dirname);
  const pool = {
    async acquire(dir: string) { return { entry: { client: { session: { create: async () => ({ data: { id: `ses_in_${dir}` } }) } } }, release: () => {} }; },
    ensure: async () => ({ client: { session: {
      list: async () => ({ data: [{ id: "ses_foreign", title: "t", directory: other, time: { updated: 1 } }] }),
      get: async () => ({ data: { id: "ses_foreign" } }) } } }),
    list: () => [],
  } as never;

  it("pins, persists, refuses other folders, allows its own, and unpins", async () => {
    const state = new StateStore(FIX);
    const out: string[] = [];
    await getCommand("pin")!.run(baseCtx(state, out, null, { pool }), "~");
    expect(new StateStore(FIX).channelProject("C1")).toBe(pinned); // canonical + survives reload
    expect(state.defaultDir("C1", "/")).toBe(pinned);
    expect(state.defaultDir("C2", "/")).not.toBe(pinned); // other channels unaffected

    await expect(getCommand("cd")!.run(baseCtx(state, out, null, { pool }), other)).rejects.toThrow(/pinned to/);
    await expect(getCommand("new")!.run(baseCtx(state, out, null, { pool }), other)).rejects.toThrow(/pinned to/);
    await expect(getCommand("resume")!.run(baseCtx(state, out, null, { pool }), "ses_foreign")).rejects.toThrow(/pinned to/);
    expect(state.getThread("C1:T1")).toBeNull();

    await getCommand("cd")!.run(baseCtx(state, out, null, { pool }), "~");
    expect(state.getThread("C1:T1")?.projectDir).toBe(pinned);

    await getCommand("unpin")!.run(baseCtx(state, out, null, { pool }), "");
    expect(state.channelProject("C1")).toBeUndefined();
    await getCommand("cd")!.run(baseCtx(state, out, null, { pool }), other);
    expect(state.getThread("C1:T1")?.projectDir).toBe(other);
  });
});

describe("\\status context meter (E3)", () => {
  it("shows the thread's context use where its last run ended, and nothing when unknown", async () => {
    const { SessionView } = await import("../src/slack/render.js");
    const state = new StateStore(`${import.meta.dirname}/.fixtures/status-ctx/state.json`);
    const catalog = { default: {}, providers: [{ id: "anthropic", name: "anthropic", models: { sonnet: { id: "sonnet", name: "Sonnet", limit: { context: 200_000 } } } }] };
    const view = new SessionView({ sessionId: "ses_ctx", projectDir: "/p", channel: "C1", threadTs: "T1", threadKey: "C1:T1",
      client: { directory: "/status-ctx", config: { providers: async () => ({ data: catalog }) } } as never,
      deps: { post: async () => ({ ts: "x" }), update: async () => {}, delete: async () => {}, react: async () => {}, unreact: async () => {}, upload: async () => {} },
      state, threadState: newThreadState("ses_ctx", "/p") });
    await view.handle({ type: "message.updated", properties: { info: { id: "m1", role: "assistant", providerID: "anthropic", modelID: "sonnet",
      tokens: { input: 30_000, output: 10, cache: { read: 150_000 } } } } } as never);
    await view.finalize();
    const status = async (sessionId: string) => {
      const out: string[] = [];
      await getCommand("status")!.run(baseCtx(state, out, newThreadState(sessionId, "/p"), { pool: { list: () => [] } as never }), "");
      return out.join("\n").split("\n").find((l) => l.startsWith("*Thread:*"))!;
    };
    expect(await status("ses_ctx")).toContain("· verbose=`on` · ctx 90%");
    expect(await status("ses_unknown")).not.toContain("ctx");
  });
});
