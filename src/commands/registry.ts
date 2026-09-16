import type { SlackocConfig } from "../config.js";
import type { ServerPool } from "../opencode/server.js";
import type { StateStore, ThreadState } from "../state.js";
import type { RenderDeps } from "../slack/render.js";
import type { ParsedCmd } from "./parse.js";

export interface CmdCtx {
  channelId: string;
  /** Root ts of the Slack thread this command arrived in. */
  threadTs: string;
  /** state key `${channel}:${threadTs}` */
  threadKey: string;
  /** Bound OpenCode session for this thread, if any. */
  thread: ThreadState | null;
  state: StateStore;
  config: SlackocConfig;
  pool: ServerPool;
  cwd: string;
  /** Bridge self-report for \status (uptime, owner-DM reachability). */
  bridgeInfo?: { startedAt: number; dmAvailable: () => boolean };
  /** Build an archives permalink for a state threadKey (`${channel}:${ts}`) — null when the team URL is unknown. */
  threadUrl?(threadKey: string): string | null;
  /** Post into the current thread/DM. */
  postToThread(text: string): Promise<void>;
  /** Upload a text file (snippet, diff…) into the current thread. */
  uploadToThread(filename: string, content: string): Promise<void>;
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

export interface CmdDef {
  name: string;
  usage: string;
  summary: string;
  /** When set, this command just forwards to the named command. */
  aliasOf?: string;
  /** Optional example/extra line shown under the summary by `\help`. */
  detail?: string;
  run(ctx: CmdCtx, args: string): Promise<void>;
}

const registry = new Map<string, CmdDef>();

export function registerCommand(def: CmdDef): void {
  registry.set(def.name, def);
}

export function getCommand(name: string): CmdDef | undefined {
  return registry.get(name.toLowerCase());
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

/** Closest registered command name: prefix match first, then edit distance ≤2. */
function closestCommand(name: string): string | undefined {
  const names = [...registry.keys()];
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
  // Aliases forward to their target command.
  const target = def.aliasOf ? getCommand(def.aliasOf) : def;
  if (!target) {
    await ctx.postToThread(`⚠️ \`\\${parsed.name}\` is broken (alias target missing).`);
    return;
  }
  try {
    await ctx.react?.("eyes");
    await target.run(ctx, parsed.args);
    await ctx.react?.("eyes", false);
    await ctx.react?.("white_check_mark");
  } catch (err) {
    await ctx.react?.("eyes", false);
    await ctx.react?.("x");
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.postToThread(`⚠️ \`\\${parsed.name}\` failed: ${msg.slice(0, 400)}`);
  }
}
