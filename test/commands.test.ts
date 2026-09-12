import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { getCommand, allCommands, execute, registerCommand, type CmdCtx } from "../src/commands/registry.js";
import { newThreadState, HELP_SECTIONS } from "../src/commands/handlers.js";
import { StateStore } from "../src/state.js";

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

/**
 * CmdCtx wired to a stubbed OpenCode server that returns a fixture providers map.
 * `cfgModel` = the server's configured default model (GET /config); null = none.
 */
function modelListCtx(out: string[], threadModel?: string, cfgModel: string | null = "anthropic/claude-sonnet-4-5") {
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
    postToThread: async (text: string) => {
      out.push(text);
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

  it("no \\server command (folded into \\status)", () => {
    expect(getCommand("server")).toBeUndefined();
  });

  it("aliases execute their target command", async () => {
    // \projects (aliasOf \project) with no args → the numbered listing
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

  it("\\model bare lists compact provider/model lines, numbered with a TRAILING ★ on current", async () => {
    const out: string[] = [];
    const model = getCommand("model");
    await model!.run(modelListCtx(out, "openai/gpt-5"), "");
    const text = out.join("\n");
    // compact: every model as `provider/model`, numbered for \model <#>;
    // ★ trails the current row's line (never crowds the code span)
    expect(text).toContain("*Models* — current: `openai/gpt-5`");
    expect(text).toContain("1) `anthropic/claude-sonnet-4-5`");
    expect(text).toContain("2) `anthropic/claude-opus-4-1`");
    expect(text).toContain("3) `openai/gpt-5` ★");
    // no verbose decoration
    expect(text).not.toContain("🧠");
    expect(text).not.toContain("∘");
    expect(text).not.toContain("(server default)");
  });

  it("\\model with no thread override resolves and stars the server's configured default", async () => {
    const out: string[] = [];
    await getCommand("model")!.run(modelListCtx(out), "");
    const text = out.join("\n");
    // "(server default)" as a placeholder is dead — resolve the real model
    expect(text).toContain("*Models* — current: `anthropic/claude-sonnet-4-5`");
    expect(text).toContain("1) `anthropic/claude-sonnet-4-5` ★");
    expect(text).toContain("2) `anthropic/claude-opus-4-1`");
    expect(text).not.toContain("(server default)");
  });

  it("\\model resolves the server's real default via live probe when no model is configured", async () => {
    const out: string[] = [];
    await getCommand("model")!.run(modelListCtx(out, undefined, null), "");
    const text = out.join("\n");
    // probe reports openai/gpt-5 (NOT providers[0]'s anthropic default) → live detection
    expect(text).toContain("*Models* — current: `openai/gpt-5`");
    expect(text).toContain("3) `openai/gpt-5` ★");
    expect(text).not.toContain("(server default)");
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
    const home = homedir();
    const target = `${home}/Desktop`; // must exist on this machine
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

    await getCommand("cd")!.run(ctx, "~/Desktop");
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
    const state = new StateStore(`${import.meta.dirname}/.fixtures/project-swap/state.json`);
    state.setCurrentProject("/code/cowork");
    state.touchProject("/code/other-app"); // known project to swap to
    const out: string[] = [];
    const mkCtx = (threadModel?: string) => ({
      channelId: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      thread: threadModel ? ({ ...newThreadState("ses_old", "/code/cowork") } as never) : null,
      state,
      config: null as never,
      cwd: "/code/cowork",
      postToThread: async (t: string) => {
        out.push(t);
      },
      uploadToThread: async () => {},
      pool: {
        list: () => [],
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
    expect(state.currentProjectDir).toBe("/code/other-app");
    expect(state.getThread("C1:T1")?.sessionId).toBe("ses_fresh");
    expect(out.at(-1)).toContain("other-app");

    // bare listing numbers the (non-current) candidates
    out.length = 0;
    await project!.run(mkCtx(), "");
    expect(out.join("\n")).toContain("*Current:* `/code/other-app`");
    expect(out.join("\n")).toContain("1) `cowork`");

    // swap by number (relative to the current listing)
    await project!.run(mkCtx(), "1");
    expect(state.currentProjectDir).toBe("/code/cowork");
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

  it("\\stop with nothing running says so and never touches the server", async () => {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/stop-idle/state.json`);
    state.setThread("C1:T1", newThreadState("s-stop-idle", "/p"));
    let aborted = false;
    const out: string[] = [];
    const ctx = baseCtx(state, out, state.getThread("C1:T1"), {
      pool: { ensure: async () => ({ client: { session: { abort: async () => { aborted = true; return { data: {} }; } } } }) } as never,
    });
    await getCommand("stop")!.run(ctx, "");
    expect(aborted).toBe(false);
    expect(out.join("\n")).toContain("Nothing running");
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
                data: [{ file: "src/x.ts", before: "a\nb\n", after: "a\nB\n", additions: 1, deletions: 1 }],
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
                data: [{ file: "src/big.txt", before: "a".repeat(4000), after: "b".repeat(4000), additions: 1, deletions: 1 }],
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
        killOne: async (dir: string) => {
          calls.push(`killOne:${dir}`);
        },
      } as never,
    });
    await getCommand("restart")!.run(ctx, "");
    expect(calls).toEqual(["killOne:/p", "ensure:/p"]); // kill first, then warm respawn
    expect(out.at(-1)).toContain("restarted");
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
        killOne: async (dir: string) => {
          calls.push(`killOne:${dir}`);
        },
      } as never,
    });
    await getCommand("restart")!.run(ctx, "");
    expect(calls).toEqual(["killOne:/cur", "ensure:/cur"]);
    expect(out.at(-1)).toContain("restarted");
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
