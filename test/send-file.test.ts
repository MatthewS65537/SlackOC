import { appendFileSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SEND_FILE_BYTES, parseSendFileArgs, sendFile } from "../src/send-file.js";

const root = resolve("test/.fixtures/send-file");
const configPath = `${root}/config.json`;
const statePath = `${root}/state.json`;
const path = `${root}/report with spaces.pdf`;
const binary = Buffer.from([0, 255, 16, 13, 10, 127]);
const thread = (sessionId = "ses_current") => ({ sessionId, projectDir: root,
  recovery: { bindingGeneration: 2, intentVersion: 3 } });
const save = (threads: Record<string, unknown> = { "C123:1791000000.123456": thread() }) => writeFileSync(statePath, JSON.stringify({ threads, projects: {} }));
const call = (opts = {}, deps = {}) => sendFile({ file: path, session: "ses_current", ...opts }, { configPath, statePath, ...deps });

beforeEach(() => {
  mkdirSync(root, { recursive: true });
  writeFileSync(path, binary);
  writeFileSync(configPath, JSON.stringify({ slackBotToken: "xoxb-secret-fixture", ownerSlackUserId: "U123" }));
  save();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

function transport(completion: unknown = { ok: true, files: [{ id: "F123" }] }, transfer?: () => void) {
  const payloads: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    payloads.push({ url: String(url), init });
    if (String(url).endsWith("files.getUploadURLExternal")) return Response.json({ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/fixture" });
    if (String(url).includes("/upload/fixture")) { transfer?.(); return new Response("ok"); }
    if (String(url).endsWith("files.completeUploadExternal")) return Response.json(completion);
    throw new Error(`Unexpected call ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, payloads };
}

describe("send-file argument handling", () => {
  it("accepts quoted paths and equals flags without losing comment text", () => {
    expect(parseSendFileArgs(["--file", path, "--session=ses_current", "--comment", "Report with spaces"])).toEqual({ file: path, session: "ses_current", comment: "Report with spaces" });
  });
  it("accepts empty and flag-like literal comments from the native tool", () => {
    expect(parseSendFileArgs(["--file", path, "--session", "ses_current", "--comment="]).comment).toBe("");
    expect(parseSendFileArgs(["--file", path, "--session", "ses_current", "--comment=--ready"]).comment).toBe("--ready");
  });
  it.each([
    [], ["--file", path], ["--session", "ses_current"], ["--file", "--session", "ses_current"],
    ["--file="], ["--file", path, "--file", path], ["--channel", "C123"], ["file.pdf"], ["--dm"],
  ].map(argv => [argv]))("rejects missing/ambiguous arguments without an implicit destination: %j", argv => {
    expect(() => parseSendFileArgs(argv)).toThrow();
  });
});

describe("active-thread file delivery through the installed Slack SDK", () => {
  it("uploads binary bytes unchanged and returns a confirmed thread receipt without opening a DM", async () => {
    const { payloads, fetch } = transport();
    const before = readFileSync(statePath);
    expect(await call({ comment: "Report <@U123> *ready*" })).toEqual({ ok: true, sessionId: "ses_current", channelId: "C123", threadTs: "1791000000.123456", fileId: "F123", filename: "report with spaces.pdf", bytes: binary.length });
    expect(payloads).toHaveLength(3);
    const transferred = (payloads[1]!.init.body as FormData).get("body") as Blob;
    expect(Buffer.from(await transferred.arrayBuffer())).toEqual(binary);
    const completion = new URLSearchParams(String(payloads[2]!.init.body));
    expect(completion.get("channel_id")).toBe("C123");
    expect(completion.get("thread_ts")).toBe("1791000000.123456");
    expect(completion.get("initial_comment")).toBe("Report &lt;@U123&gt; ∗ready∗");
    expect(JSON.parse(completion.get("files")!)).toEqual([{ id: "F123", title: "report with spaces.pdf" }]);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("conversations.open"))).toBe(false);
    expect(readFileSync(statePath)).toEqual(before);
  });
  it("isolates two concurrent session destinations, including an existing DM thread", async () => {
    save({ "C123:1791000000.123456": thread(), "D456:1791000001.000001": thread("ses_other") });
    const { payloads } = transport();
    const results = await Promise.all([call(), call({ session: "ses_other" })]);
    expect(results.map(r => [r.sessionId, r.channelId, r.threadTs])).toEqual([
      ["ses_current", "C123", "1791000000.123456"], ["ses_other", "D456", "1791000001.000001"],
    ]);
    expect(payloads.filter(p => p.url.endsWith("files.completeUploadExternal"))).toHaveLength(2);
  });
  it.each([
    { "C123:1791000000.123456": thread("ses_other") },
    { "C123:1791000000.123456": thread(), "C456:1791000001.000001": thread() },
    { "bad:reply": thread() },
    { "C123:1791000000.123456": { ...thread(), recovery: {} } },
    { "C123:1791000000.123456": { ...thread(), projectDir: "relative" } },
    { "C123:1791000000.123456": { ...thread(), recovery: { ...thread().recovery, lastRun: { sessionId: "ses_current", outcome: "stopped" } } } },
  ])("refuses unknown, ambiguous, invalid or stopped bindings without upload: %j", async threads => {
    save(threads);
    const { fetch } = transport();
    await expect(call()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed on malformed state and missing configuration", async () => {
    const { fetch } = transport();
    writeFileSync(statePath, "not JSON");
    await expect(call()).rejects.toThrow(/state/);
    save();
    rmSync(configPath);
    await expect(call()).rejects.toThrow(/slackoc init/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["relative.pdf", "https://example.com/file.pdf", root, `${root}/missing.pdf`])("rejects invalid local file %s before network effects", async file => {
    const { fetch } = transport();
    await expect(call({ file })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects empty and oversized sparse files without reading/uploading them", async () => {
    const { fetch } = transport();
    writeFileSync(path, "");
    await expect(call()).rejects.toThrow(/empty/);
    truncateSync(path, MAX_SEND_FILE_BYTES + 1);
    await expect(call()).rejects.toThrow(/50 MiB/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds a file that grows after descriptor stat instead of uploading a partial artifact", async () => {
    const { fetch } = transport();
    const allocate = Buffer.allocUnsafe;
    vi.spyOn(Buffer, "allocUnsafe").mockImplementation(size => {
      if (size === binary.length + 1) appendFileSync(path, Buffer.from([1, 2, 3]));
      return allocate(size);
    });
    await expect(call()).rejects.toThrow(/changed/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rechecks binding generation after transfer and never shares into a rebound thread", async () => {
    const { payloads } = transport(undefined, () => save({ "C123:1791000000.123456": { ...thread(), recovery: { bindingGeneration: 3, intentVersion: 3 } } }));
    await expect(call()).rejects.toThrow(/binding changed/);
    expect(payloads).toHaveLength(2);
    expect(payloads.some(p => p.url.endsWith("files.completeUploadExternal"))).toBe(false);
  });
  it.each([
    { ok: true, files: [] }, { ok: true, files: [{ title: "missing ID" }] }, { ok: false, error: "internal_error" },
  ])("does not claim success for an unconfirmed completion: %j", async completion => {
    const { fetch } = transport(completion);
    await expect(call()).rejects.toThrow(/may already/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("gives scope remediation and does not leak credentials in errors", async () => {
    transport({ ok: false, error: "missing_scope" });
    await expect(call()).rejects.toThrow(/files:write.*reinstall/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("request Authorization: Bearer xoxb-secret-fixture"); }));
    await expect(call()).rejects.toThrow(/may already/);
    try { await call(); } catch (error) { expect(String(error)).not.toContain("xoxb-secret-fixture"); }
  });
  it("never retries a rate-limited completion", async () => {
    const { fetch } = transport();
    fetch.mockImplementationOnce(async () => Response.json({ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/fixture" }))
      .mockImplementationOnce(async () => new Response("ok"))
      .mockImplementationOnce(async () => new Response("limited", { status: 429, headers: { "retry-after": "3" } }));
    await expect(call()).rejects.toThrow(/rate limited.*not retried/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("cancels the binary transfer at the end-to-end deadline without late completion or retries", async () => {
    let transferSignal!: AbortSignal;
    const { fetch } = transport();
    fetch.mockImplementationOnce(async () => Response.json({ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/fixture" }))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        transferSignal = init.signal!;
        transferSignal.addEventListener("abort", () => reject(transferSignal.reason), { once: true });
      }));
    const result = expect(call({}, { timeoutMs: 1000 })).rejects.toThrow(/may already/);
    await vi.waitFor(() => expect(transferSignal).toBeDefined());
    await result;
    expect(transferSignal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("forwards caller cancellation through every SDK stage", async () => {
    const controller = new AbortController();
    const { fetch } = transport(undefined, () => controller.abort(new Error("stopped")));
    await expect(call({}, { signal: controller.signal })).rejects.toThrow(/may already/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
