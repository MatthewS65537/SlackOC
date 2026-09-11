import { homedir } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { OcFileDiff } from "../opencode/api.js";
import type { PoolEntry } from "../opencode/server.js";
import {
  agentsList,
  configGet,
  configProviders,
  sessionAbort,
  sessionCommand,
  sessionCreate,
  sessionDelete,
  sessionDiff,
  sessionGet,
  sessionList,
} from "../opencode/client.js";
import type { CmdCtx, CmdDef } from "./registry.js";
import { allCommands, registerCommand } from "./registry.js";
import { age, chunkText, dur, esc, shortId, shortPath, truncate } from "../util.js";
import type { ThreadState, VerboseMode } from "../state.js";
import { deleteView, describeActiveRuns, finalizeViewsForProject, getView } from "../slack/render.js";
import { droppedOpCount, queueDepth } from "../slack/queue.js";
import { recentLogs } from "../log.js";
import { createTwoFilesPatch } from "diff";

function requireThread(ctx: CmdCtx): NonNullable<CmdCtx["thread"]> {
  if (!ctx.thread) throw new Error("no session bound to this thread yet — send a prompt first");
  return ctx.thread;
}

async function serverFor(ctx: CmdCtx, thread: ThreadState): Promise<PoolEntry> {
  return ctx.pool.ensure(thread.projectDir);
}

function requireDir(ctx: CmdCtx, dir: string): string {
  // Expand a leading ~ to the actual home dir (whatever it is on this machine).
  if (dir === "~") dir = homedir();
  else if (dir.startsWith("~/")) dir = `${homedir()}/${dir.slice(2)}`;
  const abs = resolve(ctx.cwd, dir);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`${abs} is not a directory (use an absolute path)`);
  return abs;
}

function newThreadState(sessionId: string, projectDir: string): ThreadState {
  const now = Date.now();
  return { sessionId, projectDir, verbose: "on", createdAt: now, lastUsedAt: now };
}

/**
 * Point a thread at a fresh session in `dir`. By default (teardown) the old
 * binding is destroyed completely: the previous OpenCode session is aborted +
 * deleted on its own server and the stale SessionView is dropped, so no SSE
 * event or finalize from the old project can leak into this thread afterwards.
 * With `teardown: false` (\new) the old session is only unbound — it stays on
 * its server, listed by \sessions and recoverable via \resume.
 */
async function rebindThread(
  ctx: CmdCtx,
  dir: string,
  note: string,
  opts: { teardown?: boolean } = {},
): Promise<void> {
  const old = ctx.thread;
  if (old) {
    if (opts.teardown !== false) {
      try {
        const oldEntry = await ctx.pool.ensure(old.projectDir);
        await sessionAbort(oldEntry.client!, old.sessionId).catch(() => {});
        await sessionDelete(oldEntry.client!, old.sessionId).catch(() => {});
        // Kill the server ONLY when no other thread still uses this project —
        // opencode serve is shared per dir, and killing it would destroy
        // other threads' in-flight runs. Sessions persist on disk anyway.
        if (!ctx.state.anyThreadInDir(old.projectDir, ctx.threadKey)) {
          await ctx.pool.killOne(old.projectDir).catch(() => {});
        }
      } catch {
        /* old server may already be gone */
      }
    }
    deleteView(old.sessionId);
  }
  const entry = await ctx.pool.ensure(dir);
  const sess = await sessionCreate(entry.client!, `SlackOC ${new Date().toISOString().slice(0, 16)}`);
  ctx.state.setThread(ctx.threadKey, newThreadState(sess.id, dir));
  const kept =
    opts.teardown === false && old
      ? ` Previous session \`${shortId(old.sessionId)}\` kept — \`\\resume\` brings it back.`
      : "";
  await ctx.postToThread(`${note} Fresh session \`${shortId(sess.id)}\` in \`${dir}\`. Reply here to drive it.${kept}`);
}

/** Grouping + order for `\help`; every registered command must appear here. */
export const HELP_SECTIONS: Array<{ title: string; names: string[] }> = [
  { title: "Threads & replies", names: ["hush", "verbose"] },
  { title: "Sessions", names: ["new", "sessions", "resume", "stop", "abort", "diff"] },
  { title: "Model & agent", names: ["model", "agent"] },
  { title: "Projects", names: ["project", "projects", "cd"] },
  { title: "Notifications", names: ["notify"] },
  { title: "Raw OpenCode", names: ["cmd"] },
  { title: "Bridge", names: ["status", "logs", "restart", "help"] },
];

/** Usage for help display: aliases merge into the primary as `\a / \alias1 / \alias2 …`. */
function aliasUsage(name: string, cmds: Map<string, CmdDef>): string {
  const aliases = [...cmds.values()].filter((c) => c.aliasOf === name).map((c) => `\\${c.name}`);
  const primary = cmds.get(name)?.usage ?? `\\${name}`;
  if (!aliases.length) return primary;
  // Swap variants keep the tail: "\project | \project <name|#>" + " / \projects" →
  // but simpler: replace the leading "\name" with "\name / \alias" forms.
  const parts = primary.split(" | ");
  parts[0] = [parts[0]!, ...aliases].join(" / ");
  return parts.join(" | ");
}

registerCommand({
  name: "help",
  usage: "\\help",
  summary: "Show this command list",
  async run(ctx) {
    const cmds = new Map(allCommands().map((c) => [c.name, c]));
    const lines = [
      "*SlackOC* — commands start with `\\`, owner-only. I auto-reply in any thread with a session (invite me to channels: `/invite @SlackOC`; `@`-mention wakes a hushed thread).",
    ];
    const shown = new Set<string>();
    for (const sec of HELP_SECTIONS) {
      lines.push("", `*${sec.title}*`);
      for (const name of sec.names) {
        if (shown.has(name)) continue;
        shown.add(name);
        const c = cmds.get(name);
        if (!c) continue; // alias name in sections — merged into its target's line
        if (c.aliasOf) continue; // alias entry pointing at its target — never its own line
        const target = c.aliasOf ?? name;
        const primary = cmds.get(target)!;
        lines.push(`\`${aliasUsage(target, cmds)}\` — ${primary.summary}`);
        if (primary.detail) lines.push(`    ${primary.detail}`);
      }
    }
    const rest = allCommands().filter((c) => !shown.has(c.name) && !c.aliasOf);
    if (rest.length) {
      lines.push("", "*Other*");
      for (const c of rest) lines.push(`\`${c.usage}\` — ${c.summary}`);
    }
    await ctx.postToThread(lines.join("\n"));
  },
});

registerCommand({
  name: "status",
  usage: "\\status",
  summary: "Current project, thread binding, server pool health",
  async run(ctx) {
    const pool = ctx.pool.list();
    const th = ctx.thread;
    const lines = [
      `*Project:* \`${ctx.state.currentProjectDir ?? ctx.cwd}\``,
      `*Thread:* ${th ? `session \`${shortId(th.sessionId)}\` in \`${th.projectDir}\` · verbose=\`${th.verbose}\`${th.model ? ` · model=\`${th.model}\`` : ""}${th.agent ? ` · agent=\`${th.agent}\`` : ""}${th.hushed ? " · :mute: hushed" : ""}` : "no session bound (next message creates one)"}`,
      `*Pool:* ${pool.length ? pool.map((s) => `\`${s.dir}\` (${s.status}${s.url ? ` ${s.url}` : ""})`).join(", ") : "no servers running yet (they spawn lazily on first use)"}`,
    ];
    if (ctx.bridgeInfo) {
      lines.push(
        `*Bridge:* up ${dur(Date.now() - ctx.bridgeInfo.startedAt)} · owner DMs ${ctx.bridgeInfo.dmAvailable() ? ":white_check_mark:" : ":x: unavailable (notifications off)"}`,
      );
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
    if (qd || dropped) lines.push(`*Slack queue:* ${qd} pending · ${dropped} dropped`);
    await ctx.postToThread(lines.join("\n"));
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
    ctx.state.setThread(ctx.threadKey, { ...th, hushed: next });
    await ctx.postToThread(
      next
        ? "🤫 Hushed — I'll stay quiet in this thread until you `\\hush` again or @ me."
        : "🔔 Awake — I'll keep replying in this thread.",
    );
  },
});

registerCommand({
  name: "verbose",
  usage: "\\verbose [on|off|full]",
  summary: "Tool-call visibility in this thread (on by default)",
  detail: "`on` posts a line per tool call · `full` adds output snippets · `off` silences.",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const arg = args.toLowerCase();
    if (!arg) {
      await ctx.postToThread(`Tool visibility here: \`${th.verbose}\` (default \`on\` · \`full\` adds output snippets · \`off\` silences)`);
      return;
    }
    if (!["on", "off", "full"].includes(arg)) throw new Error("usage: \\verbose on|off|full");
    ctx.state.setThread(ctx.threadKey, { ...th, verbose: arg as VerboseMode });
    getView(th.sessionId)?.setVerbose(arg as VerboseMode);
    await ctx.postToThread(`🔧 Tool visibility set to \`${arg}\`.`);
  },
});

registerCommand({
  name: "notify",
  usage: "\\notify [on|off]",
  summary: "DM you when runs in this thread finish (failures DM you either way)",
  detail: "Permission asks are always mirrored to your DMs with working buttons — approve from anywhere.",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const arg = args.toLowerCase();
    if (!arg) {
      await ctx.postToThread(
        `Completion DMs here: \`${th.notify ? "on" : "off"}\` (failures and permission asks always DM you)`,
      );
      return;
    }
    if (arg !== "on" && arg !== "off") throw new Error("usage: \\notify on|off");
    ctx.state.setThread(ctx.threadKey, { ...th, notify: arg === "on" });
    await ctx.postToThread(arg === "on" ? "🔔 I'll DM you when runs in this thread finish." : "🔕 Completion DMs off — failures and permission asks still reach you.");
  },
});

registerCommand({
  name: "restart",
  usage: "\\restart",
  summary: "Restart this project's opencode server (wedged-server rescue from Slack)",
  detail: "In-flight work on it is interrupted; threads keep their sessions — resend the last prompt if one was running.",
  async run(ctx) {
    const dir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
    // Friendly immediate finalize for anything in flight there; the pool's
    // death hook stays silent because killOne marks the stop intentional.
    await finalizeViewsForProject(dir, ":arrows_counterclockwise: server restarting at owner's request — resend your prompt.");
    await ctx.pool.killOne(dir).catch(() => {});
    const entry = await ctx.pool.ensure(dir);
    await ctx.postToThread(`🔄 Server for \`${dir}\` restarted (${entry.url ?? "starting"}). Threads keep their sessions — resend the interrupted prompt if any.`);
  },
});

registerCommand({
  name: "logs",
  usage: "\\logs [filter]",
  summary: "Recent bridge log lines; optional substring filter (`\\logs error`)",
  async run(ctx, args) {
    const filter = args.trim().toLowerCase();
    const all = recentLogs(50);
    const lines = filter ? all.filter((l) => l.toLowerCase().includes(filter)) : all;
    if (!lines.length) {
      await ctx.postToThread(filter ? `(no bridge log lines matching \`${args.trim()}\` since this boot)` : "(no bridge log lines captured since this boot)");
      return;
    }
    for (const chunk of chunkText(`\`\`\`\n${lines.join("\n")}\n\`\`\``)) await ctx.postToThread(chunk);
  },
});

registerCommand({
  name: "model",
  usage: "\\model | \\model <#|provider/model|filter>",
  summary: "Show or swap the model for this thread",
  detail: "Bare `\\model` prints a numbered list; `\\model 2` picks from it; `\\model sonnet` filters.",
  async run(ctx, args) {
    const dir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
    const entry = await ctx.pool.ensure(dir);
    const info = await configProviders(entry.client!);
    const ids = () =>
      info.providers.flatMap((p) => Object.keys(p.models).map((mid) => `${p.id}/${mid}`));
    // Effective current model: the thread override wins; otherwise resolve the
    // server's own default (config "model", else the first provider's default)
    // so \model stars what a prompt would ACTUALLY use — a bare
    // "(server default)" placeholder is useless and must never be shown.
    const effectiveModel = async (): Promise<string | undefined> => {
      if (ctx.thread?.model) return ctx.thread.model;
      let m: string | undefined;
      try {
        m = (await configGet(entry.client!)).model;
      } catch {
        /* older server without GET /config — fall through to provider defaults */
      }
      if (!m) {
        const p0 = info.providers[0];
        const mid = p0 ? (info.default[p0.id] ?? Object.keys(p0.models)[0]) : undefined;
        m = p0 && mid ? `${p0.id}/${mid}` : undefined;
      }
      return m;
    };
    // ★ trails the line (user-mandated): start-of-line markers crowded the code
    // span; the trailing star also can't disturb the span's leading whitespace.
    const row = (num: number, id: string, cur?: string): string =>
      `${num}) \`${id}\`${id === cur ? " ★" : ""}`;
    const arg = args.trim();
    if (!arg || arg === "list") {
      const cur = await effectiveModel();
      // Compact flat list — `provider/model` lines, numbered for \model <#>.
      const lines = [cur ? `*Models* — current: \`${cur}\`` : "*Models*", ""];
      ids().forEach((id, i) => lines.push(row(i + 1, id, cur)));
      lines.push("", "`\\model <#>` to set.");
      for (const chunk of chunkText(lines.join("\n"))) await ctx.postToThread(chunk);
      return;
    }
    const th = requireThread(ctx);
    const all = ids();
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
        // Not a list number, not an exact id → substring filter; one hit sets
        // it directly, more print a list numbered with GLOBAL indices so
        // `\model <#>` still resolves against the full ordering.
        const q = arg.toLowerCase();
        const hits = all.map((id, i) => ({ id, i })).filter((h) => h.id.toLowerCase().includes(q));
        if (!hits.length) throw new Error(`no model matches \`${arg}\` — bare \`\\model\` lists all`);
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
  usage: "\\agent | \\agent <# or name>",
  summary: "Show or swap the OpenCode agent for this thread",
  async run(ctx, args) {
    const dir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
    const entry = await ctx.pool.ensure(dir);
    const agents = (await agentsList(entry.client!)).filter((a) => a.mode === "primary" || a.mode === "all");
    const arg = args.trim();
    if (!arg || arg === "list") {
      const cur = ctx.thread?.agent ?? "(default)";
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
  const current = ctx.state.currentProjectDir ?? ctx.cwd;
  const dirs = new Set<string>([current, ...ctx.pool.list().map((s) => s.dir), ...ctx.state.listProjects().map((p) => p.dir)]);
  return [...dirs];
}

const projectName = (dir: string): string => dir.split("/").filter(Boolean).pop() ?? dir;

registerCommand({
  name: "project",
  usage: "\\project | \\project <name|#>",
  summary: "Swap projects by name (fuzzy) — fresh session via the same teardown as \\cd",
  detail: "`\\project cowork` or `\\project 2`; bare `\\project` lists candidates with numbers.",
  async run(ctx, args) {
    const q = args.trim();
    if (!q) {
      const current = ctx.state.currentProjectDir ?? ctx.cwd;
      const dirs = knownProjectDirs(ctx);
      const lines = [`*Current:* \`${current}\``];
      const rest = dirs.filter((d) => d !== current);
      rest.forEach((d, i) => {
        const pool = ctx.pool.list().find((s) => s.dir === d);
        lines.push(`${i + 1}) \`${projectName(d)}\` — ${d}${pool ? ` (server ${pool.status})` : ""}`);
      });
      if (!rest.length) lines.push("(no other known projects yet — use `\\cd /abs/path` once)");
      lines.push("`\\project <name|#>` to switch.");
      await ctx.postToThread(lines.join("\n"));
      return;
    }
    const dirs = knownProjectDirs(ctx).filter((d) => d !== (ctx.state.currentProjectDir ?? ctx.cwd));
    const n = Number(q);
    let dir: string | undefined;
    if (Number.isInteger(n) && n >= 1 && n <= dirs.length) dir = dirs[n - 1];
    else {
      const ql = q.toLowerCase();
      const hits = dirs.filter((d) => projectName(d).toLowerCase() === ql || d.toLowerCase().includes(ql));
      if (hits.length === 1) dir = hits[0];
      else       if (hits.length > 1) {
        await ctx.postToThread(`Ambiguous — ${hits.map((h) => `\`${projectName(h)}\``).join(", ")}. Use \`\\project <#>\` from the list.`);
        return;
      }
    }
    if (!dir) throw new Error(`no project matches \`${q}\` — try bare \`\\project\` for the list`);
    ctx.state.setCurrentProject(dir);
    await rebindThread(ctx, dir, `↔ Switched to \`${projectName(dir)}\`.`);
  },
});

registerCommand({
  name: "cd",
  usage: "\\cd /abs/path",
  summary: "Switch the current project dir — this thread gets a fresh session there",
  detail: "Accepts `~` paths. Old session + server are torn down so nothing leaks between projects.",
  async run(ctx, args) {
    if (!args) throw new Error("usage: \\cd /abs/path");
    const dir = requireDir(ctx, args);
    ctx.state.setCurrentProject(dir);
    await rebindThread(ctx, dir, "↔ Switched project.");
  },
});

registerCommand({
  name: "new",
  usage: "\\new [/abs/path]",
  summary: "Fresh session bound to this thread (optionally in a new project dir)",
  detail: "`\\new /abs/path` also switches the current project. Accepts `~` paths. The previous session is kept (\\resume recovers it).",
  async run(ctx, args) {
    if (args) {
      const dir = requireDir(ctx, args);
      ctx.state.setCurrentProject(dir);
      await rebindThread(ctx, dir, "✨ New project session.", { teardown: false });
      return;
    }
    const dir = ctx.state.currentProjectDir ?? ctx.cwd;
    await rebindThread(ctx, dir, "✨", { teardown: false });
  },
});

registerCommand({
  name: "sessions",
  usage: "\\sessions",
  summary: "List recent sessions in the current project",
  async run(ctx) {
    const dir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
    const entry = await ctx.pool.ensure(dir);
    const sessions = (await sessionList(entry.client!)).sort((a, b) => b.time.updated - a.time.updated).slice(0, 10);
    if (!sessions.length) {
      await ctx.postToThread(`No sessions yet in \`${dir}\`.`);
      return;
    }
    const lines = sessions.map((s, i) => {
      const sum = s.summary ? ` +${s.summary.additions}/−${s.summary.deletions}` : "";
      const mine = ctx.thread?.sessionId === s.id ? " ← this thread" : "";
      return `${i + 1}) \`${shortId(s.id)}\` ${truncate(esc(s.title), 40)}${sum} · ${age(s.time.updated)}${mine}`;
    });
    await ctx.postToThread([`*Sessions in* \`${dir}\``, ...lines, "`\\resume <# or id>` to bind this thread to one."].join("\n"));
  },
});

registerCommand({
  name: "resume",
  usage: "\\resume <# or session id>",
  summary: "Bind this thread to an existing session",
  async run(ctx, args) {
    if (!args) throw new Error("usage: \\resume <# or session id>");
    const dir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
    const entry = await ctx.pool.ensure(dir);
    const sessions = (await sessionList(entry.client!)).sort((a, b) => b.time.updated - a.time.updated).slice(0, 10);
    const n = Number(args);
    let target: string | undefined;
    if (Number.isInteger(n) && n >= 1 && n <= sessions.length) target = sessions[n - 1]?.id;
    else {
      const matches = sessions.filter((s) => s.id.includes(args));
      if (matches.length === 1) target = matches[0]?.id;
      else if (matches.length > 1) throw new Error(`ambiguous id \`${args}\` — be more specific`);
    }
    if (!target) throw new Error(`no session matches \`${args}\` — see \\sessions`);
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
    if (old && old.sessionId !== target) deleteView(old.sessionId);
    ctx.state.setThread(ctx.threadKey, { ...(old ?? newThreadState(target, dir)), sessionId: target, projectDir: dir });
    await ctx.postToThread(`↩️ Thread bound to session \`${shortId(target)}\`. Reply here to continue it.`);
  },
});

registerCommand({
  name: "stop",
  usage: "\\stop",
  summary: "Abort the running task in this thread",
  async run(ctx) {
    const th = requireThread(ctx);
    // Finalized views leave the registry, so an absent view = nothing in flight.
    if (!getView(th.sessionId)) {
      await ctx.postToThread("Nothing running in this thread.");
      return;
    }
    const entry = await serverFor(ctx, th);
    await sessionAbort(entry.client!, th.sessionId);
    await ctx.postToThread("🛑 Aborted.");
  },
});

registerCommand({
  name: "projects",
  usage: "\\projects",
  summary: "Alias for \\project",
  aliasOf: "project",
  async run() {},
});

registerCommand({
  name: "abort",
  usage: "\\abort",
  summary: "Alias for \\stop",
  aliasOf: "stop",
  async run() {},
});

/** Per-file diffstat lines + a totals header — shared by `\diff` and the DM "View diff" button (RF1). */
export function formatDiffSummary(diffs: OcFileDiff[]): string {
  const totals = diffs.reduce(
    (a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }),
    { add: 0, del: 0 },
  );
  const lines = diffs.map((d) => `  \`+${d.additions}/−${d.deletions}\` ${shortPath(d.file)}`);
  return [`*Diff:* +${totals.add}/−${totals.del} across ${diffs.length} file(s)`, ...lines].join("\n");
}

/** Unified diff across files with real changes — shared by `\diff full` and the RF1 button. Empty when nothing changed. */
export function buildUnifiedDiff(diffs: OcFileDiff[]): string {
  return diffs
    .filter((d) => d.before !== d.after)
    .map((d) => createTwoFilesPatch(`a/${d.file}`, `b/${d.file}`, d.before, d.after, undefined, undefined, { context: 3 }))
    .join("\n")
    .trim();
}

registerCommand({
  name: "diff",
  usage: "\\diff | \\diff full",
  summary: "Diff summary for this thread's session; `full` adds the unified diff",
  async run(ctx, args) {
    const th = requireThread(ctx);
    const entry = await serverFor(ctx, th);
    const diffs = await sessionDiff(entry.client!, th.sessionId);
    if (!diffs.length) {
      await ctx.postToThread("(no tracked edits in this session yet)");
      return;
    }
    await ctx.postToThread(formatDiffSummary(diffs));
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
  usage: "\\cmd <opencode command> [args]",
  summary: "Run an OpenCode native command in this session (passthrough)",
  detail: "e.g. `\\cmd compact` — same as typing the command in the OpenCode TUI.",
  async run(ctx, args) {
    if (!args) throw new Error("usage: \\cmd <command> [args]");
    const th = requireThread(ctx);
    const space = args.indexOf(" ");
    const command = space < 0 ? args : args.slice(0, space);
    const commandArgs = space < 0 ? "" : args.slice(space + 1);
    const entry = await serverFor(ctx, th);
    const result = (await sessionCommand(entry.client!, th.sessionId, command, commandArgs)) as {
      parts?: Array<{ type: string; text?: string }>;
    };
    const texts = (result?.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text!);
    await ctx.postToThread(texts.length ? texts.join("\n\n") : `Command \`${command}\` executed (no text output).`);
  },
});

export { newThreadState };
