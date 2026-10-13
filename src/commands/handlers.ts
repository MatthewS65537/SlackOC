import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { OcFileDiff, OcMessageInfo, OcPart } from "../opencode/api.js";
import type { OCClient } from "../opencode/api.js";
import type { PoolEntry } from "../opencode/server.js";
import {
  agentsList,
  cancelParkedPrompts,
  commandList,
  configGet,
  configProviders,
  promptAsync,
  revertStage,
  sessionAbort,
  sessionCommand,
  sessionCreate,
  sessionDelete,
  sessionDiff,
  sessionFork,
  sessionGet,
  sessionMessages,
  sessionMove,
  sessionStats,
  projectId,
} from "../opencode/client.js";
import type { CmdCtx, CmdDef } from "./registry.js";
import { allCommands, getCommand, registerCommand } from "./registry.js";
import { cacheProjectList, projectListSnapshot, invalidateProjectList, invalidatePickerCache, pickerList, pickerResolve, renderPickerList, type SessionRef } from "./picker.js";
import { canonicalDir, expandHome } from "../paths.js";
import { chunkText, dur, esc, mdToMrkdwn, partsText, shortId, shortPath, truncate } from "../util.js";
import type { ThreadState, VerboseMode } from "../state.js";
import { deleteView, getView, SessionView, describeActiveRuns, finalizeViewsForProject, sessionContextPct } from "../slack/render.js";
import { droppedOpCount, oldestPendingAgeMs, queueDepth } from "../slack/queue.js";
import { fileLogPath, logCount, logErr, newLogsSince, recentLogs } from "../log.js";
import { parsePermissionCommand } from "../slack/permissions.js";
import { SCHEDULE_USAGE } from "../schedules/controls.js";
import { modelSearchBlocks, pickerBlocks, revertCardBlocks, viewDiffBlocks } from "../slack/blocks.js";
import { modelOption, orderedModels, readFavorites } from "../opencode/favorites.js";
import { buildUnifiedDiff, formatDiffSummary } from "../slack/diff-view.js";
import { USAGE_RANGES, dayKeys, formatUsage, parseUsageArgs, rangeStart } from "./usage.js";
import { shotCommand } from "./shot.js";
import { shipCommand } from "./ship.js";
import { shellCommand } from "./shell.js";
import { prepareWorktree, sameProject, takeWtFlag, worktreesCommand } from "./worktrees.js";
import { runCommand, saveCommand, savedCommand, unsaveCommand } from "./prompts.js";

function requireThread(ctx: CmdCtx): NonNullable<CmdCtx["thread"]> {
  if (!ctx.thread) throw new Error("no session bound to this thread yet — send a prompt first");
  return ctx.thread;
}

async function withServerLease<T>(ctx: CmdCtx, dir: string, work: (entry: PoolEntry) => Promise<T>): Promise<T> {
  const lease = await ctx.pool.acquire(canonicalDir(dir));
  try { return await work(lease.entry); }
  finally { lease.release(); }
}

/** Absolute, `~`, or relative to this thread's project (not the bridge's launch dir); must be an existing directory (#48). */
function requireDir(ctx: CmdCtx, dir: string): string {
  const base = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
  const abs = resolve(base, expandHome(dir));
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`${abs} is not a directory`);
  return canonicalDir(abs);
}

function newThreadState(sessionId: string, projectDir: string, verbose: VerboseMode = "on"): ThreadState {
  const now = Date.now();
  return { sessionId, projectDir: canonicalDir(projectDir), verbose, createdAt: now, lastUsedAt: now };
}

/** Newest in-flight rebind per thread key (see rebindThread). */
const latestRebind = new Map<string, symbol>();

/**
 * Point a thread at a fresh session in `dir`. By default (teardown) the old
 * binding is destroyed completely: the previous OpenCode session is aborted +
 * deleted on its own server and the stale SessionView is dropped, so no SSE
 * event or finalize from the old project can leak into this thread afterwards.
 * With `teardown: false` (\new) the old session is only unbound — it stays on
 * its server, listed by \sessions and recoverable via \resume.
 *
 * Only the thread's newest rebind may act after an await: an older, slower one
 * (or one whose binding changed underneath it) skips its remaining teardown and
 * never commits, so it cannot undo newer owner intent.
 */
async function rebindThread(
  ctx: CmdCtx,
  dir: string,
  note: string,
  opts: { teardown?: boolean } = {},
): Promise<void> {
  dir = canonicalDir(dir);
  const old = ctx.thread;
  const token = Symbol("rebind");
  latestRebind.set(ctx.threadKey, token);
  const boundId = ctx.state.getThread(ctx.threadKey)?.sessionId;
  const current = () => latestRebind.get(ctx.threadKey) === token
    && ctx.state.getThread(ctx.threadKey)?.sessionId === boundId;
  ctx.state.cancelRecovery(ctx.threadKey, ctx.messageTs, true);
  try {
    if (old) {
      if (opts.teardown !== false) {
        try {
          await withServerLease(ctx, old.projectDir, async (oldEntry) => {
            await sessionAbort(oldEntry.client!, old.sessionId).catch(() => {});
            await sessionDelete(oldEntry.client!, old.sessionId).catch(() => {});
          });
          // Kill the server ONLY when no other thread still uses this project —
          // opencode serve is shared per dir, and killing it would destroy
          // other threads' in-flight runs. Sessions persist on disk anyway.
          if (current() && !ctx.state.anyThreadInDir(old.projectDir, ctx.threadKey)) {
            await ctx.pool.killOne(old.projectDir).catch(() => {});
          }
        } catch {
          /* old server may already be gone */
        }
      }
      if (current()) deleteView(old.sessionId);
    }
    const sess = await withServerLease(ctx, dir, (entry) => sessionCreate(entry.client!, `SlackOC ${new Date().toISOString().slice(0, 16)}`));
    if (!current()) {
      await ctx.postToThread("⏭ Superseded by a newer command — this thread keeps its current session.");
      return;
    }
    ctx.state.setThread(ctx.threadKey, newThreadState(sess.id, dir, ctx.state.channelVerbose(ctx.channelId)));
    // The old binding's native Slack session ends here; the next run reopens it.
    void ctx.render?.sessionStatus?.(ctx.channelId, ctx.threadTs, "closed");
    const kept =
      opts.teardown === false && old
        ? ` Previous session \`${shortId(old.sessionId)}\` kept — \`\\resume\` brings it back.`
        : "";
    await ctx.postToThread(`${note} Fresh session \`${shortId(sess.id)}\` in \`${dir}\`. Reply here to drive it.${kept}`);
  } finally {
    if (latestRebind.get(ctx.threadKey) === token) latestRebind.delete(ctx.threadKey);
  }
}

/** Grouping + order for `\help`; every registered command must appear here. */
export const HELP_SECTIONS: Array<{ title: string; names: string[] }> = [
  { title: "Threads & replies", names: ["hush", "listen", "verbose", "stream"] },
  { title: "Sessions", names: ["new", "sessions", "resume", "stop", "diff", "ship", "fork", "undo"] },
  { title: "Monitoring", names: ["watch", "unwatch", "history", "summary", "usage"] },
  { title: "Look", names: ["shot"] },
  { title: "Saved prompts", names: ["save", "run", "saved", "unsave"] },
  { title: "Model & agent", names: ["model", "agent"] },
  { title: "Projects", names: ["project", "cd", "pin", "unpin", "worktrees"] },
  { title: "Notifications", names: ["notify", "schedule"] },
  { title: "Approvals & questions", names: ["permissions", "permission", "questions"] },
  { title: "Raw OpenCode", names: ["cmd", "!"] },
  { title: "Bridge", names: ["status", "logs", "restart", "help"] },
];

/** One `\help` line; aliases trail the summary so long usages stay readable. */
function helpLine(def: CmdDef): string {
  const aliases = def.aliases?.length ? ` _(also ${def.aliases.map((a) => `\\${a}`).join(", ")})_` : "";
  return `\`${def.usage}\` — ${def.summary}${aliases}`;
}

registerCommand({
  name: "help", duringReport: true,
  usage: "\\help [command]",
  summary: "Show this list, or one command's details",
  async run(ctx, args) {
    // \help <cmd|alias>: the one place a command's multi-line detail is shown.
    if (args) {
      const c = getCommand(args.replace(/^\\/, ""));
      if (!c) throw new Error(`unknown command \`${args}\``);
      await ctx.postToThread(c.detail ? `${helpLine(c)}\n${c.detail}` : helpLine(c));
      return;
    }
    const cmds = new Map(allCommands().map((c) => [c.name, c]));
    const lines = ["*SlackOC* — owner-only `\\` commands. `\\help <command>` for details."];
    for (const sec of HELP_SECTIONS) {
      lines.push("", `*${sec.title}*`);
      for (const name of sec.names) {
        const c = cmds.get(name);
        if (c) lines.push(helpLine(c));
      }
    }
    await ctx.postToThread(lines.join("\n"));
  },
});

registerCommand({
  name: "status", duringReport: true,
  usage: "\\status",
  summary: "Project, thread binding, server health",
  async run(ctx) {
    const pool = ctx.pool.list();
    const th = ctx.thread;
    const ctxPct = th ? sessionContextPct(th.sessionId) : undefined; // E3: context window used (unknown after a restart)
    const lines = [
      `*Project:* \`${ctx.state.defaultDir(ctx.channelId, ctx.cwd)}\``,
      ...(ctx.state.channelProject(ctx.channelId) ? [`*Pinned:* \`${ctx.state.channelProject(ctx.channelId)}\``] : []),
      `*Thread:* ${th ? `session \`${shortId(th.sessionId)}\` in \`${th.projectDir}\` · verbose=\`${th.verbose}\`${th.model ? ` · model=\`${th.model}\`` : ""}${th.agent ? ` · agent=\`${th.agent}\`` : ""}${ctxPct !== undefined ? ` · ctx ${ctxPct}%` : ""}${th.hushed ? " · :mute: hushed" : ""}` : "no session bound (next message creates one)"}`,
      `*Pool:* ${pool.length ? pool.map((s) => `\`${s.dir}\` (${s.status}${s.url ? ` ${s.url}` : ""})`).join(", ") : "no servers running yet (they spawn lazily on first use)"}`,
    ];
    if (ctx.bridgeInfo) {
      lines.push(
        `*Bridge:* up ${dur(Date.now() - ctx.bridgeInfo.startedAt)} · owner DMs ${ctx.bridgeInfo.dmAvailable() ? ":white_check_mark:" : ":x: unavailable (notifications off)"}`,
      );
      const socket = ctx.bridgeInfo.socket?.();
      if (socket?.reconnects) {
        lines.push(`*Slack socket:* ${socket.reconnects} reconnect(s) since boot${socket.lastError ? ` · last error: ${truncate(socket.lastError, 120)}` : ""}`);
      }
    }
    // Runs in flight — the phone-at-a-glance answer to "what's it doing now?"
    const runs = describeActiveRuns();
    if (runs.length) {
      lines.push("", "*Runs in flight:*");
      for (const r of runs) {
        const link = ctx.threadUrl?.(r.threadKey);
        lines.push(
          `• *${projectName(r.projectDir)}* — ${dur(r.elapsedMs)}${r.queued ? ` (${r.queued} queued)` : ""}${link ? ` · <${link}|thread>` : ""}`,
        );
      }
    }
    const qd = queueDepth();
    const dropped = droppedOpCount();
    // Oldest-op age is the queue-health signal: a high number = the bridge is
    // behind (a torrent run or a slow Slack); a low one = replies are snappy.
    const oldest = qd ? oldestPendingAgeMs() : 0;
    if (qd || dropped) lines.push(`*Slack queue:* ${qd} pending${oldest ? ` (oldest ${dur(oldest)})` : ""} · ${dropped} dropped`);
    const recovery = ctx.state.recoveryStatus();
    if (recovery.paused || recovery.uncertain) lines.push(`*Recovery:* ${recovery.paused ? "paused (receipt capacity) · " : ""}${recovery.uncertain} uncertain · ${recovery.receipts} receipts retained; uncertain work is not automatically replayed.`);
    lines.push(`*Replay (72h maximum):* ${recovery.recovered} recovered · ${recovery.held} held · ${recovery.expired} expired · ${recovery.canceled} canceled`);
    for (const r of recovery.threads.filter(r => r.recent && r.decision === "held").slice(0, 5)) {
      const url = ctx.threadUrl?.(r.key);
      lines.push(`• ${url ? `<${url}|Held thread>` : `Held ${r.key}`} — ${r.reason.replaceAll("_", " ")}; send a fresh instruction after checking the session.`);
    }
    if (ctx.permissions) lines.push(await ctx.permissions.list(ctx.ownerDm ? { dm: true } : { threadKey: ctx.threadKey }));
    await ctx.postToThread(lines.join("\n"));
  },
});

registerCommand({
  name: "permissions", duringReport: true, usage: "\\permissions", summary: "Pending approvals and delivery status",
  async run(ctx) {
    if (!ctx.permissions) throw new Error("permission service unavailable");
    for (const text of chunkText(await ctx.permissions.list(ctx.ownerDm ? { dm: true } : { threadKey: ctx.threadKey }, true))) await ctx.postToThread(text);
  },
});

registerCommand({
  name: "permission", duringReport: true, usage: "\\permission <request-id> once|deny|always", summary: "Answer an approval by text",
  async run(ctx, args) {
    const parsed = parsePermissionCommand(args);
    if (!parsed) throw new Error("use \\permission <request-id> once|deny|always; \\permissions lists requests");
    if (!ctx.permissions) throw new Error("permission service unavailable");
    const result = await ctx.permissions.respond({ ...parsed, actor: ctx.config.ownerSlackUserId,
      context: ctx.ownerDm ? { dm: true } : { threadKey: ctx.threadKey }, source: ctx.source ?? "live" });
    await ctx.postToThread(result.text);
  },
});

registerCommand({
  name: "questions", duringReport: true, aliases: ["question"], usage: "\\questions", summary: "Recover pending question cards",
  async run(ctx) {
    if (!ctx.questions) throw new Error("question service unavailable");
    const status = await ctx.questions(ctx.ownerDm ? { dm: true } : { threadKey: ctx.threadKey }, text => ctx.postToThread(text));
    if (status) await ctx.postToThread(status);
  },
});

registerCommand({
  name: "hush",
  usage: "\\hush",
  summary: "Toggle quiet mode in this thread",
  detail: "While hushed, plain messages here are ignored; \\ commands still work; @-mentioning the bot wakes it.",
  async run(ctx) {
    const th = requireThread(ctx);
    const next = !th.hushed;
    if (next) ctx.state.cancelRecovery(ctx.threadKey, ctx.messageTs);
    ctx.state.setThread(ctx.threadKey, { ...th, hushed: next });
    await ctx.postToThread(
      next
        ? "🤫 Hushed — I'll stay quiet in this thread until you `\\hush` again or @ me."
        : "🔔 Awake — I'll keep replying in this thread.",
    );
  },
});

registerCommand({
  name: "listen",
  usage: "\\listen [on|off]",
  summary: "Answer every message in this channel, no @",
  detail: "Off by default; bare `\\listen` toggles. Applies to the whole channel: each top-level message starts its own thread. DMs always listen.",
  async run(ctx, args) {
    if (ctx.channelId.startsWith("D")) {
      await ctx.postToThread("DMs always listen already — no @ needed here.");
      return;
    }
    // Bare \listen toggles; on/off set explicitly.
    const arg = args.toLowerCase() || (ctx.state.isAlwaysOn(ctx.channelId) ? "off" : "on");
    if (arg !== "on" && arg !== "off") throw new Error("usage: \\listen [on|off]");
    ctx.state.setAlwaysOn(ctx.channelId, arg === "on");
    await ctx.postToThread(arg === "on"
      ? "👂 Listening — every message you post in this channel starts a session, no @ needed. `\\listen` again to stop."
      : "Back to @-only in this channel.");
  },
});

registerCommand({
  name: "verbose",
  usage: "\\verbose [on|off|full]",
  summary: "Tool-call visibility in this channel",
  detail: "Applies to every thread in the channel. `on` posts a line per tool call · `full` adds output snippets · `off` silences.",
  async run(ctx, args) {
    const arg = args.toLowerCase();
    if (!arg) {
      await ctx.postToThread(`Tool visibility in this channel: \`${ctx.state.channelVerbose(ctx.channelId)}\` (default \`on\` · \`full\` adds output snippets · \`off\` silences)`);
      return;
    }
    if (!["on", "off", "full"].includes(arg)) throw new Error("usage: \\verbose on|off|full");
    for (const sessionId of ctx.state.setChannelVerbose(ctx.channelId, arg as VerboseMode)) getView(sessionId)?.setVerbose(arg as VerboseMode);
    await ctx.postToThread(`🔧 Tool visibility in this channel set to \`${arg}\`.`);
  },
});

registerCommand({
  name: "notify",
  usage: "\\notify [on|off]",
  summary: "DM when runs here finish",
  detail: "Only successful completions are DMed; failures stay in the thread. Permission asks and questions are always mirrored to your DMs with working buttons — approve from anywhere.",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const arg = args.toLowerCase();
    if (!arg) {
      await ctx.postToThread(
        `Completion DMs here: \`${th.notify ? "on" : "off"}\` (failures stay in this thread; permission asks and questions always reach your DMs)`,
      );
      return;
    }
    if (arg !== "on" && arg !== "off") throw new Error("usage: \\notify on|off");
    ctx.state.setThread(ctx.threadKey, { ...th, notify: arg === "on" });
    await ctx.postToThread(arg === "on" ? "🔔 I'll DM you when runs in this thread finish." : "🔕 Completion DMs off — permission asks and questions still reach your DMs; failures show in this thread.");
  },
});

registerCommand({
  name: "stream",
  usage: "\\stream [on|off]",
  summary: "Stream answers by paragraph",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const arg = args.toLowerCase();
    const on = th.stream !== false;
    if (!arg) {
      await ctx.postToThread(`Live answers here: \`${on ? "on" : "off"}\``);
      return;
    }
    if (arg !== "on" && arg !== "off") throw new Error("usage: \\stream on|off");
    ctx.state.setThread(ctx.threadKey, { ...th, stream: arg === "on" });
    await ctx.postToThread(arg === "on" ? "Answers will post paragraph by paragraph as they are written." : "Answers will post once each part is complete.");
  },
});

registerCommand({
  name: "restart",
  usage: "\\restart",
  summary: "Reconnect to the OpenCode V2 service",
  detail: "Re-discovers the service and resumes observation. Existing sessions and running tasks are retained.",
  async run(ctx) {
    const dir = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
    await ctx.pool.reconnect();
    const entry = await ctx.pool.ensure(dir);
    await ctx.postToThread(`🔄 Reconnected to OpenCode for \`${dir}\` (${entry.url ?? "connecting"}). Existing work is retained; observation is being reconciled.`);
  },
});

registerCommand({
  name: "logs", duringReport: true,
  aliases: ["log"],
  usage: "\\logs [filter] | \\logs --follow [filter]",
  summary: "Recent bridge log lines",
  detail: "`--follow` streams new lines for 30s. Substrate is the in-memory ring; the persistent file (rotated) lives at the path shown with `--follow`.",
  async run(ctx, args) {
    let follow = false;
    let rest = args.trim();
    if (rest.startsWith("--follow")) {
      follow = true;
      rest = rest.slice("--follow".length).trim();
    }
    const filter = rest.toLowerCase();
    const match = (l: string) => !filter || l.toLowerCase().includes(filter);

    if (!follow) {
      const all = recentLogs(50);
      const lines = all.filter(match);
      if (!lines.length) {
        await ctx.postToThread(filter ? `(no bridge log lines matching \`${rest}\` since this boot)` : "(no bridge log lines captured since this boot)");
        return;
      }
      for (const chunk of chunkText(`\`\`\`\n${lines.join("\n")}\n\`\`\``)) await ctx.postToThread(chunk);
      return;
    }

    // Follow: recent context, then stream new lines ~1/s for 30s.
    const path = fileLogPath();
    const recent = recentLogs(10).filter(match);
    const head = `📡 Following bridge log for 30s${filter ? ` (filter: \`${rest}\`)` : ""}${path ? ` — file: \`${path}\`` : ""}\n\`\`\`\n${recent.join("\n")}\n\`\`\``;
    for (const chunk of chunkText(head)) await ctx.postToThread(chunk);
    let cursor = logCount();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const fresh = newLogsSince(cursor).filter(match);
      cursor = logCount();
      if (fresh.length) {
        for (const chunk of chunkText(`\`\`\`\n${fresh.join("\n")}\n\`\`\``)) await ctx.postToThread(chunk);
      }
    }
    await ctx.postToThread("⏹ Follow ended (30s).");
  },
});

registerCommand({
  name: "model",
  aliases: ["models"],
  usage: "\\model | \\model <#|provider/model|filter>",
  summary: "Show or swap the model for this thread",
  detail: "Bare `\\model` posts a searchable picker with your OpenCode ★ favorites on top; `\\model sonnet` filters; `\\model provider/model` sets.",
  async run(ctx, args) {
    const dir = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
    const entry = await ctx.pool.ensure(dir);
    const info = await configProviders(entry.client!);
    // Favorites first (TUI ctrl+f order); `\model <#>` numbers follow this order.
    const models = orderedModels(info, readFavorites());
    // A thread override wins; V2 exposes the location default directly.
    const effectiveModel = async (): Promise<string | undefined> => {
      if (ctx.thread?.model) return ctx.thread.model;
      return (await configGet(entry.client!)).model;
    };
    // ★ trails the line (user-mandated): start-of-line markers crowded the code
    // span; the trailing star also can't disturb the span's leading whitespace.
    const row = (num: number, id: string, cur?: string): string =>
      `${num}) \`${id}\`${id === cur ? " ★" : ""}`;
    const arg = args.trim();
    if (!arg || arg === "list") {
      const cur = await effectiveModel();
      const current = models.find(m => m.id === cur);
      await ctx.postToThread(cur ? `Model — current: ${cur}` : "Choose a model",
        modelSearchBlocks(cur ? `*Model* — current: \`${cur}\`` : "*Model*", current && modelOption(current)));
      return;
    }
    const th = requireThread(ctx);
    const all = models.map(m => m.id);
    const n = Number(arg);
    let model: string | undefined;
    if (Number.isInteger(n) && n >= 1 && n <= all.length) {
      model = all[n - 1];
    } else {
      const slash = arg.indexOf("/");
      const exact =
        slash > 0 &&
        info.providers.some((p) => p.id === arg.slice(0, slash) && p.models[arg.slice(slash + 1)]);
      if (exact) {
        model = arg;
      } else {
        // Not a number, not an exact id → substring filter on id or name; one
        // hit sets it directly, more print a list numbered with GLOBAL indices
        // so `\model <#>` resolves against the favorites-first ordering.
        const q = arg.toLowerCase();
        const hits = models.map((m, i) => ({ id: m.id, i }))
          .filter((h) => h.id.toLowerCase().includes(q) || models[h.i]!.name.toLowerCase().includes(q));
        if (!hits.length) throw new Error(`no model matches \`${arg}\` — bare \`\\model\` to search`);
        if (hits.length === 1) {
          model = hits[0]!.id;
        } else {
          const lines = [`*Models matching* \`${arg}\` (${hits.length})`, ""];
          const cur = await effectiveModel();
          hits.forEach((h) => lines.push(row(h.i + 1, h.id, cur)));
          lines.push("", "`\\model <#>` to set (numbers are global).");
          for (const chunk of chunkText(lines.join("\n"))) await ctx.postToThread(chunk);
          return;
        }
      }
    }
    ctx.state.setThread(ctx.threadKey, { ...th, model });
    await ctx.postToThread(`Model for this thread set to \`${model}\` (applies from your next prompt).`);
  },
});

registerCommand({
  name: "agent",
  aliases: ["agents"],
  usage: "\\agent | \\agent <# or name>",
  summary: "Show or swap this thread's agent",
  async run(ctx, args) {
    const dir = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
    const entry = await ctx.pool.ensure(dir);
    const agents = (await agentsList(entry.client!)).filter((a) => a.mode === "primary" || a.mode === "all");
    const arg = args.trim();
    if (!arg || arg === "list") {
      const cur = ctx.thread?.agent ?? "(default)";
      const picker = pickerBlocks("agent", `*Agent* — current: \`${cur}\``,
        [{ label: "Agents", options: agents.map(a => ({ text: a.name, value: `\\agent ${a.name}` })) }], `\\agent ${cur}`);
      if (picker) await ctx.postToThread("Choose an agent", picker);
      const lines = [`Current: \`${cur}\``, ""];
      agents.forEach((a, i) => lines.push(`${i + 1}) \`${a.name}\``));
      lines.push("", "`\\agent <#|name>` to set.");
      await ctx.postToThread(lines.join("\n"));
      return;
    }
    const n = Number(arg);
    let agent: string | undefined;
    if (Number.isInteger(n) && n >= 1 && n <= agents.length) agent = agents[n - 1]?.name;
    else {
      if (!agents.some((a) => a.name === arg)) throw new Error(`unknown agent \`${arg}\` — see \\agent`);
      agent = arg;
    }
    const th = requireThread(ctx);
    ctx.state.setThread(ctx.threadKey, { ...th, agent });
    await ctx.postToThread(`Agent for this thread set to \`${agent}\` (applies from your next prompt).`);
  },
});

/** All known project dirs (state list + running pool), current first. */
function knownProjectDirs(ctx: CmdCtx): string[] {
  const current = canonicalDir(ctx.state.defaultDir(ctx.channelId, ctx.cwd));
  const dirs = new Set<string>([current, ...ctx.pool.list().map((s) => s.dir), ...ctx.state.listProjects().map((p) => p.dir)].map(canonicalDir));
  return [...dirs];
}

const projectName = (dir: string): string => dir.split("/").filter(Boolean).pop() ?? dir;

/**
 * `#N` (from the last \\project list) or a name/substring among `dirs`.
 * Undefined means a reply was already posted (stale list or ambiguous name).
 */
async function resolveProject(ctx: CmdCtx, q: string, dirs: string[]): Promise<string | undefined> {
  if (/^#?\d+$/.test(q)) {
    const n = Number(q.replace(/^#/, ""));
    const displayed = projectListSnapshot(ctx);
    if (!displayed) {
      await ctx.postToThread("No fresh project list in this thread — run `\\project` and pick a number from that list.");
      return;
    }
    const dir = displayed[n - 1];
    if (!dir) throw new Error(`no project #${n} in the list you saw — \\project refreshes it`);
    return dir;
  }
  const ql = q.toLowerCase();
  // An exact folder name wins; only then fall back to substring matches on the path.
  const exact = dirs.filter((d) => projectName(d).toLowerCase() === ql);
  const hits = exact.length ? exact : dirs.filter((d) => d.toLowerCase().includes(ql));
  if (hits.length > 1) {
    await ctx.postToThread(`Ambiguous — ${hits.map((h) => `\`${projectName(h)}\``).join(", ")}. Use \`\\project <#>\` from the list.`);
    return;
  }
  if (!hits[0]) throw new Error(`no project matches \`${q}\` — try bare \`\\project\` for the list`);
  return hits[0];
}

/** Hard pin: a pinned channel refuses every project other than its own (a worktree of it counts as its own). */
async function assertUnpinned(ctx: CmdCtx, dir: string): Promise<void> {
  const pin = ctx.state.channelProject(ctx.channelId);
  if (pin && pin !== canonicalDir(dir) && !(await sameProject(pin, dir))) {
    throw new Error(`📌 this channel is pinned to \`${projectName(pin)}\` — \`\\unpin\` first, or use another channel.`);
  }
}

registerCommand({
  name: "project", rebinds: "withArgs",
  aliases: ["projects"],
  usage: "\\project | \\project <name|#>",
  summary: "Swap projects by name or #",
  detail: "`\\project cowork` or `\\project 2`; bare `\\project` lists candidates with numbers.",
  async run(ctx, args) {
    const q = args.trim();
    if (!q) {
      const current = canonicalDir(ctx.state.defaultDir(ctx.channelId, ctx.cwd));
      const dirs = knownProjectDirs(ctx);
      const lines = [`*Current:* \`${current}\``];
      const rest = dirs.filter((d) => d !== current);
      rest.forEach((d, i) => {
        const pool = ctx.pool.list().find((s) => canonicalDir(s.dir) === d);
        lines.push(`${i + 1}) \`${esc(projectName(d))}\` — ${esc(d)}${pool ? ` (server ${pool.status})` : ""}`);
      });
      if (!rest.length) lines.push("(no other known projects yet — use `\\cd /abs/path` once)");
      const picker = pickerBlocks("project", `*Project* — current: \`${esc(projectName(current))}\``,
        [{ label: "Projects", options: rest.map(d => ({ text: `${projectName(d)} — ${d}`, value: `\\cd ${d}` })) }]);
      lines.push("`\\project <name|#>` to switch.");
      invalidateProjectList(ctx);
      if (picker) await ctx.postToThread("Switch project", picker);
      await ctx.postToThread(lines.join("\n"));
      cacheProjectList(ctx, rest);
      return;
    }
    const dir = await resolveProject(ctx, q, knownProjectDirs(ctx).filter((d) => d !== canonicalDir(ctx.state.defaultDir(ctx.channelId, ctx.cwd))));
    if (!dir) return;
    requireDir(ctx, dir); // a remembered project may have moved: refuse before tearing down this thread's session (#48)
    await assertUnpinned(ctx, dir);
    ctx.state.setCurrentProject(dir);
    await rebindThread(ctx, dir, `↔ Switched to \`${projectName(dir)}\`.`);
  },
});

registerCommand({
  name: "cd", rebinds: "withArgs",
  usage: "\\cd <path>",
  summary: "Switch project dir (fresh session)",
  detail: "Accepts absolute, `~`, or paths relative to this thread's project. Old session + server are torn down so nothing leaks between projects.",
  async run(ctx, args) {
    if (!args) throw new Error("usage: \\cd <path>");
    const dir = requireDir(ctx, args);
    await assertUnpinned(ctx, dir);
    ctx.state.setCurrentProject(dir);
    await rebindThread(ctx, dir, "↔ Switched project.");
  },
});

registerCommand({
  name: "pin",
  usage: "\\pin [path|name|#|off]",
  summary: "Lock this channel to one project",
  detail: "Bare `\\pin` pins this thread's project. While pinned, new sessions here start in it and `\\cd`/`\\project`/`\\new <path>`/`\\resume` to other folders are refused. Existing threads keep their folders.",
  async run(ctx, args) {
    const q = args.trim();
    const pin = ctx.state.channelProject(ctx.channelId);
    if (q.toLowerCase() === "off") {
      ctx.state.setChannelProject(ctx.channelId, undefined);
      await ctx.postToThread(pin ? `Unpinned from \`${projectName(pin)}\`.` : "This channel isn't pinned.");
      return;
    }
    if (!q && pin) {
      await ctx.postToThread(`📌 Pinned to \`${projectName(pin)}\` (${pin}). \`\\unpin\` to release.`);
      return;
    }
    const dir = !q ? ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd)
      : /^[~/.]/.test(q) ? requireDir(ctx, q) : await resolveProject(ctx, q, knownProjectDirs(ctx));
    if (!dir) return;
    ctx.state.setChannelProject(ctx.channelId, dir);
    await ctx.postToThread(`📌 Pinned to \`${projectName(dir)}\` — new sessions here run in \`${canonicalDir(dir)}\`. \`\\unpin\` to release.`);
  },
});

registerCommand({
  name: "unpin",
  usage: "\\unpin",
  summary: "Release this channel's project pin",
  run: (ctx) => getCommand("pin")!.run(ctx, "off"),
});

registerCommand({
  name: "new", rebinds: "always",
  usage: "\\new [path] | \\new --wt [branch]",
  summary: "Fresh session in this thread",
  detail: "Bare `\\new` stays in this thread's project; `\\new <path>` also switches the current project. Accepts absolute, `~`, or paths relative to this thread's project. `\\new --wt [branch]` starts in a fresh worktree of this project (its own checkout and branch), so parallel threads don't share files. The previous session is kept (\\resume recovers it).",
  async run(ctx, args) {
    const { wt, rest: branch } = takeWtFlag(args);
    if (args && !wt) {
      const dir = requireDir(ctx, args);
      await assertUnpinned(ctx, dir);
      ctx.state.setCurrentProject(dir);
      await rebindThread(ctx, dir, "✨ New project session.", { teardown: false });
      return;
    }
    // Same project as the thread (a channel pin still wins); unbound threads use the channel default.
    const dir = ctx.state.channelProject(ctx.channelId) ?? ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
    if (wt) {
      await prepareWorktree({ pool: ctx.pool, state: ctx.state, threadKey: ctx.threadKey, baseDir: dir, branch: branch || undefined,
        say: (text) => ctx.postToThread(text), bind: (wtDir) => rebindThread(ctx, wtDir, "🌳 New worktree session.", { teardown: false }) });
      return;
    }
    await rebindThread(ctx, dir, "✨", { teardown: false });
  },
});

registerCommand({
  name: "sessions",
  aliases: ["session"],
  usage: "\\sessions [all|<filter>]",
  summary: "List recent sessions",
  detail: "Running/idle markers per session; the numbers stay stable so `\\resume <#>` binds what you saw. A filter narrows machine-wide.",
  async run(ctx, args) {
    const arg = args.trim();
    if (!arg) {
      const dir = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
      const { refs, total } = await pickerList(ctx, { scope: "project" });
      if (!total) {
        await ctx.postToThread(`No sessions yet in \`${dir}\` — \`\\sessions all\` lists the whole machine.`);
        return;
      }
      await postSessionPicker(ctx, refs);
      await ctx.postToThread(renderPickerList(refs, { heading: `*Sessions in* \`${dir}\``, total }));
      return;
    }
    const { refs, total } = await pickerList(ctx, { scope: "all", filter: arg.toLowerCase() === "all" ? undefined : arg });
    await postSessionPicker(ctx, refs);
    await ctx.postToThread(renderPickerList(refs, { heading: arg.toLowerCase() === "all" ? "*Sessions — machine-wide*" : `*Sessions matching* \`${arg}\``, total }));
  },
});

/** Dropdown over a \sessions list; choosing one runs `\resume <id>` in this thread. */
async function postSessionPicker(ctx: CmdCtx, refs: SessionRef[]): Promise<void> {
  const picker = pickerBlocks("session", "*Resume a session*", [{ label: "Sessions",
    options: refs.map(r => ({ text: `${r.running ? "▶ " : ""}${r.title || shortId(r.sessionId)} · ${shortPath(r.projectDir)}`, value: `\\resume ${r.sessionId}` })) }]);
  if (picker) await ctx.postToThread("Resume a session", picker);
}

registerCommand({
  name: "resume", rebinds: "withArgs",
  usage: "\\resume <# or session id>",
  summary: "Bind this thread to an existing session",
  detail: "Machine-wide: any session on this computer, including TUI-started ones; the thread follows the session's project.",
  async run(ctx, args) {
    if (!args) throw new Error("usage: \\resume <# or session id>");
    ctx.state.cancelRecovery(ctx.threadKey, ctx.messageTs, true);
    const pick = await pickerResolve(ctx, args);
    if (pick.kind === "stale") {
      // The list the user picked from has expired — showing a fresh one beats
      // guessing that their number still means the same session.
      await ctx.postToThread(staleListReply(pick, "resume"));
      return;
    }
    const target = pick.ref.sessionId;
    const dir = pick.ref.projectDir;
    await assertUnpinned(ctx, dir);
    const entry = await ctx.pool.ensure(dir);
    await sessionGet(entry.client!, target); // throws if gone
    // Sessions are exclusive to one thread: stealing it here would orphan the
    // original thread's live view (mid-run events would stop rendering there).
    const boundElsewhere = ctx.state.findThreadBySession(target);
    if (boundElsewhere && boundElsewhere.key !== ctx.threadKey) {
      throw new Error(`session \`${shortId(target)}\` already lives in another thread — \`\\stop\` it there first, or \`\\new\` here`);
    }
    const old = ctx.thread;
    // Detach the previously-bound session's live view — otherwise its events
    // keep rendering into this thread even though it now points elsewhere.
    // stopWatching (not bare deleteView) so a watched old view also drops its
    // poll loop and the thread's read-only gate.
    if (old && old.sessionId !== target) await getView(old.sessionId)?.stopWatching().catch(() => {});
    if (!old || old.sessionId !== target) invalidatePickerCache(ctx.threadKey);
    ctx.state.setThread(ctx.threadKey, {
      ...(old ?? newThreadState(target, dir, ctx.state.channelVerbose(ctx.channelId))),
      sessionId: target,
      projectDir: dir,
      watchOnly: false, // \resume is the takeover path — the read-only gate lifts
      pendingRun: old?.sessionId === target ? old.pendingRun : undefined,
    });
    const generation = ctx.state.bindingGeneration(ctx.threadKey);
    await Promise.all([
      ctx.postToThread(`↩️ Thread bound to session \`${shortId(target)}\` in \`${dir}\`. Reply here to continue it.`),
      ctx.source === "live" && ctx.messageTs ? ctx.resumeQuestions?.({ threadKey: ctx.threadKey,
        sessionId: target, generation, ownerTs: ctx.messageTs }) : undefined,
    ]);
  },
});

/**
 * Resolve the session a command should act on: bare → this thread's binding;
 * otherwise a picker arg (`#N`, id substring). Stale picks surface the fresh
 * list instead of guessing.
 */
async function resolveTarget(
  ctx: CmdCtx,
  args: string,
): Promise<{ sessionId: string; projectDir: string } | { stale: { list: SessionRef[]; total: number } }> {
  const arg = args.trim();
  if (!arg) {
    const th = requireThread(ctx);
    return { sessionId: th.sessionId, projectDir: th.projectDir };
  }
  const pick = await pickerResolve(ctx, arg);
  if (pick.kind === "stale") return { stale: { list: pick.list, total: pick.total } };
  return { sessionId: pick.ref.sessionId, projectDir: pick.ref.projectDir };
}

function staleListReply(stale: { list: SessionRef[]; total: number }, cmd: string): string {
  return `That list has expired — here's the current one; pick again with \`\\${cmd} <#>\`:\n\n${renderPickerList(stale.list, { heading: "*Sessions*", total: stale.total })}`;
}

registerCommand({
  name: "watch", rebinds: "withArgs",
  usage: "\\watch <#|id>",
  summary: "Read-only live mirror of a session",
  detail: "Streams a TUI/IDE session's run into this thread (3s transcript poll). Replies stay read-only; `\\resume` takes the session over, `\\unwatch` stops.",
  async run(ctx, args) {
    if (!args) throw new Error("usage: \\watch <# or session id>");
    ctx.state.cancelRecovery(ctx.threadKey, ctx.messageTs, true);
    const pick = await pickerResolve(ctx, args);
    if (pick.kind === "stale") {
      await ctx.postToThread(staleListReply(pick, "watch"));
      return;
    }
    const ref = pick.ref;
    // Exclusivity for free: the view registry is keyed by sessionId, so a
    // session has at most one view ⇒ one watching/bound thread. A session
    // already live anywhere can't be watched from here too.
    const bound = ctx.state.findThreadBySession(ref.sessionId);
    if (bound && bound.key !== ctx.threadKey) {
      throw new Error(`session \`${shortId(ref.sessionId)}\` already lives in another thread — it can only be watched/bound in one place`);
    }
    if (getView(ref.sessionId)) {
      if (ctx.thread?.sessionId === ref.sessionId) {
        await ctx.postToThread(`Already live in this thread${ctx.thread?.watchOnly ? " (watching)" : ""}.`);
        return;
      }
      throw new Error(`session \`${shortId(ref.sessionId)}\` is already live in another thread`);
    }
    if (!ctx.render) throw new Error("\\watch needs the Slack render pipeline (unavailable here)");
    const entry = await ctx.pool.ensure(ref.projectDir);
    const old = ctx.thread;
    // Same detach rule as \resume: the old binding's view must not keep
    // rendering into this thread once the thread points elsewhere.
    if (old && old.sessionId !== ref.sessionId) await getView(old.sessionId)?.stopWatching().catch(() => {});
    const now = Date.now();
    ctx.state.setThread(ctx.threadKey, {
      sessionId: ref.sessionId,
      projectDir: ref.projectDir,
      verbose: old?.verbose ?? ctx.state.channelVerbose(ctx.channelId),
      model: old?.model,
      agent: old?.agent,
      watchOnly: true,
      createdAt: old?.createdAt ?? now,
      lastUsedAt: now,
    });
    const view = new SessionView({
      sessionId: ref.sessionId,
      projectDir: ref.projectDir,
      channel: ctx.channelId,
      threadTs: ctx.threadTs,
      threadKey: ctx.threadKey,
      client: entry.client!,
      deps: ctx.render,
      state: ctx.state,
      threadState: ctx.state.getThread(ctx.threadKey)!,
    });
    try {
      await view.attach();
    } catch (err) {
      deleteView(ref.sessionId);
      throw err;
    }
  },
});

registerCommand({
  name: "unwatch", rebinds: "always",
  usage: "\\unwatch",
  summary: "Stop mirroring",
  async run(ctx) {
    const th = ctx.thread;
    if (!th?.watchOnly) {
      await ctx.postToThread("This thread isn't watching anything.");
      return;
    }
    const view = getView(th.sessionId);
    if (view) await view.stopWatching(); // drops the view + lifts the gate
    else ctx.state.setThread(ctx.threadKey, { ...th, watchOnly: false });
    await ctx.postToThread("👁 Watch ended — this thread is read-write again (session kept, `\\resume` recovers it).");
  },
});

registerCommand({
  name: "history", duringReport: true,
  usage: "\\history [n] | \\history <#|id>",
  summary: "Transcript digest of a session",
  detail: "Display-only — reading history never touches the session's context. Bare `n` = tail turns (default 10); `#N`/id picks another session.",
  async run(ctx, args) {
    const arg = args.trim();
    let turns = 10;
    let targetArg = "";
    if (arg) {
      if (/^\d+$/.test(arg)) turns = Math.min(Math.max(Number(arg), 1), 50);
      else targetArg = arg;
    }
    const t = await resolveTarget(ctx, targetArg);
    if ("stale" in t) {
      await ctx.postToThread(staleListReply(t.stale, "history"));
      return;
    }
    const entry = await ctx.pool.ensure(t.projectDir);
    const msgs = await sessionMessages(entry.client!, t.sessionId);
    if (!msgs.length) {
      await ctx.postToThread(`No messages in \`${shortId(t.sessionId)}\` yet.`);
      return;
    }
    const digest = renderHistoryDigest(t.sessionId, msgs, turns);
    if (digest.length <= 3500) await ctx.postToThread(digest);
    else await ctx.uploadToThread(`history-${shortId(t.sessionId)}.md`, digest);
  },
});

/** `[n]` turn-count argument for \fork / \undo. */
function turnCount(args: string, fallback: number, usage: string): number {
  const arg = args.trim();
  if (!arg) return fallback;
  if (!/^\d+$/.test(arg)) throw new Error(`usage: ${usage}`);
  return Number(arg);
}

/**
 * IDs of the session's real user turns, oldest first. Undelivered inbox items
 * show up as user rows with no parts (client.ts messages) and are not turns.
 */
export function userTurnIds(msgs: Array<{ info: OcMessageInfo; parts: OcPart[] }>): string[] {
  return msgs.filter((m) => m.info.role === "user" && m.parts.length > 0).map((m) => m.info.id);
}

const turnsWord = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

registerCommand({
  name: "fork",
  usage: "\\fork [--wt] [n]",
  summary: "Copy this session into a new thread, minus the last n turns",
  detail: "Bare `\\fork` copies everything. The fork shares this thread's working directory, so edits from either thread land in the same files. `\\fork --wt` gives the fork its own worktree (checkout and branch) instead.",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const { wt, rest } = takeWtFlag(args);
    const n = turnCount(rest, 0, "\\fork [--wt] [n]");
    if (!ctx.render) throw new Error("\\fork needs the Slack render pipeline (unavailable here)");
    const fork = await withServerLease(ctx, th.projectDir, async (entry) => {
      let before: string | undefined;
      if (n) {
        const ids = userTurnIds(await sessionMessages(entry.client!, th.sessionId));
        before = ids.at(-n);
        if (!before) return ids.length;
      }
      return sessionFork(entry.client!, th.sessionId, before);
    });
    if (typeof fork === "number") {
      await ctx.postToThread(`Only ${turnsWord(fork)} in this session.`);
      return;
    }
    const origin = ctx.threadUrl?.(ctx.threadKey);
    const dropped = n ? `, last ${turnsWord(n)} dropped` : "";
    // "" threadTs posts top-level: the fork gets its own thread (a new DM root in DMs).
    const { ts } = await ctx.render.post(ctx.channelId, "",
      `🔀 Fork of ${origin ? `<${origin}|this thread>` : "a thread"} (session \`${shortId(fork.id)}\`${dropped}) ${wt ? "with its own worktree."
        : `in \`${th.projectDir}\`. Reply here to drive it. Note: it shares the same working directory.`}`,
      undefined, { unfurl: false });
    const key = ctx.state.threadKey(ctx.channelId, ts);
    const bind = (dir: string) => ctx.state.setThread(key, { ...newThreadState(fork.id, dir, th.verbose), model: th.model, agent: th.agent, stream: th.stream });
    let dir = th.projectDir;
    if (wt) {
      // Create the worktree, move the forked session into it, then bind; a failure falls back to sharing this folder.
      const render = ctx.render;
      const say = (text: string) => render.post(ctx.channelId, ts, text, undefined, { unfurl: false });
      const ready = await prepareWorktree({ pool: ctx.pool, state: ctx.state, threadKey: key, baseDir: th.projectDir, fallback: th.projectDir, say, bind: async (d) => {
        if (d !== th.projectDir) await withServerLease(ctx, d, (entry) => sessionMove(entry.client!, fork.id, d));
        bind(d);
      } });
      if (ready === null) return; // the new thread was rebound meanwhile; prepareWorktree said so there
      dir = ready;
      if (dir !== th.projectDir) await say(`🌳 Worktree ready: \`${dir}\`. Reply here to drive it.`);
    } else bind(dir);
    const link = ctx.threadUrl?.(key);
    await ctx.postToThread(`🔀 Forked${n ? ` without the last ${turnsWord(n)}` : ""} → ${link ? `<${link}|new thread>` : "new thread"}${dir !== th.projectDir ? " in its own worktree" : ""}. This thread is unchanged.`);
  },
});

const UNDO_BUSY = "A run is in progress. Use `\\stop` first, then `\\undo`.";

registerCommand({
  name: "undo",
  aliases: ["revert"],
  usage: "\\undo [n]",
  summary: "Rewind the last n turns (default 1) and OpenCode's edits from them",
  detail: "Posts a card listing the restored files: *Keep* makes it final, *Put it back* restores everything. Your next message also keeps it. Repeat `\\undo` to go further back.",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const n = turnCount(args, 1, "\\undo [n]");
    if (n < 1) throw new Error("usage: \\undo [n]");
    if (getView(th.sessionId)?.isActive) {
      await ctx.postToThread(UNDO_BUSY);
      return;
    }
    const client = (await ctx.pool.ensure(th.projectDir)).client!;
    const [sess, msgs] = await Promise.all([sessionGet(client, th.sessionId), sessionMessages(client, th.sessionId)]);
    const all = userTurnIds(msgs);
    // A staged undo still lists its turns, so count back from its boundary.
    const staged = sess.revert ? all.indexOf(sess.revert.messageID) : -1;
    const ids = staged >= 0 ? all.slice(0, staged) : all;
    const messageID = ids.at(-n);
    if (!messageID) {
      await ctx.postToThread(`Only ${turnsWord(ids.length)} ${staged >= 0 ? "left before the current undo" : "in this session"}.`);
      return;
    }
    let files: OcFileDiff[];
    try {
      files = (await revertStage(client, th.sessionId, messageID)).files ?? [];
    } catch (err) {
      if ((err as { _tag?: string })?._tag !== "SessionBusyError") throw err;
      await ctx.postToThread(UNDO_BUSY);
      return;
    }
    const total = all.length - all.indexOf(messageID);
    const first = partsText(msgs.find((m) => m.info.id === messageID)?.parts ?? []);
    const text = [
      `↩ Rewound ${turnsWord(total)}${first ? ` (“${firstLine(first, 60)}”)` : ""}.`,
      files.length ? `Files restored:\n${formatDiffSummary(files)}` : "No file edits to restore.",
      "Only OpenCode's own edits are restored. The Slack messages above stay, but the agent no longer sees them. Your next message keeps this undo.",
    ].join("\n");
    await ctx.postToThread(text, revertCardBlocks(text, { s: th.sessionId, m: messageID, n: total }));
  },
});

/** First line of a text part, whitespace-squeezed, Slack-safe. */
const firstLine = (s: string, n: number): string => truncate(esc((s.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim()), n);

/**
 * Compact transcript digest for `\history`: `*you*` first line / `*agent*`
 * first few lines, tool calls as a count. Pure display — pure function so
 * tests can pin the shape.
 */
export function renderHistoryDigest(
  sessionId: string,
  msgs: Array<{ info: OcMessageInfo; parts: OcPart[] }>,
  turns: number,
): string {
  interface Turn {
    user: string | null;
    agent: string[];
    tools: number;
  }
  const turnsAll: Turn[] = [];
  for (const m of msgs) {
    const role = m.info?.role;
    const text = partsText(m.parts);
    const toolCount = (m.parts ?? []).filter((p) => p.type === "tool").length;
    if (role === "user") {
      turnsAll.push({ user: text ? firstLine(text, 120) : null, agent: [], tools: 0 });
    } else if (role === "assistant") {
      let turn = turnsAll.at(-1);
      if (!turn) {
        turn = { user: null, agent: [], tools: 0 };
        turnsAll.push(turn);
      }
      if (text) {
        // First paragraph (≤6 lines), Slack-safe: raw model text may hold <, >, &.
        const para = text.split(/\n{2,}/)[0]?.trim() || text;
        turn.agent.push(truncate(esc(para.split("\n", 6).join("\n")), 480));
      }
      turn.tools += toolCount;
    }
  }
  const shown = turnsAll.slice(-turns);
  const lines: string[] = [`*History of* \`${shortId(sessionId)}\` — last ${shown.length} turn${shown.length === 1 ? "" : "s"} (of ${turnsAll.length})`, ""];
  for (const t of shown) {
    if (t.user) lines.push(`*you* ${t.user}`, "");
    for (const a of t.agent) {
      lines.push(`*agent* ${a}`, "");
    }
    if (t.tools) lines.push(`  _(${t.tools} tool call${t.tools === 1 ? "" : "s"} in this turn)_`, "");
  }
  if (!shown.some((t) => t.user || t.agent.length || t.tools)) lines.push("(no displayable turns)");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const SUMMARY_BUDGET_CHARS = 30_000;
/** Poll ceiling for the throwaway summarizer run (3s steps). */
const SUMMARY_POLL_STEPS = 60;

/**
 * Snapshot the transcript for `\summary`: user + assistant TEXT parts only,
 * clipped to the newest `budget` chars (whole earlier turns dropped first).
 */
function transcriptForSummary(
  msgs: Array<{ info: OcMessageInfo; parts: OcPart[] }>,
  budget = SUMMARY_BUDGET_CHARS,
): string {
  const blocks: string[] = [];
  for (const m of msgs) {
    const role = m.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = partsText(m.parts);
    if (!text) continue;
    blocks.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const kept: string[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (total + b.length > budget && kept.length) break;
    kept.unshift(b);
    total += b.length;
  }
  const body = kept.join("\n\n");
  if (!body.trim()) return "";
  return blocks.length > kept.length ? `(earlier turns omitted)\n\n${body}` : body;
}

/**
 * The `\summary` engine: a THROWAWAY session on the same server gets the
 * transcript + a fixed summarizer prompt, the run is polled to completion,
 * then aborted + deleted. The
 * target session never sees any of it — its context stays exactly as it was.
 */
async function runSummaryProbe(client: OCClient, transcript: string, model?: string): Promise<string> {
  const sess = await sessionCreate(client, "SlackOC summary probe");
  try {
    await promptAsync(client, sess.id, SUMMARY_PROMPT + transcript, model ? { model } : {});
    for (let i = 0; i < SUMMARY_POLL_STEPS; i++) {
      const msgs = await sessionMessages(client, sess.id);
      const last = [...msgs].reverse().find((m) => m.info?.role === "assistant");
      if (last?.info?.time?.completed) {
        const text = partsText(last.parts);
        if (text) return text;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error("summary run did not complete in time — try again");
  } finally {
    await sessionAbort(client, sess.id).catch(() => {});
    await sessionDelete(client, sess.id).catch(() => {});
  }
}

const SUMMARY_PROMPT =
  "Summarize this coding-session transcript for the person who took part in it. " +
  "Cover: what was asked for, what was done (files changed, key decisions), the current state, " +
  "and anything left unfinished. Be concise — under 250 words. Transcript:\n\n";

registerCommand({
  name: "summary", duringReport: true,
  aliases: ["summarize"],
  usage: "\\summary [#|id]",
  summary: "AI catch-up summary of a session",
  detail: "Runs in a throwaway session — the target's context stays clean. Refuses while the target is mid-run (snapshot semantics).",
  async run(ctx, args) {
    const t = await resolveTarget(ctx, args);
    if ("stale" in t) {
      await ctx.postToThread(staleListReply(t.stale, "summary"));
      return;
    }
    if (getView(t.sessionId)?.isActive) {
      throw new Error("that session is mid-run here — wait for it to finish (a summary needs a stable snapshot)");
    }
    const entry = await ctx.pool.ensure(t.projectDir);
    const msgs = await sessionMessages(entry.client!, t.sessionId);
    const tail = msgs.at(-1);
    if (tail?.info?.role === "assistant" && !tail.info.time?.completed && Date.now() - (tail.info.time?.created ?? 0) < 5 * 60_000) {
      throw new Error("that session looks mid-run (incomplete recent reply) — wait for it to finish");
    }
    const transcript = transcriptForSummary(msgs);
    if (!transcript) {
      await ctx.postToThread(`Nothing to summarize in \`${shortId(t.sessionId)}\` yet.`);
      return;
    }
    await ctx.postToThread(`⏳ Summarizing \`${shortId(t.sessionId)}\` via a throwaway session — one extra model call…`);
    const text = await withServerLease(ctx, t.projectDir, (leased) => runSummaryProbe(leased.client!, transcript, ctx.thread?.model));
    for (const chunk of chunkText(`*Summary of* \`${shortId(t.sessionId)}\`\n\n${mdToMrkdwn(text)}`)) await ctx.postToThread(chunk);
  },
});

registerCommand({
  name: "usage",
  aliases: ["cost", "costs", "spend", "stats"],
  usage: "\\usage [today|7d|30d] [all]",
  summary: "Cost, tokens and daily activity",
  detail: "Defaults to the last 7 days for this thread's project (or the current project); `all` covers every project. Days follow the bridge machine's time zone.",
  async run(ctx, args) {
    const { range, all } = parseUsageArgs(args);
    const dir = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const days = USAGE_RANGES[range];
    const now = new Date();
    const from = rangeStart(days, now);
    const text = await withServerLease(ctx, dir, async (entry) => {
      const client = entry.client!;
      const project = all ? undefined : await projectId(client);
      const query = (start: Date) => sessionStats(client, { from: start.getTime(), to: now.getTime(), project, timezone, tools: "none" });
      const [stats, today] = await Promise.all([query(from), days > 1 ? query(rangeStart(1, now)) : undefined]);
      return formatUsage(stats, { scope: all ? "all projects" : projectName(dir), range, days: dayKeys(from, days, timezone), todayCost: today?.cost });
    });
    await ctx.postToThread(text);
  },
});

registerCommand({
  name: "stop",
  aliases: ["abort", "cancel"],
  usage: "\\stop",
  summary: "Abort the running task",
  detail: "Also cancels this thread's queued messages, so nothing runs after it.",
  async run(ctx) {
    await stopThread(ctx, requireThread(ctx));
  },
});

/**
 * \stop's core, shared with the Stop buttons (stopThreadFromButton: Slack's
 * native Stop and the Home tab): cancel parked prompts, interrupt the run, report.
 */
export async function stopThread(
  ctx: Pick<CmdCtx, "state" | "pool" | "threadKey" | "messageTs" | "postToThread">,
  th: ThreadState,
): Promise<void> {
  ctx.state.cancelRecovery(ctx.threadKey, ctx.messageTs);
  // Cancel queued prompts first: interrupt alone leaves them parked in the inbox,
  // and they can outlive the view (e.g. across a bridge restart), so always check.
  let entry: PoolEntry, cancelled: number;
  try {
    entry = await ctx.pool.ensure(th.projectDir);
    cancelled = await cancelParkedPrompts(entry.client!, th.sessionId);
  } catch (err) {
    // OpenCode unreachable: parked prompts can't be checked, and with no view no run is
    // in flight, so an idle Stop isn't an error.
    if (getView(th.sessionId)) throw err;
    await ctx.postToThread("Nothing running in this thread.");
    return;
  }
  const queued = cancelled ? ` Cancelled ${cancelled} queued message${cancelled === 1 ? "" : "s"}.` : "";
  // Finalized views leave the registry, so an absent view = no run in flight.
  if (!getView(th.sessionId)) {
    await ctx.postToThread(cancelled ? `🛑${queued}` : "Nothing running in this thread.");
    return;
  }
  await sessionAbort(entry.client!, th.sessionId);
  await ctx.postToThread(`🛑 Aborted.${queued}`);
}

/**
 * stopThread for a Stop button outside the thread (Slack's native Stop, the
 * Home tab): the report, or the failure, is posted in the thread itself.
 */
export async function stopThreadFromButton(d: Pick<CmdCtx, "state" | "pool"> & { render: NonNullable<CmdCtx["render"]> }, threadKey: string): Promise<void> {
  const sep = threadKey.indexOf(":");
  const [channel, threadTs] = [threadKey.slice(0, sep), threadKey.slice(sep + 1)];
  const postToThread = async (text: string) => { await d.render.post(channel, threadTs, text, undefined, { unfurl: false, lane: "interactive" }); };
  try {
    const th = d.state.getThread(threadKey);
    // A Home card can outlive the switch to \watch; never interrupt a session driven from elsewhere.
    if (th && getView(th.sessionId)?.isWatching) {
      await postToThread("This session is mirrored with `\\watch` and driven elsewhere. Send `\\resume` here to take it over first.");
      return;
    }
    if (th) await stopThread({ state: d.state, pool: d.pool, threadKey, postToThread }, th);
  } catch (err) {
    logErr(`stop failed (${threadKey}): ${String((err as Error)?.message ?? err)}`);
    await postToThread(`:x: Stop failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`).catch(() => {});
  }
}

/** Per-file diffstat lines + a totals header — shared by `\diff` and the DM "View diff" button (RF1). */
registerCommand({
  name: "diff",
  aliases: ["diffs"],
  usage: "\\diff | \\diff full",
  summary: "Diff of this thread's session",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const entry = await ctx.pool.ensure(th.projectDir);
    const diffs = await sessionDiff(entry.client!, th.sessionId);
    if (!diffs.length) {
      await ctx.postToThread("(no tracked edits in this session yet)");
      return;
    }
    const summary = formatDiffSummary(diffs);
    await ctx.postToThread(summary, viewDiffBlocks(summary, th.sessionId));
    if (args.trim().toLowerCase() !== "full") return;
    // Unified diff from the per-file before/after snapshots — inline when it
    // fits in one message, snippet upload otherwise.
    const body = buildUnifiedDiff(diffs);
    if (!body) return;
    if (body.length <= 3500) {
      await ctx.postToThread(`\`\`\`diff\n${body}\n\`\`\``);
    } else {
      await ctx.uploadToThread(`session-${shortId(th.sessionId)}.diff`, body.slice(0, 200_000));
    }
  },
});

registerCommand({
  name: "cmd",
  aliases: ["cmds", "command", "commands"],
  usage: "\\cmd [<opencode command> [args]]",
  summary: "Run a native OpenCode command; bare lists them",
  detail: "e.g. `\\cmd compact` — same as typing the command in the OpenCode TUI. A bare `\\cmd` lists the commands available in this project.",
  async run(ctx, args) {
    if (!args) {
      const dir = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
      const commands = await withServerLease(ctx, dir, (entry) => commandList(entry.client!));
      const lines = commands.length
        ? [`*OpenCode commands in* \`${dir}\``, ...commands.map((c) => `• \`${c.name}\`${c.description ? ` — ${c.description}` : ""}`), "", "Run one with `\\cmd <command> [args]`."]
        : [`No OpenCode commands found in \`${dir}\`.`];
      for (const chunk of chunkText(lines.join("\n"))) await ctx.postToThread(chunk);
      return;
    }
    const th = requireThread(ctx);
    if (th.watchOnly) throw new Error("this thread is watch-only — `\\resume` to take the session over first");
    const { render, messageTs } = ctx;
    if (!render || !messageTs) throw new Error("\\cmd needs the Slack render pipeline (unavailable here)");
    const space = args.indexOf(" ");
    const command = space < 0 ? args : args.slice(0, space);
    const commandArgs = space < 0 ? "" : args.slice(space + 1);
    // V2 only queues the command (no output in the reply); the run arrives as
    // session events, which are dropped for view-less sessions. Attach a view
    // exactly like a prompt (router runPrompt) so it streams and finalizes (#31).
    await withServerLease(ctx, th.projectDir, async (entry) => {
      const view = getView(th.sessionId) ?? new SessionView({
        sessionId: th.sessionId, projectDir: th.projectDir, channel: ctx.channelId, threadTs: ctx.threadTs,
        threadKey: ctx.threadKey, client: entry.client!, deps: render, state: ctx.state, threadState: th,
      });
      await view.beginPrompt(messageTs);
      try {
        await sessionCommand(entry.client!, th.sessionId, command, commandArgs);
      } catch (err) {
        await view.forgetUnsubmittedPrompt(messageTs); // never queued: drop the ⏳ (and the view if it was ours)
        throw err;
      }
    });
    return "view";
  },
});

registerCommand({
  name: "schedule", duringReport: true,
  aliases: ["schedules"],
  usage: SCHEDULE_USAGE,
  summary: "Manage daily/weekly reports",
  detail: "Creation previews the project, prompt, destination and time zone before confirmation; `\\schedule edit <id>` reopens the form.",
  async run(ctx, args) {
    if (!ctx.schedules) throw new Error("scheduled reports are unavailable — check bridge logs");
    await ctx.schedules.run(ctx, args);
  },
});

registerCommand(shotCommand);
registerCommand(shipCommand);
registerCommand(shellCommand);
registerCommand(worktreesCommand);
for (const def of [saveCommand, runCommand, savedCommand, unsaveCommand]) registerCommand(def);

export { newThreadState };
