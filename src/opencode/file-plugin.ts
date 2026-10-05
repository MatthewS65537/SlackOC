import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { Info } from "@opencode/plugin/promise/tool";

export const FILE_SEND_TIMEOUT_MS = 125_000;
export const FILE_SEND_OUTPUT_LIMIT = 16 * 1024;
export const FILE_SEND_KILL_GRACE_MS = 1_000;

interface FileSendInput {
  path: string;
  comment?: string;
}

interface FileSendReceipt {
  ok: true;
  sessionId: string;
  fileId: string;
  channelId: string;
  threadTs: string;
  filename: string;
  bytes: number;
}

function validateInput(input: unknown): FileSendInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected an absolute file path and optional comment.");
  }
  if (Reflect.ownKeys(input).some(key => key !== "path" && key !== "comment")) {
    throw new Error("Only path and comment are accepted; the current session supplies the destination.");
  }
  const value = input as Record<string, unknown>;
  if (!Object.hasOwn(value, "path") || typeof value.path !== "string" ||
    !isAbsolute(value.path) || /[\x00-\x1f\x7f]/.test(value.path)) {
    throw new Error("path must be an absolute local file path.");
  }
  if (value.comment !== undefined && (typeof value.comment !== "string" || value.comment.length > 2000 || value.comment.includes("\0"))) {
    throw new Error("comment must be a string of at most 2000 characters without null bytes.");
  }
  return { path: value.path, comment: value.comment as string | undefined };
}

function uncertain(reason: string): Error {
  return new Error(`${reason} Delivery is uncertain and the file may already have been sent. Check the active Slack thread before retrying; do not automatically resend.`);
}

function validateReceipt(stdout: string, sessionId: string): FileSendReceipt {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw uncertain("slackoc returned an invalid upload receipt."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw uncertain("slackoc returned an invalid upload receipt.");
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.ok !== true || receipt.sessionId !== sessionId ||
    typeof receipt.fileId !== "string" || !/^F[A-Z0-9]+$/.test(receipt.fileId) ||
    typeof receipt.channelId !== "string" || !/^[CGD][A-Z0-9]+$/.test(receipt.channelId) ||
    typeof receipt.threadTs !== "string" || !/^[1-9]\d*\.\d{6}$/.test(receipt.threadTs) ||
    typeof receipt.filename !== "string" || !receipt.filename || /[/\x00-\x1f\x7f]/.test(receipt.filename) ||
    !Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 1 || Number(receipt.bytes) > 50 * 1024 * 1024) {
    throw uncertain("slackoc did not confirm a valid upload for the current session's thread.");
  }
  return { ok: true, sessionId, fileId: receipt.fileId, channelId: receipt.channelId, threadTs: receipt.threadTs,
    filename: receipt.filename, bytes: Number(receipt.bytes) };
}

function runFileCommand(args: string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("File send canceled before starting. No file was sent."));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("slackoc", args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      reject(new Error("Unable to start slackoc send-file. Check that the installed CLI is on OpenCode's PATH."));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const kill = (signal: NodeJS.Signals) => {
      try { child.kill(signal); } catch { /* Still escalate and bound cleanup if termination fails. */ }
    };
    const stop = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      // Give the CLI a moment to abort its upload, then force termination without an unbounded wait.
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        if (!settled) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish(failure);
        }
      }, FILE_SEND_KILL_GRACE_MS);
      kill("SIGTERM");
    };
    const collect = (chunks: Buffer[], chunk: Buffer | string) => {
      if (settled || failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > FILE_SEND_OUTPUT_LIMIT) {
        stop(uncertain("slackoc exceeded the subprocess output limit."));
        return;
      }
      chunks.push(bytes);
    };
    const onStdout = (chunk: Buffer | string) => collect(stdout, chunk);
    const onStderr = (chunk: Buffer | string) => collect(stderr, chunk);
    const onAbort = () => stop(uncertain("File send canceled during execution."));
    const onError = (error: NodeJS.ErrnoException) => {
      if (child.pid === undefined) {
        finish(new Error(error.code === "ENOENT"
          ? "slackoc is not installed or is not on OpenCode's PATH. No file was sent."
          : "Unable to start slackoc send-file. Check the installed CLI and OpenCode's PATH."));
      } else {
        stop(uncertain("The slackoc subprocess failed during execution."));
      }
    };
    const onClose = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (failure) { finish(failure); return; }
      if (code !== 0 || exitSignal) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(uncertain(`slackoc send-file failed (${exitSignal ?? `exit ${code}`}).${detail ? ` ${detail}` : ""}`));
        return;
      }
      finish();
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    deadline = setTimeout(() => stop(uncertain("File send exceeded its execution deadline.")), FILE_SEND_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export const fileSendTool: Info = {
  name: "slackoc_send_file",
  description: "Send one local file (up to 50 MiB) to this session's existing active Slack thread. The session supplies the destination; no separate DM is opened. Return a confirmed receipt, not file content. Never automatically retry uncertain delivery.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Absolute path to the finished local file to send." },
      comment: { type: "string", maxLength: 2000, description: "Optional text accompanying this file in the active thread." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  options: { permission: "slackoc.send_file" },
  async execute(input, context) {
    const value = validateInput(input);
    const sessionId: string = context.sessionID;
    if (typeof sessionId !== "string" || !/^ses_[\w-]+$/.test(sessionId)) {
      throw new Error("The native executor did not supply a valid current session ID. No file was sent.");
    }
    const args = ["send-file", "--file", value.path, "--session", sessionId];
    if (value.comment !== undefined) args.push(`--comment=${value.comment}`);
    const receipt = validateReceipt(await runFileCommand(args, context.signal), sessionId);
    return { content: JSON.stringify(receipt) };
  },
};

const plugin: Plugin = {
  id: "slackoc-files",
  async setup(context) {
    const registration = await context.tool.transform(editor => editor.add(fileSendTool));
    return () => registration.dispose();
  },
};

export default plugin;
