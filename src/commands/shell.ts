import { sessionCreate, sessionShell, shellMessages, type OCClient } from "../opencode/client.js";
import { canonicalDir } from "../paths.js";
import { getView } from "../slack/render.js";
import { safeCodePayload } from "../slack/tool-format.js";
import { truncate } from "../util.js";
import type { ThreadState } from "../state.js";
import type { CmdCtx, CmdDef } from "./registry.js";
import { isPreparingWorktree, STILL_PREPARING } from "./worktrees.js";

/**
 * `\! <command>`: OpenCode V2's session.shell, the TUI's `!`. One command runs
 * in the session's folder with no model; its output joins the session's
 * context, so the next prompt can refer to it. Owner-only like every command:
 * the same trust as the owner's terminal.
 */

const USAGE = "\\! <command>";
/** Output up to this many characters posts as a code block; longer output is uploaded as a snippet. */
export const SHELL_INLINE_MAX = 3_500;
/** While waiting for `session.shell.ended`, check the transcript this often (an event lost to a reconnect). */
const POLL_MS = 5_000;
/** Stop waiting; OpenCode's own shell timeout normally ends a command long before. */
const MAX_WAIT_MS = 60 * 60_000;

export interface ShellResult { status: string; exit?: number; output: string; truncated: boolean }

/** sessionID → the waiting `\!`'s resolver. One shell per session at a time (`running`). */
const waiters = new Map<string, (r: ShellResult) => void>();
const running = new Set<string>();

/** The bridge's event switchboard (start.ts) hands every translated `session.shell` event here. */
export function noteShellEvent(props: Record<string, unknown>): void {
  if (props.phase !== "ended" || typeof props.sessionID !== "string") return;
  waiters.get(props.sessionID)?.({ status: String(props.status ?? "exited"), exit: typeof props.exit === "number" ? props.exit : undefined,
    output: typeof props.output === "string" ? props.output : "", truncated: props.truncated === true });
}

/**
 * Run `command` and wait for its result: the ended event, or (when that event
 * was lost) the shell message in the transcript. Null after `maxWaitMs`.
 */
export async function runShell(c: OCClient, sessionId: string, command: string,
  opts: { pollMs?: number; maxWaitMs?: number } = {}): Promise<ShellResult | null> {
  const since = Date.now();
  let settle!: (r: ShellResult) => void;
  const ended = new Promise<ShellResult>((resolve) => { settle = resolve; });
  waiters.set(sessionId, settle); // before the request: the event may beat its response
  try {
    await sessionShell(c, sessionId, command);
    while (Date.now() - since < (opts.maxWaitMs ?? MAX_WAIT_MS)) {
      let timer: NodeJS.Timeout | undefined;
      const tick = new Promise<null>((resolve) => { timer = setTimeout(resolve, opts.pollMs ?? POLL_MS, null); });
      const hit = await Promise.race([ended, tick]);
      clearTimeout(timer);
      if (hit) return hit;
      const row = (await shellMessages(c, sessionId).catch(() => []))
        .find((m) => m.status !== "running" && m.command === command && m.time.created >= since - 2_000);
      if (row) return { status: row.status, exit: typeof row.exit === "number" ? row.exit : undefined,
        output: row.output?.output ?? "", truncated: row.output?.truncated ?? false };
    }
    return null;
  } finally {
    if (waiters.get(sessionId) === settle) waiters.delete(sessionId);
  }
}

/** Terminal color/cursor escapes (e.g. from test runners) are noise in Slack. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** `$ cmd · exit 1` plus a code block, or a snippet when the output is long. */
export function shellReply(command: string, r: ShellResult): { text: string } | { snippet: string; comment: string } {
  const first = command.split("\n", 1)[0]!;
  const bits = [`\`$ ${safeCodePayload(truncate(first, 150) + (first !== command ? " …" : ""))}\``];
  if (r.status === "timeout") bits.push("timed out");
  else if (r.status === "killed") bits.push("killed");
  if (r.exit !== undefined && r.exit !== 0) bits.push(`exit ${r.exit}`);
  if (r.truncated) bits.push("output truncated by OpenCode");
  const out = r.output.replace(ANSI, "").trimEnd();
  if (!out) return { text: [...bits, "no output"].join(" · ") };
  const header = bits.join(" · ");
  if (out.length > SHELL_INLINE_MAX) return { snippet: out, comment: header };
  return { text: `${header}\n\`\`\`\n${safeCodePayload(out, true)}\n\`\`\`` };
}

/**
 * The command the owner meant. Args come through slackToPlain, which decodes
 * entities and turns autolinks into [label](url) outside code but passes code
 * spans/fences through raw. So a command typed as one ```fence``` (optionally
 * with a shell language tag line) or one `span` is unwrapped and its entities
 * decoded here, exactly once (&amp; last); its backticks never reach the
 * shell as command substitution. Anything else is used as is.
 */
export function shellCommandText(args: string): string {
  const s = args.trim();
  const fence = /^```(?:(?:bash|sh|shell|zsh|fish|console)?[ \t]*\n)?([\s\S]*?)\n?```$/i.exec(s)?.[1];
  const code = fence !== undefined && !fence.includes("```") ? fence : /^`([^`\n]+)`$/.exec(s)?.[1];
  if (code !== undefined) return code.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  // slackToPlain turns Slack's autolinks into [label](url): what the owner typed is the label.
  return s.replace(/\[([^\]]+)\]\((?:https?|mailto):[^)\s]+\)/g, "$1").trim();
}

export async function runShellCommand(ctx: CmdCtx, args: string): Promise<void> {
  const command = shellCommandText(args);
  if (!command) throw new Error(`usage: \`${USAGE}\``);
  // A session made now would be orphaned when \new --wt / \fork --wt binds the worktree.
  if (isPreparingWorktree(ctx.threadKey)) {
    await ctx.postToThread(STILL_PREPARING);
    return;
  }
  let th: ThreadState | null = ctx.thread;
  if (th?.scheduledRunId) {
    await ctx.postToThread("Scheduled-report threads don't run shell commands.");
    return;
  }
  if (th?.watchOnly) throw new Error("this thread is watch-only — `\\resume` to take the session over first");
  if (th && getView(th.sessionId)) {
    await ctx.postToThread("A run is active — use `\\stop` first.");
    return;
  }
  if (th && running.has(th.sessionId)) {
    await ctx.postToThread("A shell command is already running here — wait for its output.");
    return;
  }
  if (!th) {
    // Like a prompt: an unbound owner DM gets a fresh session in the default project.
    if (!ctx.ownerDm) throw new Error("no session bound to this thread yet — send a prompt first");
    const dir = canonicalDir(ctx.state.defaultDir(ctx.channelId, ctx.cwd));
    const lease = await ctx.pool.acquire(dir);
    try {
      const sess = await sessionCreate(lease.entry.client!, truncate(`! ${command}`, 60));
      const now = Date.now();
      th = { sessionId: sess.id, projectDir: dir, verbose: ctx.state.channelVerbose(ctx.channelId), createdAt: now, lastUsedAt: now };
      ctx.state.setThread(ctx.threadKey, th);
    } finally { lease.release(); }
  }
  const { sessionId } = th;
  running.add(sessionId);
  try {
    const client = (await ctx.pool.ensure(th.projectDir)).client!;
    const result = await runShell(client, sessionId, command);
    if (!result) {
      await ctx.postToThread("⏳ Still running after an hour. Its output joins the session's context when it ends.");
      return;
    }
    const reply = shellReply(command, result);
    if ("text" in reply) await ctx.postToThread(reply.text);
    else await ctx.uploadToThread("shell-output.txt", reply.snippet, reply.comment);
  } finally {
    running.delete(sessionId);
  }
}

export const shellCommand: CmdDef = {
  name: "!",
  aliases: ["sh"],
  usage: USAGE,
  summary: "Run a shell command on this machine as your user (owner-only), no model",
  detail: "Runs in this thread's session folder with your user's permissions, the same trust as your terminal. The output joins the session's context, so your next prompt can refer to it. Refused while a run is active (`\\stop` first) and in scheduled-report threads. Output over 3,500 characters arrives as a snippet.",
  run: (ctx, args) => runShellCommand(ctx, args),
};
