import { afterAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { V2Event } from "@opencode/client";
import { parseBackslash } from "../src/commands/parse.js";
import { getCommand, type CmdCtx } from "../src/commands/registry.js";
import "../src/commands/handlers.js";
import { noteShellEvent, runShell, shellCommandText } from "../src/commands/shell.js";
import { isPreparingWorktree, prepareWorktree, STILL_PREPARING } from "../src/commands/worktrees.js";
import { normalizeMessages, V2Events } from "../src/opencode/v2.js";
import { SessionView, deleteView, type RenderDeps } from "../src/slack/render.js";
import { StateStore, type ThreadState } from "../src/state.js";

const FIXTURES = join(import.meta.dirname, ".fixtures", "shell");
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

const thread = (sessionId: string, extra: Partial<ThreadState> = {}): ThreadState =>
  ({ sessionId, projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1, ...extra });

/**
 * Fake client: `shell` answers by emitting the ended event the way the bridge's
 * event switchboard would (or stays silent to exercise the transcript fallback).
 */
function rig(name: string, opts: { thread?: ThreadState | null; ownerDm?: boolean; result?: Record<string, unknown> | null; rows?: unknown[] } = {}) {
  const state = new StateStore(join(FIXTURES, name, "state.json"));
  if (opts.thread) state.setThread("C1:T1", opts.thread);
  const shell = vi.fn(async ({ sessionID }: { sessionID: string; command: string }) => {
    if (opts.result) noteShellEvent({ phase: "ended", sessionID, status: "exited", truncated: false, ...opts.result });
  });
  const client = {
    v2: { session: { shell }, message: { list: vi.fn(async () => ({ data: opts.rows ?? [] })) } },
    session: { create: vi.fn(async () => ({ data: { id: "ses_new" } })) },
  };
  const entry = { dir: "/p", client };
  const posts: string[] = [];
  const uploads: Array<{ filename: string; content: string | Buffer; comment?: string }> = [];
  const ctx = {
    channelId: "C1", threadTs: "T1", threadKey: "C1:T1", thread: opts.thread === undefined ? null : state.getThread("C1:T1"),
    ownerDm: opts.ownerDm, state, config: null as never, cwd: "/p",
    pool: { ensure: async () => entry, acquire: async () => ({ entry, release: () => {} }) },
    postToThread: async (text: string) => void posts.push(text),
    uploadToThread: async (filename: string, content: string | Buffer, comment?: string) => void uploads.push({ filename, content, comment }),
  } as unknown as CmdCtx;
  return { state, ctx, shell, client, posts, uploads, run: (args: string) => getCommand("!")!.run(ctx, args) };
}

describe("\\! parsing and registration", () => {
  it("parses `\\!` with or without a space, and \\sh is an alias", () => {
    expect(parseBackslash("\\! npm test")).toEqual({ name: "!", args: "npm test" });
    expect(parseBackslash("  \\!git status --short ")).toEqual({ name: "!", args: "git status --short" });
    expect(getCommand("sh")).toBe(getCommand("!"));
    expect(getCommand("!")?.summary).toMatch(/shell command on this machine as your user \(owner-only\)/);
  });

  // Args arrive via slackToPlain: decoded outside code, raw (entity-encoded) inside code.
  it("unwraps a command typed as one code span or fence and decodes its entities exactly once", () => {
    expect(shellCommandText("`npm test`")).toBe("npm test");
    expect(shellCommandText("`ls &amp;&amp; pwd &gt; out.txt`")).toBe("ls && pwd > out.txt");
    expect(shellCommandText("```make &amp;&amp; ls```")).toBe("make && ls");
    expect(shellCommandText("```\ncd src\ngrep -r x . &gt; hits\n```")).toBe("cd src\ngrep -r x . > hits");
    expect(shellCommandText("```bash\necho &amp;lt;tag&amp;gt;\n```")).toBe("echo &lt;tag&gt;"); // &amp; last: one decode
    // Not wholly code: already decoded by slackToPlain, so nothing is decoded again; inner backticks stay.
    expect(shellCommandText("echo &amp;lt; `date`")).toBe("echo &amp;lt; `date`");
    expect(shellCommandText("```a``` &amp;&amp; ```b```")).toBe("```a``` &amp;&amp; ```b```");
    expect(shellCommandText("open [example.com](http://example.com)")).toBe("open example.com");
  });
});

describe("\\! refusals", () => {
  it("refuses while a run is active in the thread, without touching the shell", async () => {
    const r = rig("active", { thread: thread("ses_busy") });
    const view = new SessionView({ sessionId: "ses_busy", projectDir: "/p", channel: "C1", threadTs: "T1", threadKey: "C1:T1",
      client: {} as never, deps: { post: async () => ({ ts: "s1" }), update: async () => {}, delete: async () => {}, react: async () => {} } as unknown as RenderDeps,
      state: r.state, threadState: r.state.getThread("C1:T1")! });
    await view.beginPrompt("1.1");
    try {
      await r.run("npm test");
      expect(r.posts).toEqual(["A run is active — use `\\stop` first."]);
      expect(r.shell).not.toHaveBeenCalled();
    } finally { deleteView("ses_busy"); }
  });

  it("refuses while the thread's worktree is being prepared, without creating a session the bind would orphan", async () => {
    const r = rig("preparing", { thread: null, ownerDm: true, result: { exit: 0, output: "" } });
    let fail!: (err: Error) => void;
    const prep = prepareWorktree({ pool: { ensure: () => new Promise((_, reject) => { fail = reject; }) } as never, state: r.state,
      threadKey: "C1:T1", baseDir: "/p", say: async () => {}, bind: async () => {} });
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    expect(isPreparingWorktree("C1:T1")).toBe(true);
    await r.run("`ls`");
    expect(r.posts).toEqual([STILL_PREPARING]);
    expect(r.client.session.create).not.toHaveBeenCalled();
    expect(r.shell).not.toHaveBeenCalled();
    fail(new Error("down"));
    await expect(prep).rejects.toThrow("down");
  });

  it("refuses in a scheduled-report session", async () => {
    const r = rig("report", { thread: thread("ses_report", { scheduledRunId: "run-1" }) });
    await r.run("rm -rf build");
    expect(r.posts).toEqual(["Scheduled-report threads don't run shell commands."]);
    expect(r.shell).not.toHaveBeenCalled();
  });

  it("an unbound channel thread needs a prompt first; an unbound owner DM gets a fresh session", async () => {
    await expect(rig("unbound", { thread: null }).run("ls")).rejects.toThrow("send a prompt first");
    const dm = rig("unbound-dm", { thread: null, ownerDm: true, result: { exit: 0, output: "a.txt\n" } });
    await dm.run("ls");
    expect(dm.state.getThread("C1:T1")).toMatchObject({ sessionId: "ses_new", projectDir: "/p" });
    expect(dm.shell).toHaveBeenCalledWith({ sessionID: "ses_new", command: "ls" }, expect.anything());
    expect(dm.posts).toEqual(["`$ ls`\n```\na.txt\n```"]);
  });
});

describe("\\! output", () => {
  it("short output posts as a code block with a nonzero exit shown; ANSI colors are stripped", async () => {
    const r = rig("short", { thread: thread("ses_s"), result: { exit: 1, output: "\x1b[31mFAIL\x1b[0m parse.test.ts\n" } });
    await r.run("`npm test`");
    expect(r.shell).toHaveBeenCalledWith({ sessionID: "ses_s", command: "npm test" }, expect.anything());
    expect(r.posts).toEqual(["`$ npm test` · exit 1\n```\nFAIL parse.test.ts\n```"]);
    expect(r.uploads).toEqual([]);
  });

  it("output over 3,500 chars is uploaded as a snippet; exit 0 isn't mentioned", async () => {
    const big = "x".repeat(3_501);
    const r = rig("long", { thread: thread("ses_l"), result: { exit: 0, output: big } });
    await r.run("cat big.log");
    expect(r.posts).toEqual([]);
    expect(r.uploads).toEqual([{ filename: "shell-output.txt", content: big, comment: "`$ cat big.log`" }]);
  });

  it("a lost ended event falls back to the transcript's shell message", async () => {
    const since = Date.now();
    const r = rig("fallback", { thread: thread("ses_f"), rows: [
      { type: "shell", id: "msg_old", command: "make", status: "exited", exit: 0, time: { created: since - 60_000 }, output: { output: "stale", cursor: 0, size: 5, truncated: false } },
      { type: "shell", id: "msg_new", command: "make", status: "timeout", time: { created: since + 5 }, output: { output: "partial", cursor: 0, size: 7, truncated: true } },
    ] });
    const result = await runShell(r.client as never, "ses_f", "make", { pollMs: 1 });
    expect(result).toEqual({ status: "timeout", exit: undefined, output: "partial", truncated: true });
  });
});

describe("shell events and the finalize backstop", () => {
  it("translates session.shell.started/ended (output and exit live on the ended event)", () => {
    const events = new V2Events();
    const shell = { id: "sh_1", status: "exited", command: "git status", cwd: "/p", shell: "zsh", file: "", exit: 2, metadata: {}, time: { started: 1, completed: 2 } };
    expect(events.translate({ type: "session.shell.started", data: { sessionID: "s", shell: { ...shell, status: "running", exit: undefined } } } as V2Event))
      .toEqual([{ type: "session.shell", properties: { sessionID: "s", phase: "started", shellID: "sh_1", command: "git status" } }]);
    expect(events.translate({ type: "session.shell.ended", data: { sessionID: "s", shell,
      output: { output: "fatal: not a repo", cursor: 17, size: 17, truncated: false } } } as V2Event))
      .toEqual([{ type: "session.shell", properties: { sessionID: "s", phase: "ended", shellID: "sh_1", command: "git status",
        status: "exited", exit: 2, output: "fatal: not a repo", truncated: false } }]);
  });

  it("finalize's backstop posts a missed assistant answer but never the shell output already posted by \\!", async () => {
    const state = new StateStore(join(FIXTURES, "backstop", "state.json"));
    const now = Date.now();
    const raw = [
      { type: "user", id: "msg_u", time: { created: now }, text: "why did it fail?" },
      { type: "shell", id: "msg_sh", shellID: "sh_1", command: "npm test", status: "exited", exit: 1, time: { created: now, completed: now },
        output: { output: "SHELL-OUTPUT", cursor: 12, size: 12, truncated: false } },
      { type: "assistant", id: "msg_a", time: { created: now, completed: now }, model: { id: "m", providerID: "p" },
        content: [{ type: "text", text: "the parser test fails" }] },
    ];
    const client = { session: { messages: async ({ path }: { path: { id: string } }) => normalizeMessages(raw as never, path.id) } };
    const posted: string[] = [];
    const deps = { post: async (_c: string, _t: string, text: string) => { posted.push(text); return { ts: `p${posted.length}` }; },
      update: async () => {}, delete: async () => {}, react: async () => {}, unreact: async () => {} } as unknown as RenderDeps;
    const view = new SessionView({ sessionId: "ses_bs", projectDir: "/p", channel: "C1", threadTs: "T1", threadKey: "C1:T1",
      client: client as never, deps, state, threadState: thread("ses_bs", { verbose: "off" }) });
    await view.beginPrompt("1.2");
    await view.finalize();
    deleteView("ses_bs");
    expect(posted.some((p) => p.includes("the parser test fails"))).toBe(true);
    expect(posted.some((p) => p.includes("SHELL-OUTPUT"))).toBe(false);
  });
});
