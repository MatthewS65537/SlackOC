import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Headless Chrome through its plain CLI (no CDP): print-to-PDF for HTML sends
 * (B1) and `\shot pdf`, viewport screenshots for `\shot`. Each run gets a fresh
 * throwaway profile, so no cookies or extensions leak into captures.
 */

export const MAC_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const PATH_NAMES = ["google-chrome", "chromium", "chromium-browser"];
/** Chrome's own `--timeout`: after this it stops loading and captures whatever rendered. */
export const PDF_LOAD_MS = 15_000;
export const SHOT_LOAD_MS = 10_000;
/** Virtual time fast-forwarded before capture, so timer/animation-driven pages finish drawing. */
const VIRTUAL_TIME_MS = 5_000;
/** Hard kill this long after the load cap (startup + capture), in case Chrome hangs. */
const KILL_MARGIN_MS = 10_000;

export class HeadlessError extends Error {
  constructor(readonly reason: "missing" | "timeout" | "failed", message: string) { super(message); }
}

export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ stderr: string }>;
export interface HeadlessOptions {
  /** Defaults to the cached `findChrome()`; tests inject it plus a fake `exec`. */
  findChrome?: () => Promise<string | undefined>;
  exec?: ExecFn;
  signal?: AbortSignal;
}

async function executableFile(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

/** First runnable candidate: $SLACKOC_CHROME, the macOS app bundles, then PATH names (in name order, like `which`). */
export async function locateChrome(env: NodeJS.ProcessEnv = process.env, isExecutable = executableFile): Promise<string | undefined> {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [env.SLACKOC_CHROME, ...MAC_CHROME_PATHS, ...PATH_NAMES.flatMap(name => dirs.map(dir => join(dir, name)))];
  for (const candidate of candidates) if (candidate && await isExecutable(candidate)) return candidate;
  return undefined;
}

let foundChrome: string | undefined;
/** Cached once found; a miss is re-checked next time so installing Chrome needs no restart. */
export async function findChrome(): Promise<string | undefined> {
  return foundChrome ??= await locateChrome();
}

/** http(s) URLs pass through; anything else is a local path turned into a file:// URL. */
export function targetUrl(target: string): string {
  return /^https?:\/\//i.test(target) ? new URL(target).href : pathToFileURL(resolve(target)).href;
}

function baseArgs(profile: string, loadMs: number): string[] {
  return ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    `--timeout=${loadMs}`, `--virtual-time-budget=${VIRTUAL_TIME_MS}`];
}

/** The URL is always last and always http(s)/file://, so it can never be read as a flag. */
export function pdfArgs(url: string, out: string, profile: string): string[] {
  return [...baseArgs(profile, PDF_LOAD_MS), "--no-pdf-header-footer", `--print-to-pdf=${out}`, url];
}

export function screenshotArgs(url: string, out: string, profile: string, size: { width: number; height: number }): string[] {
  return [...baseArgs(profile, SHOT_LOAD_MS), "--hide-scrollbars", `--window-size=${size.width},${size.height}`, `--screenshot=${out}`, url];
}

const execChrome: ExecFn = (file, args, { timeoutMs, signal }) => new Promise((resolve, reject) => {
  // execFile never involves a shell; SIGKILL because a hung Chrome may ignore SIGTERM.
  execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true, encoding: "utf8" },
    (error, _stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stderr }));
});

/** A fresh private dir under the OS temp dir, always removed after `fn`. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "slackoc-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {}); }
}

function execFailure(error: unknown, chrome: string, timeoutMs: number): HeadlessError {
  const e = error as { code?: unknown; killed?: boolean; signal?: unknown };
  if (e.killed && e.signal === "SIGKILL") return new HeadlessError("timeout", `Chrome timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (e.code === "ENOENT" || e.code === "EACCES") {
    return new HeadlessError("missing", `Chrome could not be started (${chrome}); set \`SLACKOC_CHROME\` to a working Chrome binary`);
  }
  return new HeadlessError("failed", `Chrome failed (${typeof e.code === "number" ? `exit ${e.code}` : String(e.signal ?? e.code ?? "error")})`);
}

async function runChrome(args: (profile: string) => string[], out: string, loadMs: number, opts: HeadlessOptions): Promise<void> {
  const chrome = await (opts.findChrome ?? findChrome)();
  if (!chrome) throw new HeadlessError("missing", "Chrome wasn't found; set `SLACKOC_CHROME` or install Google Chrome");
  const timeoutMs = loadMs + KILL_MARGIN_MS;
  await withTempDir(async profile => {
    let stderr: string;
    try { ({ stderr } = await (opts.exec ?? execChrome)(chrome, args(profile), { timeoutMs, signal: opts.signal })); }
    catch (error) { opts.signal?.throwIfAborted(); throw execFailure(error, chrome, timeoutMs); }
    // Chrome exits 0 without output when navigation fails (e.g. dev server down).
    if (!await stat(out).then(s => s.isFile() && s.size > 0, () => false)) {
      const load = /Page load failed: (\S+)/.exec(stderr)?.[1];
      throw new HeadlessError("failed", load ? `Chrome couldn't load the page (${load})` : "Chrome exited without writing any output");
    }
  });
}

/**
 * Serve `html` at an unguessable loopback URL while `fn` runs. send-file renders the bytes it already
 * checked this way: an http page can't load file:// resources, so the HTML can't frame local secrets
 * (and a swapped file can't be rendered). Relative local images/CSS don't load as a consequence.
 */
export async function withServedHtml<T>(html: Buffer, fn: (url: string) => Promise<T>): Promise<T> {
  const path = `/${randomBytes(16).toString("hex")}.html`;
  const server = createServer((req, res) => {
    if (req.url === path) res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    else res.writeHead(404).end();
  });
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`); }
  finally { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
}

/** Print an HTML file (or http(s) URL) to `outPath` as a PDF without header/footer. */
export async function htmlToPdf(input: string, outPath: string, opts: HeadlessOptions = {}): Promise<void> {
  const url = targetUrl(input);
  await runChrome(profile => pdfArgs(url, outPath, profile), outPath, PDF_LOAD_MS, opts);
}

/** Viewport-sized PNG of a URL or local file (not full-page: that needs CDP). */
export async function screenshot(target: string, outPath: string, size: { width: number; height: number }, opts: HeadlessOptions = {}): Promise<void> {
  const url = targetUrl(target);
  await runChrome(profile => screenshotArgs(url, outPath, profile, size), outPath, SHOT_LOAD_MS, opts);
}
