import { describe, expect, it, vi } from "vitest";
import {
  SessionView,
  deleteView,
  describeActiveRuns,
  errorMessage,
  finalizeViewsForProject,
  getView,
  hasActiveViewForProject,
  reconcileStaleViews,
  type RenderDeps,
} from "../src/slack/render.js";
import { StateStore } from "../src/state.js";
import type { OCClient } from "../src/opencode/api.js";

interface CallLog {
  posted: string[];
  /** opts?.unfurl per post, index-aligned with `posted` (undefined = default). */
  unfurls: Array<boolean | undefined>;
  updates: string[];
  deleted: string[];
  reacted: Array<[string, string]>;
  unreacted: Array<[string, string]>;
  uploads: Array<{ filename: string; content?: string; file?: Buffer; comment?: string }>;
  dms: string[];
  /** blocks payload per DM (undefined when the DM was plain text) — index-aligned with `dms`. */
  dmBlocks: Array<unknown[] | undefined>;
}

function fakeDeps(log: CallLog): RenderDeps {
  let n = 0;
  return {
    post: async (_c, _t, text, _blocks, opts) => {
      log.posted.push(text);
      log.unfurls.push(opts?.unfurl);
      return { ts: `status-${++n}` };
    },
    update: async (_c, ts, text) => void log.updates.push(`${ts}:${text}`),
    delete: async (_c, ts) => void log.deleted.push(ts),
    react: async (_c, ts, name) => void log.reacted.push([ts, name]),
    unreact: async (_c, ts, name) => void log.unreacted.push([ts, name]),
    upload: async (o) => void log.uploads.push(o),
    dm: async (_c, _t, text, blocks) => {
      log.dms.push(text);
      log.dmBlocks.push(blocks);
      return { ts: "dm-1" };
    },
  };
}

/** Stub OCClient: summary fetch fails quietly; session.messages is configurable. */
function stubClient(messages: Array<{ info: { role: string; id?: string; time?: { created: number } }; parts: Array<{ id: string; type: string; text?: string }> }> = []): OCClient {
  return {
    session: {
      get: async () => {
        throw new Error("no summary in tests");
      },
      messages: async () => ({ data: messages }),
    },
  } as never;
}

interface ViewOpts {
  verbose?: "off" | "on" | "full";
  client?: OCClient;
  statusTs?: string;
}

function makeView(log: CallLog, sessionId: string, opts: ViewOpts = {}): SessionView {
  const state = new StateStore(`${import.meta.dirname}/.fixtures/render-${sessionId}/state.json`);
  return new SessionView({
    sessionId,
    projectDir: "/p",
    channel: "C1",
    threadTs: "T1",
    threadKey: "C1:T1",
    client: opts.client ?? ({} as never),
    deps: fakeDeps(log),
    state,
    threadState: { sessionId, projectDir: "/p", verbose: opts.verbose ?? "off", createdAt: 1, lastUsedAt: 1 },
    statusTs: opts.statusTs,
  });
}

function blank(): CallLog {
  return { posted: [], unfurls: [], updates: [], deleted: [], reacted: [], unreacted: [], uploads: [], dms: [], dmBlocks: [] };
}

describe("errorMessage (session.error wire shape)", () => {
  it("passes strings through", () => {
    expect(errorMessage("boom")).toBe("boom");
  });

  it("extracts the message from the OpenCode error object (was rendering [object Object])", () => {
    expect(errorMessage({ name: "ProviderAuthError", data: { message: "invalid api key" } })).toBe("invalid api key");
    expect(errorMessage({ name: "UnknownError", message: "socket exploded" })).toBe("socket exploded");
    expect(errorMessage({ name: "ProviderAuthError" })).toBe("ProviderAuthError");
  });

  it("falls back for empty/degenerate values", () => {
    expect(errorMessage(undefined)).toBe("unknown session error");
    expect(errorMessage(null)).toBe("unknown session error");
    expect(errorMessage("")).toBe("unknown session error");
    expect(errorMessage({})).toBe("unknown session error");
    expect(errorMessage(42)).toBe("unknown session error");
  });
});

describe("SessionView reactions (user-mandated UX)", () => {
  it("beginPrompt posts the working status and reacts nothing (no hourglass)", async () => {
    const log = blank();
    const v = makeView(log, "sess-react-a");
    await v.beginPrompt("111.222");
    expect(log.reacted).toEqual([]);
    expect(log.unreacted).toEqual([]);
    expect(log.posted.some((p) => p.includes("OpenCode is on it"))).toBe(true);
    deleteView("sess-react-a");
  });

  it("on success: ✅ on the user message, status message deleted, NO 'Done' text", async () => {
    const log = blank();
    const v = makeView(log, "sess-react-b");
    await v.beginPrompt("111.333");
    await v.finalize();
    expect(log.unreacted).toEqual([["111.333", "eyes"]]);
    expect(log.reacted).toEqual([["111.333", "white_check_mark"]]);
    expect(log.deleted.length).toBe(1); // the live status message
    const everything = [...log.posted, ...log.updates].join("\n").toLowerCase();
    expect(everything).not.toMatch(/done/);
    deleteView("sess-react-b");
  });

  it("on error: ❌ and an error line is posted (not a green check)", async () => {
    const log = blank();
    const v = makeView(log, "sess-react-c");
    await v.beginPrompt("111.444");
    await v.finalize("provider blew up");
    expect(log.reacted).toEqual([["111.444", "x"]]);
    expect(log.posted.some((p) => p.includes("provider blew up"))).toBe(true);
    deleteView("sess-react-c");
  });

  it("resolves ✅ for every pending message across back-to-back prompts", async () => {
    const log = blank();
    const v = makeView(log, "sess-react-d");
    await v.beginPrompt("111.001");
    await v.beginPrompt("111.002");
    await v.finalize();
    expect(log.reacted).toEqual([
      ["111.001", "white_check_mark"],
      ["111.002", "white_check_mark"],
    ]);
    deleteView("sess-react-d");
  });

  it("retargetSession re-keys the registry so the lifecycle survives a rebind", () => {
    const log = blank();
    const v = makeView(log, "sess-react-e");
    expect(getView("sess-react-e")).toBe(v);
    v.retargetSession("sess-react-f");
    expect(getView("sess-react-f")).toBe(v);
    expect(getView("sess-react-e")).toBeUndefined();
    deleteView("sess-react-f");
  });
});

// Tool lines are batched: they stay buffered until a section flip / buffer
// pressure / finalize flushes them as ONE message (fewer Slack posts). Most
// assertions therefore fire after v.finalize() — posted[0] is the tools
// message; the finalize summary line lands afterwards.
describe("SessionView tool lines (compact, icon-prefixed)", () => {
  it("posts a divider once, then bash renders as `🔧 <command>`", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-a", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t1", type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "npm test" } } } },
    } as never);
    expect(log.posted).toEqual([]); // buffered until flush
    await v.finalize();
    // divider + first tool line travel as ONE atomic message
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 npm test");
    deleteView("sess-tool-a");
  });

  it("edit renders as `✏️ edit <path>` after the one-time divider", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-b", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t2", type: "tool", tool: "edit", callID: "c2", state: { status: "running", input: { filePath: "/a/b/src/x.ts" } } } },
    } as never);
    await v.finalize();
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\n✏️ edit /a/b/src/x.ts");
    deleteView("sess-tool-b");
  });

  it("pending line (no input yet) is skipped; running posts the real target once", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-c", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t3", type: "tool", tool: "grep", callID: "c3", state: { status: "pending", input: {} } } },
    } as never);
    expect(log.posted).toEqual([]); // pending has no target — not posted
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t3", type: "tool", tool: "grep", callID: "c3", state: { status: "running", input: { pattern: "foo" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t3", type: "tool", tool: "grep", callID: "c3", state: { status: "running", input: { pattern: "foo" } } } },
    } as never);
    await v.finalize();
    expect(log.posted.filter((p) => p.includes('🔍 grep "foo"')).length).toBe(1); // exactly one tool line
    deleteView("sess-tool-c");
  });

  it("uses OpenCode's state.title verbatim once present (read tool)", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-d", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t4", type: "tool", tool: "read", callID: "c4", state: { status: "running", input: { filePath: "/big/repo/src/main.ts" }, title: "Read /big/repo/src/main.ts" } } },
    } as never);
    await v.finalize();
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\nRead /big/repo/src/main.ts");
    deleteView("sess-tool-d");
  });

  it("long bash commands are squeezed to ≤60 chars", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-g", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t8", type: "tool", tool: "bash", callID: "c8", state: { status: "running", input: { command: `echo ${"x".repeat(100)}` } } } },
    } as never);
    await v.finalize();
    expect(log.posted[0]).toBe(`⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 echo ${"x".repeat(54)}…`);
    deleteView("sess-tool-g");
  });

  it("multiline bash commands render only their first line", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-h", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t9", type: "tool", tool: "bash", callID: "c9", state: { status: "running", input: { command: "git commit -m 'wip'\n\nlong body continues here\nand here" } } } },
    } as never);
    await v.finalize();
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 git commit -m 'wip'");
    deleteView("sess-tool-h");
  });

  it("long state.title is squeezed to one short line", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-i", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t10", type: "tool", tool: "custom", callID: "c10", state: { status: "running", input: {}, title: `Read /big/repo/src/very/deeply/nested/path/${"f".repeat(60)}.ts` } } },
    } as never);
    await v.finalize();
    const line = (log.posted[0] ?? "").split("\n").pop() ?? "";
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line.startsWith("Read /big/repo/src/very/deeply/nested/p")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    deleteView("sess-tool-i");
  });

  it("unknown tools render with the generic 🔧 icon", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-e", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t5", type: "tool", tool: "mcp exotic", callID: "c5", state: { status: "running", input: {} } } },
    } as never);
    await v.finalize();
    expect(log.posted[0]?.split("\n").pop()).toMatch(/^🔧 /);
    deleteView("sess-tool-e");
  });

  it("file tool paths are shown relative to the session's project dir", async () => {
    const log = blank();
    const state = new StateStore(`${import.meta.dirname}/.fixtures/render-sess-tool-f/state.json`);
    const v = new SessionView({
      sessionId: "sess-tool-f",
      projectDir: "/Users/me/SlackOC",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: {} as never,
      deps: fakeDeps(log),
      state,
      threadState: { sessionId: "sess-tool-f", projectDir: "/Users/me/SlackOC", verbose: "on", createdAt: 1, lastUsedAt: 1 },
    });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t6", type: "tool", tool: "read", callID: "c6", state: { status: "running", input: { filePath: "/Users/me/SlackOC/src/state.ts" } } } },
    } as never);
    // Outside the project dir → absolute path kept as-is. Both runs flush
    // (batched) into one tools message at finalize.
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "t7", type: "tool", tool: "read", callID: "c7", state: { status: "running", input: { filePath: "/etc/hosts" } } } },
    } as never);
    await v.finalize();
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\n📄 read src/state.ts\n📄 read /etc/hosts");
    deleteView("sess-tool-f");
  });

  it("consecutive tool lines batch into one message (no per-call posts)", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-batch", { verbose: "on" });
    for (const [id, cmd] of [["b1", "ls"], ["b2", "pwd"]] as const) {
      await v.handle({
        type: "message.part.updated",
        properties: { part: { id, type: "tool", tool: "bash", callID: id, state: { status: "running", input: { command: cmd } } } },
      } as never);
    }
    expect(log.posted).toEqual([]); // still buffered
    await v.finalize();
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 ls\n🔧 pwd");
    deleteView("sess-tool-batch");
  });

  it("flushes mid-run under buffer pressure (8 lines)", async () => {
    const log = blank();
    const v = makeView(log, "sess-tool-cap", { verbose: "on" });
    for (let i = 1; i <= 8; i++) {
      await v.handle({
        type: "message.part.updated",
        properties: { part: { id: `cap${i}`, type: "tool", tool: "bash", callID: `cap${i}`, state: { status: "running", input: { command: `echo ${i}` } } } },
      } as never);
    }
    // 8th buffered line triggers a flush — no finalize yet.
    expect(log.posted.length).toBe(1);
    expect(log.posted[0]).toContain("🔧 echo 8");
    deleteView("sess-tool-cap");
  });
});

describe("SessionView section dividers", () => {
  it("posts ⎯ tools ⎯ before the first tool line and ⎯ response ⎯ before the first response text", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-a", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d1", type: "tool", tool: "bash", callID: "d1c", state: { status: "running", input: { command: "ls" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d2", messageID: "dm", type: "text", text: "here is the result", time: { end: 1 } } },
    } as never);
    // dividers ride with their first line — atomic
    expect(log.posted).toEqual(["⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 ls", "⎯⎯⎯ response ⎯⎯⎯\n\nhere is the result"]);
    deleteView("sess-div-a");
  });

  it("response with NO tools above gets no divider (nothing to separate)", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-b", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d3", messageID: "dm", type: "text", text: "part one", time: { end: 1 } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d4", messageID: "dm", type: "text", text: "part two", time: { end: 2 } } },
    } as never);
    expect(log.posted).toEqual(["part one", "part two"]);
    deleteView("sess-div-b");
  });

  it("text after text (no tools between) still posts no divider", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-b2", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d6", messageID: "dm", type: "text", text: "intro", time: { end: 1 } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d7", type: "tool", tool: "bash", callID: "d7c", state: { status: "running", input: { command: "ls" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d8", messageID: "dm", type: "text", text: "outro", time: { end: 3 } } },
    } as never);
    // Only separators between actual section flips — intro is bare, the
    // tools divider precedes the tool, and outro gets its response divider.
    expect(log.posted).toEqual(["intro", "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 ls", "⎯⎯⎯ response ⎯⎯⎯\n\noutro"]);
    deleteView("sess-div-b2");
  });

  it("interleaved text/tool streams re-post dividers on every section flip", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-d", { verbose: "on" });
    // text → tool → text → tool → text: three response sections, two tools.
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "i1", messageID: "im", type: "text", text: "first analysis", time: { end: 1 } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "i2", type: "tool", tool: "bash", callID: "i2c", state: { status: "running", input: { command: "ls" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "i3", messageID: "im", type: "text", text: "middle thoughts", time: { end: 2 } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "i4", type: "tool", tool: "bash", callID: "i4c", state: { status: "running", input: { command: "pwd" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "i5", messageID: "im", type: "text", text: "final answer", time: { end: 3 } } },
    } as never);
    // text → tool → text → tool → text: the FIRST text is bare (nothing to
    // separate yet); every later flip gets its divider.
    expect(log.posted).toEqual([
      "first analysis",
      "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 ls",
      "⎯⎯⎯ response ⎯⎯⎯\n\nmiddle thoughts",
      "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 pwd",
      "⎯⎯⎯ response ⎯⎯⎯\n\nfinal answer",
    ]);
    deleteView("sess-div-d");
  });

  it("verbose=off posts no dividers at all", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-c", { verbose: "off" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "d5", messageID: "dm", type: "text", text: "quiet answer", time: { end: 1 } } },
    } as never);
    expect(log.posted).toEqual(["quiet answer"]);
    deleteView("sess-div-c");
  });

  it("reasoning parts never post content or mint a response divider", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-e", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "r1", messageID: "rm", type: "reasoning", text: "chain of thought…", time: { end: 1 } } },
    } as never);
    expect(log.posted).toEqual([]);
    deleteView("sess-div-e");
  });

  it("whitespace-only text posts nothing — no dangling response divider", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-f", { verbose: "on" });
    await v.postThreadText("   \n\t  ");
    expect(log.posted).toEqual([]);
    deleteView("sess-div-f");
  });

  it("model file parts (images) upload inline; no divider when no tools ran above", async () => {
    const log = blank();
    const v = makeView(log, "sess-div-g", { verbose: "on" });
    await v.handle({
      type: "message.part.updated",
      properties: {
        part: { id: "f1", messageID: "fm", type: "file", mime: "image/png", filename: "chart.png", url: "data:image/png;base64,aXBobw==" },
      },
    } as never);
    expect(log.posted).toEqual([]);
    expect(log.uploads.length).toBe(1);
    expect(log.uploads[0]?.filename).toBe("chart.png");
    expect(Buffer.from(log.uploads[0]?.file ?? Buffer.alloc(0)).toString()).toBe("ipho");
    // Duplicate delivery is deduped.
    await v.handle({
      type: "message.part.updated",
      properties: {
        part: { id: "f1", messageID: "fm", type: "file", mime: "image/png", filename: "chart.png", url: "data:image/png;base64,aXBobw==" },
      },
    } as never);
    expect(log.uploads.length).toBe(1);
    // But after tools ran, an image DOES get the response divider.
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "f2", type: "tool", tool: "bash", callID: "f2c", state: { status: "running", input: { command: "ls" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: {
        part: { id: "f3", messageID: "fm", type: "file", mime: "image/png", filename: "chart2.png", url: "data:image/png;base64,aXBobw==" },
      },
    } as never);
    expect(log.posted).toEqual(["⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 ls", "⎯⎯⎯ response ⎯⎯⎯"]);
    expect(log.uploads.length).toBe(2);
    deleteView("sess-div-g");
  });
});

describe("SessionView event serialization (ordering race)", () => {
  it("processes concurrently-fired handle() calls in arrival order", async () => {
    const log = blank();
    const v = makeView(log, "sess-race-a", { verbose: "on" });
    // Fire three events WITHOUT awaiting each — the shape that used to let
    // posts enqueue out of order (dividers/answers interleaved wrong).
    const runs = [
      v.handle({
        type: "message.part.updated",
        properties: { part: { id: "z1", type: "tool", tool: "bash", callID: "z1c", state: { status: "running", input: { command: "ls" } } } },
      } as never),
      v.handle({
        type: "message.part.updated",
        properties: { part: { id: "z2", messageID: "zm", type: "text", text: "answer text", time: { end: 1 } } },
      } as never),
      v.handle({
        type: "message.part.updated",
        properties: { part: { id: "z3", type: "tool", tool: "bash", callID: "z3c", state: { status: "running", input: { command: "pwd" } } } },
      } as never),
    ];
    await Promise.all(runs);
    await v.finalize(); // flushes the last buffered tool line
    // Tool → text → tool arrived in that order; posts must land in it too
    // (tool lines batch, so the trailing one lands on the finalize flush).
    expect(log.posted.slice(0, 3)).toEqual([
      "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 ls",
      "⎯⎯⎯ response ⎯⎯⎯\n\nanswer text",
      "⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 pwd",
    ]);
    deleteView("sess-race-a");
  });

  it("finalize() called from outside the chain still serializes behind pending events", async () => {
    const log = blank();
    const client = stubClient([
      {
        info: { role: "assistant", id: "m1", time: { created: Date.now() } },
        parts: [{ id: "p-x", type: "text", text: "backstop answer" }],
      },
    ]);
    const v = makeView(log, "sess-race-b", { client, verbose: "on" });
    const pending = v.handle({
      type: "message.part.updated",
      properties: { part: { id: "z9", type: "tool", tool: "bash", callID: "z9c", state: { status: "running", input: { command: "sleep" } } } },
    } as never);
    // finalize fires while the tool event render is still queued.
    await v.finalize();
    await pending;
    expect(log.posted[0]).toBe("⎯⎯⎯ tools ⎯⎯⎯\n\n🔧 sleep"); // tool line first, backstop after
    expect(log.posted).toContain("⎯⎯⎯ response ⎯⎯⎯\n\nbackstop answer");
    deleteView("sess-race-b");
  });
});

describe("SessionView status line", () => {
  it("keeps the hourglass + activity only (no tools-mode marker up top)", async () => {
    const log = blank();
    const v = makeView(log, "sess-status-a", { verbose: "on" });
    await v.beginPrompt("111.700");
    await v.handle({ type: "message.part.updated", properties: { part: { id: "s1", messageID: "m1", type: "step-start" } } } as never);
    await new Promise((r) => setTimeout(r, 1300)); // let the 1s status ticker fire
    expect(log.updates.at(-1)).toMatch(/:hourglass(_flowing_sand)?:/);
    expect(log.updates.at(-1)).toContain("thinking…");
    expect(log.updates.at(-1)).not.toContain("Tools");
    deleteView("sess-status-a");
  });
});

describe("SessionView live-status ticker (1s, alternating ⏳⌛)", () => {
  it("re-renders the status every second with alternating hourglasses and ticking elapsed", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-tick-a", { verbose: "on" });
      await v.beginPrompt("111.t1");
      expect(log.updates).toEqual([]); // nothing fires before the first beat
      await vi.advanceTimersByTimeAsync(3_200);
      expect(log.updates.length).toBe(3);
      expect(log.updates[0]).toContain(":hourglass_flowing_sand:");
      expect(log.updates[0]).not.toContain(":hourglass: ");
      expect(log.updates[1]).toContain(":hourglass: ");
      expect(log.updates[2]).toContain(":hourglass_flowing_sand:");
      // Elapsed time ticks along with the beats.
      expect(log.updates[0]).toContain("(1s)");
      expect(log.updates[1]).toContain("(2s)");
      expect(log.updates[2]).toContain("(3s)");
      deleteView("sess-tick-a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("after a stall nudge the ticker keeps a distinct stall line alive (no clobber)", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-tick-b", { verbose: "on" });
      await v.beginPrompt("111.t2");
      await vi.advanceTimersByTimeAsync(180_000); // watchdog nudge lands
      await vi.advanceTimersByTimeAsync(2_000);
      const last = log.updates.at(-1)!;
      expect(last).toMatch(/still working… \(3m \ds\)/);
      expect(last).toContain("`\\stop` to cancel");
      expect(last).not.toContain("no updates for 3m"); // the nudge's wording stays unique
      deleteView("sess-tick-b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("any event drops the stall line back to the normal activity text", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-tick-c", { verbose: "on" });
      await v.beginPrompt("111.t3");
      await vi.advanceTimersByTimeAsync(183_000); // stalled
      expect(log.updates.at(-1)).toContain("still working…");
      await v.handle({ type: "session.status", properties: { status: { type: "busy" } } } as never);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(log.updates.at(-1)).toContain("working…");
      expect(log.updates.at(-1)).not.toContain("still working…");
      deleteView("sess-tick-c");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces beats behind a stuck Slack call instead of piling up", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const deps = fakeDeps(log);
      const resolvers: Array<() => void> = [];
      deps.update = () => new Promise<void>((r) => resolvers.push(r));
      const state = new StateStore(`${import.meta.dirname}/.fixtures/render-sess-tick-d/state.json`);
      const v = new SessionView({
        sessionId: "sess-tick-d",
        projectDir: "/p",
        channel: "C1",
        threadTs: "T1",
        threadKey: "C1:T1",
        client: {} as never,
        deps,
        state,
        threadState: { sessionId: "sess-tick-d", projectDir: "/p", verbose: "on" as const, createdAt: 1, lastUsedAt: 1 },
      });
      await v.beginPrompt("111.t4");
      await vi.advanceTimersByTimeAsync(5_200);
      expect(log.updates.length).toBe(0); // held behind the first stuck call
      expect(resolvers.length).toBe(1); // exactly one update in flight — no pileup
      resolvers.forEach((r) => r());
      await vi.advanceTimersByTimeAsync(2_200);
      expect(resolvers.length).toBe(2); // beat resumes once the pipe frees up
      resolvers.forEach((r) => r());
      await v.finalize();
      deleteView("sess-tick-d");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionView finalize summary", () => {
  it("ends with the tools-visibility marker, rightmost (no 'N tool call(s)')", async () => {
    const log = blank();
    const v = makeView(log, "sess-sum-c", { verbose: "on" });
    await v.handle({
      type: "message.updated",
      properties: { info: { id: "m9", role: "assistant", tokens: { input: 100, output: 10 } } },
    } as never);
    await v.finalize();
    const line = log.posted.at(-1)!;
    expect(line.includes("tool call(s)")).toBe(false);
    expect(line.endsWith("Verbose Tools")).toBe(true);
    deleteView("sess-sum-c");
  });

  it("says Silent Tools for verbose=off runs (with project name + duration)", async () => {
    const log = blank();
    const v = makeView(log, "sess-sum-d", { verbose: "off" });
    await v.finalize();
    // project name leads · duration · marker trails
    expect(log.posted.at(-1)).toMatch(/^\*p\* · \S+ · Silent Tools$/);
    deleteView("sess-sum-d");
  });
});

describe("SessionView answer delivery backstop", () => {
  it("posts assistant text the SSE stream never delivered", async () => {
    const log = blank();
    const client = stubClient([
      {
        info: { role: "assistant", id: "m1", time: { created: Date.now() } },
        parts: [{ id: "p-lost", type: "text", text: "the lost answer" }],
      },
      {
        info: { role: "user", id: "mu" },
        parts: [{ id: "p-user", type: "text", text: "the user echo must not post" }],
      },
    ]);
    const v = makeView(log, "sess-backstop-a", { client });
    await v.beginPrompt("111.500");
    await v.finalize();
    expect(log.posted).toContain("the lost answer");
    expect(log.posted.some((p) => p.includes("user echo"))).toBe(false);
    deleteView("sess-backstop-a");
  });

  it("does not duplicate parts already delivered over SSE", async () => {
    const log = blank();
    const client = stubClient([
      {
        info: { role: "assistant", id: "m1", time: { created: Date.now() } },
        parts: [{ id: "p-live", type: "text", text: "streamed answer" }],
      },
    ]);
    const v = makeView(log, "sess-backstop-b", { client });
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "p-live", messageID: "m-live", type: "text", text: "streamed answer", time: { end: 1 } } },
    } as never);
    await v.finalize();
    expect(log.posted.filter((p) => p === "streamed answer").length).toBe(1);
    deleteView("sess-backstop-b");
  });

  it("never backstops responses from PREVIOUS prompts in the session", async () => {
    const log = blank();
    const client = stubClient([
      {
        info: { role: "assistant", id: "m-old", time: { created: Date.now() - 60_000 } },
        parts: [{ id: "p-old", type: "text", text: "previous turn's response" }],
      },
      {
        info: { role: "assistant", id: "m-new", time: { created: Date.now() } },
        parts: [{ id: "p-new", type: "text", text: "this turn's response" }],
      },
    ]);
    const v = makeView(log, "sess-backstop-c", { client });
    await v.beginPrompt("111.600"); // starts the run window
    await v.finalize();
    expect(log.posted).toContain("this turn's response");
    expect(log.posted.some((p) => p.includes("previous turn"))).toBe(false);
    deleteView("sess-backstop-c");
  });
});

describe("SessionView finalize summary", () => {
  it("includes the model that actually ran alongside cost/tokens", async () => {
    const log = blank();
    const v = makeView(log, "sess-sum-a");
    await v.handle({
      type: "message.updated",
      properties: {
        info: { id: "m1", role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5", cost: 0.041, tokens: { input: 12_000, output: 2_000 } },
      },
    } as never);
    await v.finalize();
    const line = log.posted.find((p) => p.includes("$0.041"));
    expect(line).toBeDefined();
    expect(line).toContain("anthropic/claude-sonnet-4-5");
    expect(line).toContain("12.0k↑/2.0k↓");
    deleteView("sess-sum-a");
  });
});

describe("SessionView unfurl suppression (previews kept in answers only)", () => {
  it("tool lines, status, and the summary suppress unfurls; answer text does not", async () => {
    const log = blank();
    const v = makeView(log, "sess-unfurl-a", { verbose: "on" });
    await v.beginPrompt("111.800"); // status post
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "u1", type: "tool", tool: "webfetch", callID: "u1c", state: { status: "running", input: { url: "https://example.com" } } } },
    } as never);
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "u2", messageID: "um", type: "text", text: "see https://example.com for more", time: { end: 1 } } },
    } as never);
    await v.finalize();
    // status post: unfurl off
    expect(log.posted[0]).toContain("OpenCode is on it");
    expect(log.unfurls[0]).toBe(false);
    // tool line (rides with the tools divider): unfurl off
    expect(log.unfurls[1]).toBe(false);
    // answer text: previews kept (undefined → Slack default)
    expect(log.unfurls[2]).toBeUndefined();
    // finalize summary: unfurl off
    expect(log.unfurls.at(-1)).toBe(false);
    deleteView("sess-unfurl-a");
  });
});

describe("SessionView queued-prompt ack", () => {
  it("a second prompt mid-run posts one queued ack; fresh runs don't", async () => {
    const log = blank();
    const v = makeView(log, "sess-queue-a", { verbose: "on" });
    await v.beginPrompt("111.900");
    expect(log.posted.some((p) => p.includes("Queued"))).toBe(false); // first prompt: no ack
    await v.beginPrompt("111.901");
    expect(log.posted.filter((p) => p.includes("Queued")).length).toBe(1);
    deleteView("sess-queue-a");
  });

  it("after finalize, a new run gets no queued ack (active reset)", async () => {
    const log = blank();
    const v = makeView(log, "sess-queue-b", { verbose: "on" });
    await v.beginPrompt("111.910");
    await v.finalize();
    // Router creates a NEW view after finalize — but even a stray re-begin
    // on a finalized/reset view must not ack.
    expect(log.posted.filter((p) => p.includes("Queued")).length).toBe(0);
    deleteView("sess-queue-b");
  });
});

describe("SessionView stalled-run watchdog (3 min)", () => {
  it("nudges the status line after 3 silent minutes, re-arms, and clears on finalize", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-watch-a", { verbose: "on" });
      await v.beginPrompt("111.920");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(log.updates.filter((u) => u.includes("no updates for 3m")).length).toBe(1);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(log.updates.filter((u) => u.includes("no updates for 3m")).length).toBe(2); // re-armed once
      await v.finalize();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(log.updates.filter((u) => u.includes("no updates for 3m")).length).toBe(2); // timer cleared
      deleteView("sess-watch-a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("any event resets the 3-minute window (no nudge for active runs)", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-watch-b", { verbose: "on" });
      await v.beginPrompt("111.930");
      await vi.advanceTimersByTimeAsync(170_000);
      await v.handle({
        type: "message.part.updated",
        properties: { part: { id: "w1", messageID: "wm", type: "text", text: "still streaming", time: { end: 1 } } },
      } as never);
      await vi.advanceTimersByTimeAsync(179_000); // 179s since the event — under the window
      expect(log.updates.some((u) => u.includes("no updates for 3m"))).toBe(false);
      deleteView("sess-watch-b");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionView adopted status (cold-start ack)", () => {
  it("a pre-posted statusTs is adopted: no repost, finalize still deletes it", async () => {
    const log = blank();
    const v = makeView(log, "sess-adopt-a", { statusTs: "pre-acked" });
    await v.beginPrompt("111.940");
    expect(log.posted).toEqual([]); // nothing re-posted
    await v.finalize();
    expect(log.deleted).toEqual(["pre-acked"]);
    deleteView("sess-adopt-a");
  });
});

describe("SessionView pendingRun tombstone (interrupt sweep)", () => {
  function seededView(log: CallLog, sessionId: string, extra: object = {}) {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/render-${sessionId}/state.json`);
    const thread = { sessionId, projectDir: "/p", verbose: "on" as const, createdAt: 1, lastUsedAt: 1, ...extra };
    state.setThread("C1:T1", thread);
    const v = new SessionView({
      sessionId,
      projectDir: "/p",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: {} as never,
      deps: fakeDeps(log),
      state,
      threadState: thread,
    });
    return { state, v };
  }

  it("beginPrompt persists { userMsgTs, statusTs }; finalize clears it", async () => {
    const log = blank();
    const { state, v } = seededView(log, "sess-pr-a");
    await v.beginPrompt("111.950");
    const pr = state.getThread("C1:T1")?.pendingRun;
    expect(pr?.userMsgTs).toEqual(["111.950"]);
    expect(typeof pr?.statusTs).toBe("string"); // the live-status message ts is recorded
    await v.finalize();
    expect(state.getThread("C1:T1")?.pendingRun).toBeUndefined();
    deleteView("sess-pr-a");
  });

  it("back-to-back prompts accumulate userMsgTs without duplicates", async () => {
    const log = blank();
    const { state, v } = seededView(log, "sess-pr-b");
    await v.beginPrompt("111.960");
    await v.beginPrompt("111.961");
    await v.beginPrompt("111.961");
    expect(state.getThread("C1:T1")?.pendingRun?.userMsgTs).toEqual(["111.960", "111.961"]);
    deleteView("sess-pr-b");
  });
});

describe("SessionView event pipeline errors surface visibly", () => {
  it("a render throw finalizes the run with ❌ + an error line (no silent hang)", async () => {
    const log = blank();
    const deps = fakeDeps(log);
    const origPost = deps.post;
    deps.post = async (c, t, text, blocks, opts) => {
      if (text === "boom text") throw new Error("kaboom");
      return origPost(c, t, text, blocks, opts);
    };
    const state = new StateStore(`${import.meta.dirname}/.fixtures/render-sess-err/state.json`);
    const v = new SessionView({
      sessionId: "sess-err",
      projectDir: "/p",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: {} as never,
      deps,
      state,
      threadState: { sessionId: "sess-err", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 },
    });
    await v.beginPrompt("111.970");
    await v.handle({
      type: "message.part.updated",
      properties: { part: { id: "e1", messageID: "em", type: "text", text: "boom text", time: { end: 1 } } },
    } as never);
    await v.finalize(); // chains the error-finalize to completion
    expect(log.reacted).toEqual([["111.970", "x"]]);
    expect(log.posted.some((p) => p.includes("event pipeline error") && p.includes("kaboom"))).toBe(true);
    expect(log.posted.some((p) => p.includes("boom text"))).toBe(false);
    deleteView("sess-err");
  });
});

describe("SessionView owner DMs (remote pager)", () => {
  function dmSeededView(log: CallLog, sessionId: string, notify: boolean) {
    const state = new StateStore(`${import.meta.dirname}/.fixtures/render-${sessionId}/state.json`);
    const thread = { sessionId, projectDir: "/p", verbose: "on" as const, createdAt: 1, lastUsedAt: 1, notify };
    state.setThread("C1:T1", thread);
    return new SessionView({
      sessionId,
      projectDir: "/p",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: {} as never,
      deps: fakeDeps(log),
      state,
      threadState: thread,
    });
  }

  it("failures always DM the owner", async () => {
    const log = blank();
    const v = dmSeededView(log, "sess-dm-a", false);
    await v.beginPrompt("111.980");
    await v.finalize("provider blew up");
    expect(log.dms.length).toBe(1);
    expect(log.dms[0]).toContain("failed");
    expect(log.dms[0]).toContain("provider blew up");
    deleteView("sess-dm-a");
  });

  it("success DMs only when \\notify is on", async () => {
    const off = blank();
    const v1 = dmSeededView(off, "sess-dm-b", false);
    await v1.beginPrompt("111.981");
    await v1.finalize();
    expect(off.dms).toEqual([]);
    deleteView("sess-dm-b");

    const on = blank();
    const v2 = dmSeededView(on, "sess-dm-c", true);
    await v2.beginPrompt("111.982");
    await v2.finalize();
    expect(on.dms.length).toBe(1);
    expect(on.dms[0]).toContain("done — *p*");
    deleteView("sess-dm-c");
  });
});

describe("SessionView queued-prompt idle handling (counter + grace)", () => {
  it("two prompts + one idle + silence → finalize happens after the 8s grace", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-idle-a", { verbose: "on" });
      await v.beginPrompt("111.950");
      await v.beginPrompt("111.951");
      await v.handle({ type: "session.idle" } as never);
      expect(log.reacted).toEqual([]); // still one prompt outstanding — grace, no finalize yet
      await vi.advanceTimersByTimeAsync(8_000);
      expect(log.reacted).toEqual([
        ["111.950", "white_check_mark"],
        ["111.951", "white_check_mark"],
      ]);
      deleteView("sess-idle-a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a busy signal inside the grace cancels it; the next idle finalizes immediately", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-idle-b", { verbose: "on" });
      await v.beginPrompt("111.952");
      await v.beginPrompt("111.953");
      await v.handle({ type: "session.idle" } as never);
      await vi.advanceTimersByTimeAsync(4_000);
      await v.handle({ type: "session.status", properties: { status: { type: "busy" } } } as never);
      await vi.advanceTimersByTimeAsync(10_000); // past the old grace deadline
      expect(log.reacted).toEqual([]); // grace was cancelled — no premature finalize
      await v.handle({ type: "session.idle" } as never); // queue now really drained
      expect(log.reacted).toEqual([
        ["111.952", "white_check_mark"],
        ["111.953", "white_check_mark"],
      ]);
      deleteView("sess-idle-b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single prompt idles immediately with no grace (today's behavior)", async () => {
    const log = blank();
    const v = makeView(log, "sess-idle-c", { verbose: "on" });
    await v.beginPrompt("111.954");
    await v.handle({ type: "session.idle" } as never);
    expect(log.reacted).toEqual([["111.954", "white_check_mark"]]);
    deleteView("sess-idle-c");
  });

  it("session.error through the event chain finalizes (in-chain: no chained-finalize deadlock)", async () => {
    const log = blank();
    const v = makeView(log, "sess-idle-d", { verbose: "on" });
    await v.beginPrompt("111.955");
    await v.handle({ type: "session.error", properties: { error: "provider exploded" } } as never);
    expect(log.reacted).toEqual([["111.955", "x"]]);
    expect(log.posted.some((p) => p.includes("provider exploded"))).toBe(true);
    deleteView("sess-idle-d");
  });

  it("message.updated with a completed error finalizes through the chain", async () => {
    const log = blank();
    const v = makeView(log, "sess-idle-e", { verbose: "on" });
    await v.beginPrompt("111.956");
    await v.handle({
      type: "message.updated",
      properties: { info: { id: "m1", role: "assistant", error: { name: "AuthError" }, time: { completed: 1 } } },
    } as never);
    expect(log.reacted).toEqual([["111.956", "x"]]);
    expect(log.posted.some((p) => p.includes("AuthError"))).toBe(true);
    deleteView("sess-idle-e");
  });
});

describe("SessionView watchdog pager + nudge cap", () => {
  it("the first true stall DMs the owner once; later nudges stay thread-only", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-watch-c", { verbose: "on" });
      await v.beginPrompt("111.960");
      await vi.advanceTimersByTimeAsync(180_000);
      expect(log.updates.some((u) => u.includes("no updates for 3m"))).toBe(true);
      expect(log.dms.some((m) => m.includes("stalled"))).toBe(true);
      await vi.advanceTimersByTimeAsync(180_000); // second nudge
      expect(log.dms.filter((m) => m.includes("stalled")).length).toBe(1); // DM is first-stall-only
      deleteView("sess-watch-c");
    } finally {
      vi.useRealTimers();
    }
  });

  it("nudges stop after 3 — a hung run does not nudge forever", async () => {
    vi.useFakeTimers();
    try {
      const log = blank();
      const v = makeView(log, "sess-watch-d", { verbose: "on" });
      await v.beginPrompt("111.961");
      const nudges = (): number => log.updates.filter((u) => u.includes("no updates for 3m")).length;
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.advanceTimersByTimeAsync(180_000);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(nudges()).toBe(3);
      await vi.advanceTimersByTimeAsync(400_000); // no 4th nudge
      expect(nudges()).toBe(3);
      deleteView("sess-watch-d");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("project view enumeration (server death / idle reaper)", () => {
  it("finalizeViewsForProject targets only the matching dir; hasActiveViewForProject tracks it", async () => {
    const logA = blank();
    makeView(logA, "sess-proj-a"); // projectDir "/p" per makeView
    const logB = blank();
    const stateB = new StateStore(`${import.meta.dirname}/.fixtures/render-sess-proj-b/state.json`);
    new SessionView({
      sessionId: "sess-proj-b",
      projectDir: "/q",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T2",
      client: {} as never,
      deps: fakeDeps(logB),
      state: stateB,
      threadState: { sessionId: "sess-proj-b", projectDir: "/q", verbose: "off" as const, createdAt: 1, lastUsedAt: 1 },
    });

    expect(hasActiveViewForProject("/p")).toBe(true);
    expect(hasActiveViewForProject("/q")).toBe(true);
    expect(hasActiveViewForProject("/unrelated")).toBe(false);

    await finalizeViewsForProject("/p", "server died");
    expect(logA.posted.some((p) => p.includes("server died"))).toBe(true);
    expect(logB.posted).toEqual([]); // other project's view untouched
    expect(hasActiveViewForProject("/p")).toBe(false); // finalized views leave the registry
    expect(hasActiveViewForProject("/q")).toBe(true);
    deleteView("sess-proj-b");
  });
});
describe("stale-run reconcile (RB2)", () => {
  // The server proves completion via an assistant message created for THIS
  // run with a completed timestamp; everything else is left strictly alone.
  const doneMsg = () =>
    [
      {
        info: { role: "assistant", id: "m1", time: { created: Date.now(), completed: Date.now() } },
        parts: [{ id: "pt1", type: "text", text: "final answer" }],
      },
    ] as never;
  const liveMsg = () =>
    [{ info: { role: "assistant", id: "m1", time: { created: Date.now() } }, parts: [] }] as never;

  it("finalizes a run the server proves completed — and the backstop redelivers its answer", async () => {
    const log = blank();
    makeView(log, "sess-rec-a", { client: stubClient(doneMsg()) });
    await getView("sess-rec-a")!.beginPrompt("111.601");
    expect(await reconcileStaleViews(0)).toBe(1); // staleMs 0 = check now
    expect(log.reacted).toEqual([["111.601", "white_check_mark"]]);
    expect(getView("sess-rec-a")).toBeUndefined(); // finalized views leave the registry
    expect(log.posted.some((p) => p.includes("final answer"))).toBe(true);
  });

  it("leaves a genuinely in-flight run untouched (no completed assistant message)", async () => {
    const log = blank();
    const v = makeView(log, "sess-rec-b", { client: stubClient(liveMsg()) });
    await v.beginPrompt("111.602");
    expect(await reconcileStaleViews(0)).toBe(0);
    expect(getView("sess-rec-b")).toBe(v);
    expect(log.reacted).toEqual([]);
    deleteView("sess-rec-b");
  });

  it("ignores inactive views and fresh-stale windows", async () => {
    const log = blank();
    const v = makeView(log, "sess-rec-c", { client: stubClient(doneMsg()) });
    expect(await reconcileStaleViews(0)).toBe(0); // never begun → not active
    await v.beginPrompt("111.603");
    expect(await reconcileStaleViews(120_000)).toBe(0); // events just arrived — not stale
    expect(getView("sess-rec-c")).toBe(v);
    deleteView("sess-rec-c");
  });
});

describe("summary delivery fallback (RB5)", () => {
  it("a dropped final line pages the owner by DM instead of vanishing (and the view still cleans up)", async () => {
    const log = blank();
    const deps = fakeDeps(log);
    const realPost = deps.post;
    deps.post = async (c, t, text, blocks, opts) => {
      if (text.startsWith("*p*")) throw new Error("429 retry limit exhausted"); // the summary line
      return realPost(c, t, text, blocks, opts);
    };
    const state = new StateStore(`${import.meta.dirname}/.fixtures/render-sess-rb5/state.json`);
    const thread = { sessionId: "sess-rb5", projectDir: "/p", verbose: "off" as const, createdAt: 1, lastUsedAt: 1 };
    state.setThread("C1:T1", thread);
    const v = new SessionView({
      sessionId: "sess-rb5",
      projectDir: "/p",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: stubClient(),
      deps,
      state,
      threadState: thread,
    });
    await v.beginPrompt("111.604");
    await v.finalize();
    expect(log.posted.some((p) => p.startsWith("*p*"))).toBe(false); // summary post really failed
    expect(log.dms.some((d) => d.includes("couldn't post the run's final line"))).toBe(true);
    expect(getView("sess-rb5")).toBeUndefined(); // registry cleanup still ran
  });
});

describe("active-run snapshot (RQ1)", () => {
  it("describeActiveRuns reports in-flight runs with elapsed + queued counts", async () => {
    const log = blank();
    makeView(log, "sess-runs-a");
    expect(describeActiveRuns()).toEqual([]); // nothing begun
    await getView("sess-runs-a")!.beginPrompt("111.701");
    await getView("sess-runs-a")!.beginPrompt("111.702"); // queued behind the first
    const runs = describeActiveRuns();
    expect(runs).toEqual([
      { projectDir: "/p", sessionId: "sess-runs-a", threadKey: "C1:T1", elapsedMs: expect.any(Number), queued: 1 },
    ]);
    deleteView("sess-runs-a");
  });
});

describe("completion DM diff button (RF1)", () => {
  it("carries a view_diff button bound to the session", async () => {
    const on = blank();
    const state = new StateStore(`${import.meta.dirname}/.fixtures/render-sess-rf1/state.json`);
    const thread = { sessionId: "sess-rf1", projectDir: "/p", verbose: "on" as const, createdAt: 1, lastUsedAt: 1, notify: true };
    state.setThread("C1:T1", thread);
    const v = new SessionView({
      sessionId: "sess-rf1",
      projectDir: "/p",
      channel: "C1",
      threadTs: "T1",
      threadKey: "C1:T1",
      client: stubClient(),
      deps: fakeDeps(on),
      state,
      threadState: thread,
    });
    await v.beginPrompt("111.705");
    await v.finalize();
    expect(on.dms.length).toBe(1);
    const blocks = on.dmBlocks[0];
    expect(JSON.stringify(blocks)).toContain('"view_diff"');
    expect(JSON.stringify(blocks)).toContain('"sess-rf1"');
    expect(JSON.stringify(blocks)).toContain("View diff");
    deleteView("sess-rf1");
  });
});
