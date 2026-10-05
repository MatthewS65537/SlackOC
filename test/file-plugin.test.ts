import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import plugin, {
  fileSendTool, FILE_SEND_KILL_GRACE_MS, FILE_SEND_OUTPUT_LIMIT, FILE_SEND_TIMEOUT_MS,
} from "../src/opencode/file-plugin.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_signal: NodeJS.Signals) => true),
    unref: vi.fn(),
  });
}

type FakeChild = ReturnType<typeof fakeChild>;
let children: FakeChild[];
beforeEach(() => {
  children = [];
  vi.mocked(spawn).mockReset().mockImplementation(() => {
    const child = fakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
});
afterEach(() => {
  for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function context(sessionID = "ses_current", signal = new AbortController().signal): ToolContext {
  return { sessionID, signal } as unknown as ToolContext;
}

function receipt(sessionId = "ses_current", channel = "C012ABCDEF", threadTs = "1700000000.000001") {
  return { ok: true, sessionId, fileId: "F012ABCDEF", channelId: channel, threadTs, filename: "file.pdf", bytes: 12 };
}

function complete(child: FakeChild, value: unknown = receipt(), code: number | null = 0, signal: NodeJS.Signals | null = null) {
  child.stdout.emit("data", typeof value === "string" ? value : JSON.stringify(value));
  child.emit("close", code, signal);
}

describe("native file-send tool", () => {
  it("registers only the strict path/comment tool with its distinct native permission and disposes its transform", async () => {
    const add = vi.fn();
    const dispose = vi.fn().mockResolvedValue(undefined);
    const transform = vi.fn(async (edit: (editor: { add: typeof add }) => void) => {
      edit({ add });
      return { dispose };
    });
    const cleanup = await plugin.setup({ tool: { transform } } as unknown as Context);
    expect(plugin.id).toBe("slackoc-files");
    expect(add).toHaveBeenCalledExactlyOnceWith(fileSendTool);
    expect(fileSendTool.name).toBe("slackoc_send_file");
    expect(fileSendTool.options).toEqual({ permission: "slackoc.send_file" });
    expect(fileSendTool.input).toMatchObject({ type: "object", required: ["path"], additionalProperties: false });
    expect(Object.keys((fileSendTool.input as { properties: object }).properties)).toEqual(["path", "comment"]);
    if (typeof cleanup !== "function") throw new Error("Missing transform cleanup");
    await cleanup();
    expect(dispose).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes spaces and shell syntax as literal arguments using the native session and returns text only", async () => {
    const path = "/project/Quarterly report;$(touch nope).pdf";
    const comment = "Here's the file: \"hello\"; $(echo nope)";
    const pending = fileSendTool.execute({ path, comment }, context());
    expect(spawn).toHaveBeenCalledExactlyOnceWith("slackoc", [
      "send-file", "--file", path, "--session", "ses_current", `--comment=${comment}`,
    ], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    complete(children[0]!, { ...receipt(), content: [{ type: "file", uri: "file:///must-not-forward" }], secret: "must-not-forward" });
    expect(await pending).toEqual({ content: JSON.stringify(receipt()) });
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });

  it("omits an absent comment but preserves an explicitly empty comment", async () => {
    const first = fileSendTool.execute({ path: "/project/file.pdf" }, context());
    complete(children[0]!);
    await first;
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(["send-file", "--file", "/project/file.pdf", "--session", "ses_current"]);
    const second = fileSendTool.execute({ path: "/project/file.pdf", comment: "" }, context());
    complete(children[1]!);
    await second;
    expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(["send-file", "--file", "/project/file.pdf", "--session", "ses_current", "--comment="]);
  });

  it("keeps concurrent native sessions independent even when the second CLI finishes first", async () => {
    const first = fileSendTool.execute({ path: "/project/file.pdf" }, context("ses_first"));
    const second = fileSendTool.execute({ path: "/project/file.pdf" }, context("ses_second"));
    complete(children[1]!, receipt("ses_second", "G012ABCDEF", "1700000000.000002"));
    complete(children[0]!, receipt("ses_first", "D012ABCDEF", "1700000000.000001"));
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      { content: JSON.stringify(receipt("ses_first", "D012ABCDEF", "1700000000.000001")) },
      { content: JSON.stringify(receipt("ses_second", "G012ABCDEF", "1700000000.000002")) },
    ]);
    expect(vi.mocked(spawn).mock.calls.map(call => call[1])).toEqual([
      ["send-file", "--file", "/project/file.pdf", "--session", "ses_first"],
      ["send-file", "--file", "/project/file.pdf", "--session", "ses_second"],
    ]);
  });

  it.each([
    null, [], "file.pdf", {}, { path: "relative.pdf" }, { path: "https://example.com/file.pdf" },
    { path: "/project/file\0.pdf" }, { path: 7 }, { path: "/file.pdf", comment: null },
    { path: "/file.pdf", comment: "bad\0comment" }, { path: "/file.pdf", session: "ses_other" },
    { path: "/file.pdf", sessionID: "ses_other" }, { path: "/file.pdf", destination: "DM" },
    { path: "/file.pdf", channel: "C012ABCDEF" }, { path: "/file.pdf", threadTs: "1700000000.000001" },
    { path: "/file.pdf", unrelated: true }, { path: "/file.pdf", comment: "x".repeat(2001) },
  ])("rejects invalid or destination-bearing input without launching a CLI: %j", async input => {
    await expect(fileSendTool.execute(input, context())).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["", " ses_current", "ses_current\n", "ses_\0current"])("requires a valid native session ID: %j", async sessionID => {
    await expect(fileSendTool.execute({ path: "/file.pdf" }, context(sessionID))).rejects.toThrow("native executor");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("file-send subprocess bounds and failures", () => {
  it("does not launch a child for an already-canceled executor", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fileSendTool.execute({ path: "/file.pdf" }, context("ses_current", controller.signal)))
      .rejects.toThrow("before starting. No file was sent");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancels mid-execution, escalates an unresponsive child and does not accept a late receipt or retry", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context("ses_current", controller.signal));
    const failure = expect(pending).rejects.toThrow(/canceled during execution.*Delivery is uncertain/);
    const child = children[0]!;
    controller.abort();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.stdout.emit("data", JSON.stringify(receipt()));
    await vi.advanceTimersByTimeAsync(FILE_SEND_KILL_GRACE_MS);
    await failure;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up immediately when a canceled child exits cooperatively", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context("ses_current", controller.signal));
    const failure = expect(pending).rejects.toThrow("Delivery is uncertain");
    const child = children[0]!;
    child.kill.mockImplementation(signal => { child.emit("close", null, signal); return true; });
    controller.abort();
    await failure;
    await vi.advanceTimersByTimeAsync(FILE_SEND_KILL_GRACE_MS);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("handles cancellation that happens while the spawn call is returning", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const child = fakeChild();
    children.push(child);
    vi.mocked(spawn).mockImplementationOnce(() => {
      controller.abort();
      return child as unknown as ChildProcess;
    });
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context("ses_current", controller.signal));
    const failure = expect(pending).rejects.toThrow("Delivery is uncertain");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows the CLI's 120-second budget, then enforces a bounded deadline and force-kills without retry", async () => {
    vi.useFakeTimers();
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    const failure = expect(pending).rejects.toThrow(/execution deadline.*Delivery is uncertain/);
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FILE_SEND_TIMEOUT_MS - 120_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(FILE_SEND_KILL_GRACE_MS);
    await failure;
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds combined stdout/stderr by bytes, including multibyte text", async () => {
    vi.useFakeTimers();
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    const failure = expect(pending).rejects.toThrow(/output limit.*Delivery is uncertain/);
    const child = children[0]!;
    child.stdout.emit("data", Buffer.alloc(FILE_SEND_OUTPUT_LIMIT - 2, "x"));
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr.emit("data", "界");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(FILE_SEND_KILL_GRACE_MS);
    await failure;
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never treats a successful-looking stdout receipt as success after a nonzero exit", async () => {
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    children[0]!.stderr.emit("data", "missing_scope: reinstall the Slack app with files:write");
    complete(children[0]!, receipt(), 1);
    await expect(pending).rejects.toThrow(/missing_scope: reinstall the Slack app/);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("reports uncertain delivery when the child exits by a signal", async () => {
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    complete(children[0]!, receipt(), null, "SIGTERM");
    await expect(pending).rejects.toThrow(/SIGTERM.*Delivery is uncertain/);
  });

  it("provides missing-CLI remediation without claiming an upload", async () => {
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    children[0]!.pid = undefined;
    children[0]!.emit("error", Object.assign(new Error("spawn slackoc ENOENT"), { code: "ENOENT" }));
    await expect(pending).rejects.toThrow("slackoc is not installed or is not on OpenCode's PATH. No file was sent");
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });

  it("surfaces synchronous spawn failures without running another CLI", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("cannot spawn"); });
    await expect(fileSendTool.execute({ path: "/file.pdf" }, context())).rejects.toThrow("Unable to start slackoc send-file");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("stops a child after an execution error rather than retrying it", async () => {
    vi.useFakeTimers();
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    const failure = expect(pending).rejects.toThrow(/subprocess failed.*Delivery is uncertain/);
    const child = children[0]!;
    child.emit("error", new Error("pipe failure"));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 1, null);
    await failure;
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes abort listeners and all timers after success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context("ses_current", controller.signal));
    const child = children[0]!;
    complete(child);
    await pending;
    controller.abort();
    await vi.advanceTimersByTimeAsync(FILE_SEND_TIMEOUT_MS + FILE_SEND_KILL_GRACE_MS);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("confirmed file-send receipts", () => {
  it.each([
    "not JSON", "", `${JSON.stringify(receipt())}\n${JSON.stringify(receipt())}`, [], null,
    { ...receipt(), ok: false }, { ...receipt(), ok: "true" }, { ...receipt(), sessionId: "ses_other" },
    { ...receipt(), fileId: "" }, { ...receipt(), fileId: "file-not-a-slack-id" },
    { ...receipt(), channelId: "" }, { ...receipt(), channelId: "U012ABCDEF" },
    { ...receipt(), threadTs: "" }, { ...receipt(), threadTs: "1700000000" },
    { ...receipt(), threadTs: "0.000001" }, { ...receipt(), threadTs: "1700000000.000001\n" },
    { ...receipt(), filename: "" }, { ...receipt(), bytes: 0 }, { ...receipt(), bytes: 50 * 1024 * 1024 + 1 },
  ])("rejects unconfirmed, malformed or mismatched success output: %j", async value => {
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    complete(children[0]!, value);
    await expect(pending).rejects.toThrow(/Delivery is uncertain/);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("accepts a receipt split across chunks only after the process closes", async () => {
    const pending = fileSendTool.execute({ path: "/file.pdf" }, context());
    const text = JSON.stringify(receipt());
    children[0]!.stdout.emit("data", Buffer.from(text.slice(0, 20)));
    children[0]!.stdout.emit("data", Buffer.from(text.slice(20)));
    let finished = false;
    void pending.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    children[0]!.emit("close", 0, null);
    expect(await pending).toEqual({ content: text });
  });
});
