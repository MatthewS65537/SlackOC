import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { LogLevel, WebClient } from "@slack/web-api";
import { CONFIG_DIR, CONFIG_PATH, OWNER_ID_RE, STATE_PATH } from "./config.js";
import { withDeadline, type RequestOptions } from "./http.js";
import { slackWebClientOptions, SLACK_UPLOAD_TIMEOUT_MS, withSlackOperation } from "./slack/transport.js";
import { safePayload } from "./slack/tool-format.js";
import { esc } from "./util.js";
import { HeadlessError, htmlToPdf, withServedHtml, withTempDir, type HeadlessOptions } from "./headless.js";

export const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024;
/** `noPdf` (`--no-pdf`) sends .html/.htm source only, without the rendered PDF. */
export interface SendFileOptions { file: string; session: string; comment?: string; noPdf?: boolean }
export interface FileReceipt {
  ok: true;
  sessionId: string;
  channelId: string;
  threadTs: string;
  fileId: string;
  filename: string;
  bytes: number;
  /** PDF rendered from an .html/.htm send, posted in the same message. */
  pdf?: { fileId: string; filename: string; bytes: number };
  /** Why an .html/.htm send went out without its PDF (the send itself succeeded). */
  pdfSkipped?: string;
}
interface Binding { key: string; session: string; channel: string; threadTs: string; project: string; generation: number; intent: number }
interface SendFileDeps extends RequestOptions { configPath?: string; statePath?: string; headless?: Omit<HeadlessOptions, "signal"> }
class FileSendError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** This command deliberately has no implicit destination or permissive positional arguments. */
export function parseSendFileArgs(argv: string[]): SendFileOptions {
  const flags: Record<string, string> = {};
  let noPdf = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-pdf") {
      if (noPdf) throw new FileSendError("duplicate flag --no-pdf");
      noPdf = true;
      continue;
    }
    const match = /^--(file|session|comment)(?:=(.*))?$/s.exec(arg);
    if (!match) throw new FileSendError("usage: slackoc send-file --file </absolute/path> --session <session-id> [--comment <text>] [--no-pdf]");
    const name = match[1]!;
    if (name in flags) throw new FileSendError(`duplicate flag --${name}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || (!value && name !== "comment") || (match[2] === undefined && value.startsWith("--"))) throw new FileSendError(`flag --${name} needs a value`);
    flags[name] = value;
  }
  if (!flags.file || !flags.session) throw new FileSendError("--file and --session are required; files are sent only to the session's existing Slack thread");
  return { file: flags.file, session: flags.session, ...(flags.comment === undefined ? {} : { comment: flags.comment }), ...(noPdf ? { noPdf } : {}) };
}

function validateOptions(opts: SendFileOptions): void {
  if (typeof opts.file !== "string" || !isAbsolute(opts.file) || /[\x00-\x1f\x7f]/.test(opts.file)) {
    throw new FileSendError("--file must be an absolute local file path without control characters");
  }
  if (typeof opts.session !== "string" || !/^ses_[\w-]+$/.test(opts.session)) throw new FileSendError("--session must be an exact OpenCode session ID");
  if (opts.comment !== undefined && (typeof opts.comment !== "string" || opts.comment.length > 2000 || opts.comment.includes("\0"))) {
    throw new FileSendError("--comment must be text of at most 2000 characters without null bytes");
  }
}

async function jsonFile(path: string, message: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new FileSendError(message); }
}

async function bindingFor(path: string, session: string): Promise<Binding> {
  const state = await jsonFile(path, "SlackOC state is missing or unreadable; no thread destination can be confirmed");
  if (record(state) && state.version !== undefined && state.version !== 1) throw new FileSendError(`SlackOC state version ${String(state.version)} is not supported; update SlackOC`);
  if (!record(state) || !record(state.threads)) throw new FileSendError("SlackOC state has invalid thread bindings");
  const matches = Object.entries(state.threads).filter(([, value]) => record(value) && value.sessionId === session);
  if (matches.length !== 1) throw new FileSendError(matches.length ? "Session has ambiguous Slack thread bindings; refusing to send" : "Current session is not bound to a Slack thread; refusing to send (no DM fallback)");
  const [key, value] = matches[0]!;
  const thread = value as Record<string, unknown>;
  const destination = /^([CDG][A-Z0-9]+):(\d{1,20}\.\d{6})$/.exec(key);
  const recovery = thread.recovery;
  if (!destination || typeof thread.projectDir !== "string" || !isAbsolute(thread.projectDir) || !record(recovery) ||
      !Number.isSafeInteger(recovery.bindingGeneration) || Number(recovery.bindingGeneration) < 1 ||
      !Number.isSafeInteger(recovery.intentVersion) || Number(recovery.intentVersion) < 0) {
    throw new FileSendError("Current session's Slack thread binding is invalid; refusing to send");
  }
  if (record(recovery.lastRun) && recovery.lastRun.sessionId === session && recovery.lastRun.outcome === "stopped") {
    throw new FileSendError("Current session was stopped; refusing to publish its file");
  }
  return { key, session, channel: destination[1]!, threadTs: destination[2]!, project: thread.projectDir,
    generation: Number(recovery.bindingGeneration), intent: Number(recovery.intentVersion) };
}

async function assertBinding(path: string, binding: Binding): Promise<void> {
  const current = await bindingFor(path, binding.session);
  if (Object.keys(binding).some(key => current[key as keyof Binding] !== binding[key as keyof Binding])) {
    throw new FileSendError("Slack thread binding changed during file sending; refusing to publish");
  }
}

/** Credential locations the agent may never ship into Slack, even with permission. */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", join(".config", "gh"), join(".local", "state", "opencode")];
const SECRET_FILES = /^(id_[a-z0-9]+(\.pub)?|.*\.(pem|p12|pfx)|\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

/** Refuse SlackOC's own token file/dir and common credential stores (symlinks resolved). */
/** Refuses SlackOC config/state, credential dirs and secret-named files (also render.ts postFilePart). */
export async function assertNotSecret(file: string, configPath: string = CONFIG_PATH): Promise<void> {
  let resolved: string;
  try { resolved = await realpath(file); } catch { throw new FileSendError("File is missing or unreadable"); }
  const home = homedir();
  const dirs = [CONFIG_DIR, ...SECRET_DIRS.map(d => join(home, d))];
  const [resolvedDirs, resolvedConfig] = await Promise.all([
    Promise.all(dirs.map(d => realpath(d).catch(() => d))), realpath(configPath).catch(() => configPath)]);
  const inside = (dir: string) => resolved === dir || resolved.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  if (resolved === resolvedConfig || resolvedDirs.some(inside) || SECRET_FILES.test(basename(resolved))) {
    throw new FileSendError("Refusing to send credentials or SlackOC configuration files");
  }
}

/** Nonblocking open rejects FIFOs/devices; descriptor checks and one extra byte bound growth.
 * Also the bounded reader for model-produced `file:` parts (render.ts postFilePart). */
export async function fileBytes(path: string, signal?: AbortSignal): Promise<Buffer> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { throw new FileSendError("File is missing or unreadable"); }
  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FileSendError("Only regular local files can be sent");
    if (!stat.size) throw new FileSendError("Cannot send an empty file");
    if (stat.size > MAX_SEND_FILE_BYTES) throw new FileSendError("File exceeds the 50 MiB SlackOC send limit");
    const data = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < data.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(data, length, Math.min(data.length - length, 1024 * 1024), null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new FileSendError("File changed while being read; finish writing it before sending");
    }
    return data.subarray(0, length);
  } catch (error) {
    if (error instanceof FileSendError || signal?.aborted) throw error;
    throw new FileSendError("File could not be read");
  } finally { await handle.close(); }
}

function completedFiles(response: unknown, count: number): string[] {
  // filesUploadV2 wraps completeUploadExternal responses, not the files themselves. One
  // destination + comment means one completion listing every file in upload order.
  if (!record(response) || response.ok !== true || !Array.isArray(response.files) || response.files.length !== 1) {
    throw new FileSendError("Slack upload completion was not confirmed; delivery may already have occurred. Check the thread before retrying");
  }
  const completion = response.files[0];
  const files = record(completion) && completion.ok === true && Array.isArray(completion.files) && completion.files.length === count ? completion.files : [];
  const ids = files.map(file => record(file) && typeof file.id === "string" && /^F[A-Z0-9]+$/.test(file.id) ? file.id : "");
  if (!ids.length || ids.includes("")) {
    throw new FileSendError("Slack did not return a confirmed file ID; delivery may already have occurred. Check the thread before retrying");
  }
  return ids;
}

/**
 * Render an .html/.htm send to PDF with headless Chrome. Never fails the send: problems become a skip reason.
 * Renders the already-checked bytes over loopback, never the file path (see withServedHtml).
 */
async function renderPdf(html: Buffer, deps: SendFileDeps): Promise<{ data: Buffer } | { skipped: string }> {
  try {
    return { data: await withTempDir(async dir => {
      const out = join(dir, "render.pdf");
      await withServedHtml(html, url => htmlToPdf(url, out, { ...deps.headless, signal: deps.signal }));
      return fileBytes(out, deps.signal); // same 50 MiB/regular-file guards as the source
    }) };
  } catch (error) {
    deps.signal?.throwIfAborted();
    if (error instanceof HeadlessError) return { skipped: error.message };
    return { skipped: error instanceof FileSendError ? `rendered PDF rejected: ${error.message}` : "PDF rendering failed" };
  }
}

function uploadError(error: unknown): Error {
  if (error instanceof FileSendError) return error;
  const data = record(error) && record(error.data) ? error.data : undefined;
  const code = data?.error;
  if (code === "missing_scope") return new FileSendError("Slack needs files:write; reinstall the Slack app with the current manifest");
  if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"].includes(String(code))) {
    return new FileSendError("Slack authentication failed; check SlackOC's saved configuration");
  }
  if (["channel_not_found", "not_in_channel", "no_permission", "posting_to_channel_denied", "file_type_not_allowed", "file_uploads_except_images_disabled"].includes(String(code))) {
    return new FileSendError(`Slack rejected the file: ${code}`);
  }
  if (code === "ratelimited" || (record(error) && error.code === "slack_webapi_rate_limited_error")) {
    const seconds = record(error) && typeof error.retryAfter === "number" && Number.isFinite(error.retryAfter) ? ` (${error.retryAfter}s Retry-After)` : "";
    return new FileSendError(`Slack rate limited the upload${seconds}; it was not retried. Check the thread before retrying`);
  }
  // Do not echo arbitrary SDK/transport errors: they can include request credentials.
  return new FileSendError("File upload failed or was canceled; delivery may already have occurred. Check the active thread before retrying");
}

export async function sendFile(opts: SendFileOptions, deps: SendFileDeps = {}): Promise<FileReceipt> {
  validateOptions(opts);
  deps.signal?.throwIfAborted();
  const statePath = deps.statePath ?? STATE_PATH;
  const binding = await bindingFor(statePath, opts.session);
  await assertNotSecret(opts.file, deps.configPath ?? CONFIG_PATH);
  const data = await fileBytes(opts.file, deps.signal);
  const config = await jsonFile(deps.configPath ?? CONFIG_PATH, "SlackOC config is missing or unreadable; run slackoc init first");
  if (!record(config) || typeof config.slackBotToken !== "string" || !config.slackBotToken.startsWith("xoxb-") ||
      typeof config.ownerSlackUserId !== "string" || !OWNER_ID_RE.test(config.ownerSlackUserId)) {
    throw new FileSendError("SlackOC configuration is invalid; run slackoc init first");
  }
  const filename = basename(opts.file);
  const started = Date.now();
  // HTML goes out with a PDF rendering first in the same message (readable on a phone); --no-pdf opts out.
  const pdf = /\.html?$/i.test(filename) && !opts.noPdf ? await renderPdf(data, deps) : undefined;
  const pdfName = filename.replace(/\.html?$/i, ".pdf");
  const uploads = [...(pdf && "data" in pdf ? [{ file: pdf.data, filename: pdfName, title: pdfName }] : []), { file: data, filename, title: filename }];
  const comment = [opts.comment ? safePayload(opts.comment) : "", pdf && "skipped" in pdf ? `No PDF: ${esc(pdf.skipped)}.` : ""].filter(Boolean).join("\n");
  // Rendering spends from the same budget, keeping the whole CLI inside the plugin's 125 s deadline.
  const timeoutMs = Math.max(1, (deps.timeoutMs ?? SLACK_UPLOAD_TIMEOUT_MS) - (Date.now() - started));
  let bindingFailure: FileSendError | undefined;
  try {
    return await withDeadline(signal => withSlackOperation(signal, timeoutMs, async () => {
      await assertBinding(statePath, binding);
      const client = new WebClient(config.slackBotToken as string, {
        ...slackWebClientOptions,
        logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} },
        fetch: async (url, init) => {
          signal.throwIfAborted();
          // The binary transfer may take minutes: check again before sharing it.
          if (new URL(url instanceof Request ? url.url : String(url)).pathname.endsWith("/files.completeUploadExternal")) {
            try { await assertBinding(statePath, binding); }
            catch (error) { if (error instanceof FileSendError) bindingFailure = error; throw error; }
            signal.throwIfAborted();
          }
          return slackWebClientOptions.fetch!(url, init);
        },
      });
      const response = await client.filesUploadV2({ channel_id: binding.channel, thread_ts: binding.threadTs,
        file_uploads: uploads, ...(comment ? { initial_comment: comment } : {}) });
      signal.throwIfAborted();
      const ids = completedFiles(response, uploads.length);
      const receipt: FileReceipt = { ok: true, sessionId: opts.session, channelId: binding.channel, threadTs: binding.threadTs,
        fileId: ids.at(-1)!, filename, bytes: data.length };
      if (pdf && "data" in pdf) receipt.pdf = { fileId: ids[0]!, filename: pdfName, bytes: pdf.data.length };
      if (pdf && "skipped" in pdf) receipt.pdfSkipped = pdf.skipped;
      return receipt;
    }), { signal: deps.signal, timeoutMs }, "file upload");
  } catch (error) { throw uploadError(bindingFailure ?? error); }
}

export async function runSendFileCommand(argv: string[]): Promise<void> {
  const opts = parseSendFileArgs(argv);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("file sending canceled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try { console.log(JSON.stringify(await sendFile(opts, { signal: controller.signal }))); }
  finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
