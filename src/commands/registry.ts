import type { SocketHealth } from "../slack/socket-supervisor.js";
import type { SlackocConfig } from "../config.js";
import type { ServerPool } from "../opencode/server.js";
import type { StateStore, ThreadState } from "../state.js";
import type { RenderDeps } from "../slack/render.js";
import type { ParsedCmd } from "./parse.js";
import type { PermissionResponseInput, PermissionResponseResult } from "../slack/permissions.js";
import type { PromptStore } from "../prompts.js";

export interface PermissionCommands {
  list(context: PermissionResponseInput["context"], refresh?: boolean): Promise<string>;
  respond(input: PermissionResponseInput): Promise<PermissionResponseResult>;
}

export interface CmdCtx {
  channelId: string;
  /** Root ts of the Slack thread this command arrived in. */
  threadTs: string;
  /** state key `${channel}:${threadTs}` */
  threadKey: string;
  messageTs?: string;
  source?: "live" | "history";
  ownerDm?: boolean;
  schedules?: ScheduleCommands;
  permissions?: PermissionCommands;
  /** Saved prompts (D1: \save, \run, \saved). */
  prompts?: PromptStore;
  questions?(context: { threadKey: string } | { dm: true }, beforeRefresh?: (status: string) => Promise<void>): Promise<string | void>;
  resumeQuestions?(context: { threadKey: string; sessionId: string; generation: number; ownerTs: string }): Promise<void>;
  /** Bound OpenCode session for this thread, if any. */
  thread: ThreadState | null;
  state: StateStore;
  config: SlackocConfig;
  pool: ServerPool;
  cwd: string;
  /** Bridge self-report for \status (uptime, owner-DM reachability). */
  bridgeInfo?: { startedAt: number; dmAvailable: () => boolean; socket?: () => SocketHealth | undefined };
  /** Build an archives permalink for a state threadKey (`${channel}:${ts}`) — null when the team URL is unknown. */
  threadUrl?(threadKey: string): string | null;
  /** Post into the current thread/DM; `blocks` (optional) carry interactive controls. */
  postToThread(text: string, blocks?: unknown[]): Promise<void>;
  /** Upload a text snippet (diff…) or binary file (\shot PNG/PDF) into the current thread. */
  uploadToThread(filename: string, content: string | Buffer, comment?: string): Promise<void>;
  /**
   * Best-effort liveness ack on the command's own message (👀 → ✅/❌), mirroring
   * the prompt path. add=false removes the reaction. Optional so non-Slack
   * contexts (tests) can omit it.
   */
  react?(name: string, add?: boolean): Promise<void>;
  /**
   * Raw render deps — only \watch needs them (it constructs a live SessionView).
   * Optional everywhere else so non-Slack contexts (tests) can omit it.
   */
  render?: RenderDeps;
}

/** Scheduled work has its own authority and never masquerades as owner input. */
export interface ScheduleCommands {
  run(ctx: CmdCtx, args: string): Promise<void>;
  busy(threadKey: string): boolean;
  cancelThread(threadKey: string): Promise<void>;
}

export interface CmdDef {
  name: string;
  usage: string;
  summary: string;
  /** Extra names that run this command (e.g. \abort → \stop); shown in `\help`. */
  aliases?: string[];
  /** Optional example/extra line shown under the summary by `\help`. */
  detail?: string;
  /** Usable in a thread while its scheduled report runs (report controls and read-only views). */
  duringReport?: boolean;
  /**
   * Replaces the thread's session binding, so recovery replay of earlier
   * messages is canceled as superseded: always, or only when given arguments.
   */
  rebinds?: "always" | "withArgs";
  /** Resolve "view" when the command's message now belongs to a SessionView run, whose finalize sets ✅/❌. */
  run(ctx: CmdCtx, args: string): Promise<void | "view">;
}

const registry = new Map<string, CmdDef>();
/** alias → canonical command name. */
const aliasMap = new Map<string, string>();

/** Throws if the name or any alias is already taken by a command or alias. */
export function registerCommand(def: CmdDef): void {
  const names = [def.name, ...(def.aliases ?? [])];
  for (const [i, n] of names.entries()) {
    if (registry.has(n) || aliasMap.has(n) || names.indexOf(n) !== i)
      throw new Error(`command name collision: \\${n}`);
  }
  registry.set(def.name, def);
  for (const a of def.aliases ?? []) aliasMap.set(a, def.name);
}

/** Canonical command name for `name` (alias-aware), or `name` unchanged if unknown. */
export function resolveCommandName(name: string): string {
  return aliasMap.get(name.toLowerCase()) ?? name;
}

export function getCommand(name: string): CmdDef | undefined {
  const n = name.toLowerCase();
  return registry.get(aliasMap.get(n) ?? n);
}

export function allCommands(): CmdDef[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Levenshtein distance over single-char insert/delete/replace. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** Closest typeable name (commands, then aliases): prefix match first, then edit distance ≤2. */
function closestCommand(name: string): string | undefined {
  const names = [...registry.keys(), ...aliasMap.keys()];
  const prefix = names.find((n) => n.startsWith(name) || name.startsWith(n));
  if (prefix) return prefix;
  let best: string | undefined;
  let bestD = 3;
  for (const n of names) {
    const d = editDistance(name, n);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

export async function execute(parsed: ParsedCmd, ctx: CmdCtx): Promise<void> {
  const def = getCommand(parsed.name);
  if (!def) {
    const near = closestCommand(parsed.name);
    await ctx.postToThread(
      near
        ? `Unknown command \`\\${parsed.name}\` — did you mean \`\\${near}\`? (\`\\help\` lists all commands.)`
        : `Unknown command \`\\${parsed.name}\` — try \`\\help\`.`,
    );
    return;
  }
  try {
    await ctx.react?.("eyes");
    if (await def.run(ctx, parsed.args) === "view") return; // the view's finalize resolves 👀
    await ctx.react?.("eyes", false);
    await ctx.react?.("white_check_mark");
  } catch (err) {
    await ctx.react?.("eyes", false);
    await ctx.react?.("x");
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.postToThread(`⚠️ \`\\${parsed.name}\` failed: ${msg.slice(0, 400)}`);
  }
}
