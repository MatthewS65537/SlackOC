import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SEND_FILE_BYTES, parseSendFileArgs, sendFile } from "../src/send-file.js";
import type { ExecFn } from "../src/headless.js";

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
  writeFileSync(configPath, JSON.stringify({ slackBotToken: "xoxb-secret-fixture", ownerSlackUserId: "U12345678" }));
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
    writeFileSync(statePath, JSON.stringify({ version: 2, threads: { "C123:1791000000.123456": thread() }, projects: {} }));
    await expect(call()).rejects.toThrow(/state version 2 is not supported/);
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

describe("credential guard", () => {
  it("refuses SlackOC's own config file and key-like files even when bound", async () => {
    await expect(sendFile({ file: configPath, session: "ses_current" }, { configPath, statePath })).rejects.toThrow(/credentials or SlackOC configuration/);
    const key = `${root}/id_ed25519`;
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----");
    await expect(sendFile({ file: key, session: "ses_current" }, { configPath, statePath })).rejects.toThrow(/credentials/);
  });

  it("refuses .env files but lets Keynote .key decks through", async () => {
    const env = `${root}/.env.local`;
    writeFileSync(env, "API_KEY=secret");
    await expect(sendFile({ file: env, session: "ses_current" }, { configPath, statePath })).rejects.toThrow(/credentials/);
    const deck = `${root}/talk.key`;
    writeFileSync(deck, "keynote bytes");
    const outcome = await sendFile({ file: deck, session: "ses_current" }, { configPath, statePath }).then(() => null, (err: Error) => err);
    expect(String(outcome?.message ?? "")).not.toMatch(/credentials/);
  });
});

/** Plain node:http GET (global fetch is stubbed by these tests). */
function httpGet(url: string): Promise<string> {
  return new Promise((ok, fail) => get(url, res => {
    let body = "";
    res.on("data", chunk => { body += chunk; }).on("end", () => ok(body));
  }).on("error", fail));
}

describe("HTML sends also deliver a rendered PDF", () => {
  const html = `${root}/report.html`;
  const source = "<h1>Quarterly</h1>";
  const findChrome = async () => "/fake/chrome";
  const outOf = (args: string[]) => args.find(a => a.startsWith("--print-to-pdf="))!.slice("--print-to-pdf=".length);
  const profileOf = (args: string[]) => args.find(a => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
  beforeEach(() => writeFileSync(html, source));

  /** Per-file upload IDs (FPDF/FHTML) and a completion that confirms exactly what was completed. */
  function echoTransport() {
    const bodies = new Map<string, Buffer>();
    const completions: URLSearchParams[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith("files.getUploadURLExternal")) {
        const id = new URLSearchParams(String(init.body)).get("filename")!.endsWith(".pdf") ? "FPDF" : "FHTML";
        return Response.json({ ok: true, file_id: id, upload_url: `https://files.slack.com/upload/${id}` });
      }
      if (u.includes("/upload/")) {
        bodies.set(u.split("/").at(-1)!, Buffer.from(await ((init.body as FormData).get("body") as Blob).arrayBuffer()));
        return new Response("ok");
      }
      if (u.endsWith("files.completeUploadExternal")) {
        const params = new URLSearchParams(String(init.body));
        completions.push(params);
        return Response.json({ ok: true, files: JSON.parse(params.get("files")!).map((f: { id: string }) => ({ id: f.id })) });
      }
      throw new Error(`Unexpected call ${u}`);
    }));
    return { bodies, completions };
  }

  it("posts the PDF first and the HTML in one thread message, reports both, and removes temp files", async () => {
    const { bodies, completions } = echoTransport();
    const argv: string[][] = [];
    let served = "";
    const exec = vi.fn<ExecFn>(async (_file, args) => {
      argv.push(args);
      served = await httpGet(args.at(-1)!); // what Chrome would load
      writeFileSync(outOf(args), "%PDF-1.7 fake");
      return { stderr: "" };
    });
    const receipt = await call({ file: html, comment: "Report" }, { headless: { exec, findChrome } });
    expect(receipt).toEqual({ ok: true, sessionId: "ses_current", channelId: "C123", threadTs: "1791000000.123456",
      fileId: "FHTML", filename: "report.html", bytes: source.length, pdf: { fileId: "FPDF", filename: "report.pdf", bytes: 13 } });
    expect(completions).toHaveLength(1);
    expect(JSON.parse(completions[0]!.get("files")!)).toEqual([{ id: "FPDF", title: "report.pdf" }, { id: "FHTML", title: "report.html" }]);
    expect(completions[0]!.get("thread_ts")).toBe("1791000000.123456");
    expect(completions[0]!.get("initial_comment")).toBe("Report");
    expect(bodies.get("FPDF")!.toString()).toBe("%PDF-1.7 fake");
    expect(bodies.get("FHTML")!.toString()).toBe(source);
    // Chrome gets the checked bytes over loopback, never a file:// URL that could frame local files.
    expect(argv[0]!.at(-1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.html$/);
    expect(served).toBe(source);
    await expect(httpGet(argv[0]!.at(-1)!)).rejects.toThrow(); // server closed after the render
    expect(existsSync(profileOf(argv[0]!))).toBe(false);
    expect(existsSync(dirname(outOf(argv[0]!)))).toBe(false);
  });

  it("sends the HTML alone with a SLACKOC_CHROME note when Chrome is missing", async () => {
    const { completions } = echoTransport();
    const exec = vi.fn<ExecFn>();
    const receipt = await call({ file: html, comment: "Report" }, { headless: { exec, findChrome: async () => undefined } });
    expect(receipt).toMatchObject({ fileId: "FHTML", filename: "report.html", pdfSkipped: expect.stringContaining("SLACKOC_CHROME") });
    expect(receipt.pdf).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(JSON.parse(completions[0]!.get("files")!)).toEqual([{ id: "FHTML", title: "report.html" }]);
    expect(completions[0]!.get("initial_comment")).toMatch(/^Report\nNo PDF: Chrome wasn't found; set `SLACKOC_CHROME`/);
  });

  it.each([
    ["a Chrome timeout", /timed out/, async () => { throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }); }],
    ["a PDF over the 50 MiB limit", /50 MiB/, async (args: string[]) => { writeFileSync(outOf(args), "%PDF"); truncateSync(outOf(args), MAX_SEND_FILE_BYTES + 1); return { stderr: "" }; }],
  ] as const)("still sends the HTML after %s", async (_name, reason, run) => {
    const { completions } = echoTransport();
    let profile = "";
    const exec: ExecFn = async (_file, args) => { profile = profileOf(args); return run(args); };
    const receipt = await call({ file: html }, { headless: { exec, findChrome } });
    expect(receipt.pdfSkipped).toMatch(reason);
    expect(JSON.parse(completions[0]!.get("files")!)).toEqual([{ id: "FHTML", title: "report.html" }]);
    expect(existsSync(profile)).toBe(false);
  });

  it("--no-pdf sends only the source without running Chrome; other files never render", async () => {
    expect(parseSendFileArgs(["--file", html, "--session", "ses_current", "--no-pdf"]).noPdf).toBe(true);
    expect(() => parseSendFileArgs(["--file", html, "--session", "ses_current", "--no-pdf", "--no-pdf"])).toThrow(/duplicate/);
    const { completions } = echoTransport();
    const exec = vi.fn<ExecFn>();
    const plain = await call({ file: html, noPdf: true }, { headless: { exec, findChrome } });
    const pdfFile = await call({}, { headless: { exec, findChrome } });
    expect(exec).not.toHaveBeenCalled();
    expect([plain, pdfFile].map(r => [r.filename, "pdf" in r, "pdfSkipped" in r])).toEqual([["report.html", false, false], ["report with spaces.pdf", false, false]]);
    expect(completions.map(c => JSON.parse(c.get("files")!).length)).toEqual([1, 1]);
  });
});
