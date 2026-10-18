import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { App } from "@slack/bolt";
import { projectId, worktreeCreate, worktreeList, worktreeRemove } from "../opencode/client.js";
import type { ServerPool } from "../opencode/server.js";
import { canonicalDir } from "../paths.js";
import { execFileAsync, validBranchName, type ExecFileFn } from "../ship.js";
import { enqueue } from "../slack/queue.js";
import { getView, type RenderDeps } from "../slack/render.js";
import { sourceThreadTs } from "../slack/source-thread.js";
import type { StateStore } from "../state.js";
import { logErr } from "../log.js";
import { esc } from "../util.js";
import type { CmdCtx, CmdDef } from "./registry.js";

/**
 * Worktree per thread (opt-in): `\new --wt` / `\fork --wt` bind a thread to an
 * isolated checkout that OpenCode V2 creates with the project's canonical
 * strategy (and setup script); `\worktrees` lists and removes them.
 */

const errText = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 300);

/** Splits `--wt` out of a command's args: `\new --wt feat/x` → { wt, rest: "feat/x" }. */
export function takeWtFlag(args: string): { wt: boolean; rest: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  return { wt: words.includes("--wt"), rest: words.filter((w) => w !== "--wt").join(" ") };
}

/** Threads whose worktree is still being prepared: the router holds their prompts until the binding lands. */
const preparing = new Set<string>();
export const isPreparingWorktree = (threadKey: string): boolean => preparing.has(threadKey);
export const STILL_PREPARING = "⏳ Still preparing the worktree. Send that again once it's ready.";

/**
 * The `--wt` step shared by \new and \fork: post "preparing" into the thread,
 * create a worktree of `baseDir`'s project (its setup script can take minutes),
 * register the directory with the pool so its events route, then `bind` it.
 * With `fallback`, a failure binds that directory instead (with a warning) so
 * the thread is still usable; without, the error propagates.
 *
 * Null when nothing was bound: the thread was already preparing one, or the
 * owner rebound it meanwhile (\resume, \new, …), which the worktree must not
 * overwrite. Identity is the bound session, not bindingGeneration: the router
 * bumps that for every rebinding command, refused or failed ones included.
 */
export async function prepareWorktree(o: {
  pool: ServerPool; state: StateStore; threadKey: string; baseDir: string; branch?: string; fallback?: string;
  say: (text: string) => Promise<unknown>; bind: (dir: string) => Promise<void>;
}): Promise<string | null> {
  if (o.branch && !validBranchName(o.branch)) throw new Error(`\`${o.branch}\` isn't a valid branch name`);
  if (preparing.has(o.threadKey)) {
    await o.say(STILL_PREPARING);
    return null;
  }
  const boundId = o.state.getThread(o.threadKey)?.sessionId;
  const rebound = () => o.state.getThread(o.threadKey)?.sessionId !== boundId;
  preparing.add(o.threadKey);
  try {
    await o.say("⏳ preparing worktree…");
    try {
      const client = (await o.pool.ensure(o.baseDir)).client!;
      const dir = canonicalDir(await worktreeCreate(client, await projectId(client), o.branch));
      await o.pool.ensure(dir);
      if (rebound()) {
        await o.say(`⏭ The thread was rebound while the worktree was prepared; the worktree \`${esc(basename(dir))}\` is kept. \`\\wt\` removes it.`);
        return null;
      }
      await o.bind(dir);
      return dir;
    } catch (err) {
      if (o.fallback === undefined || rebound()) throw err;
      await o.bind(o.fallback);
      await o.say(`⚠️ Couldn't prepare a worktree (${esc(errText(err))}). This thread shares \`${o.fallback}\` instead.`);
      return o.fallback;
    }
  } finally {
    preparing.delete(o.threadKey);
  }
}

/** Git identity of a folder: the repo's shared .git dir plus the folder's path inside its checkout. */
async function repoIdentity(dir: string, exec: ExecFileFn): Promise<string | null> {
  try {
    const out = (await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix"], { cwd: dir, timeout: 10_000 })).stdout;
    return out.trim() ? out : null;
  } catch { return null; }
}

/** Channel pins: true when `dir` is another checkout (a worktree) of `pinned`'s repo, at the same subfolder. */
export async function sameProject(pinned: string, dir: string, exec: ExecFileFn = execFileAsync): Promise<boolean> {
  const [a, b] = await Promise.all([repoIdentity(pinned, exec), repoIdentity(dir, exec)]);
  return a !== null && a === b;
}

/** What removing `dir` would lose. No upstream counts as unpushed; a missing folder loses nothing. */
export async function worktreeRisks(dir: string, exec: ExecFileFn = execFileAsync): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const git = (...args: string[]) => exec("git", args, { cwd: dir, timeout: 15_000 }).then((r) => r.stdout.trim());
  try {
    const risks: string[] = [];
    if (await git("status", "--porcelain")) risks.push("uncommitted changes");
    const ahead = await git("log", "--oneline", "@{u}..").catch(() => null);
    if (ahead === null) risks.push("no upstream branch");
    else if (ahead) {
      const k = ahead.split("\n").length;
      risks.push(`${k} unpushed commit${k === 1 ? "" : "s"}`);
    }
    return risks;
  } catch {
    return ["a git state that couldn't be checked"];
  }
}

/** Button value: base dir (for a client), projectID, worktree dir, when the card was made (ms). */
interface WtTarget { b: string; p: string; d: string; at?: number }
export const WT_REMOVE_CONFIRM_ACTION = "wt_remove_confirm";

function removeCardBlocks(text: string, t: WtTarget): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements: [{ type: "button", style: "danger", text: { type: "plain_text", text: "Remove anyway" },
      action_id: WT_REMOVE_CONFIRM_ACTION, value: JSON.stringify(t) }] },
  ];
}

/**
 * A bound thread mid-run: removing its folder would pull it out from under the
 * run. A \watch mirror (watchOnly) isn't Slack's run, so it doesn't block.
 */
function busyThread(state: StateStore, dir: string): boolean {
  return state.threadsInDir(dir).some(({ thread }) => !thread.watchOnly && !!getView(thread.sessionId)?.isActive);
}

type WtRender = Pick<RenderDeps, "post" | "sessionStatus">;

/**
 * Remove the worktree, then unbind the threads that ran in it (their folder is
 * gone), each with a note and a closed native session status: their next
 * message starts a fresh session.
 */
async function removeWorktree(deps: { state: StateStore; pool: ServerPool; render?: WtRender }, t: WtTarget, force: boolean): Promise<string> {
  const client = (await deps.pool.ensure(t.b)).client!;
  await worktreeRemove(client, t.p, t.d, force);
  for (const { key } of deps.state.threadsInDir(t.d)) {
    deps.state.deleteThread(key);
    const sep = key.indexOf(":");
    const [channel, threadTs] = [key.slice(0, sep), key.slice(sep + 1)];
    void deps.render?.sessionStatus?.(channel, threadTs, "closed");
    await deps.render?.post(channel, threadTs,
      `🧹 This thread's worktree \`${esc(basename(t.d))}\` was removed, so the thread is unbound. Your next message here starts a fresh session.`,
      undefined, { unfurl: false }).catch(() => {});
  }
  await deps.pool.killOne(t.d).catch(() => {});
  return `🗑 Removed worktree \`${esc(basename(t.d))}\`.`;
}

/** Last `\wt` list per thread: `\wt remove <#>` resolves against what the owner saw, never a fresh reordered list. */
const shown = new Map<string, { b: string; p: string; dirs: string[]; at: number }>();
const LIST_TTL_MS = 30 * 60_000;

async function listWorktrees(ctx: CmdCtx): Promise<void> {
  const base = canonicalDir(ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd));
  const client = (await ctx.pool.ensure(base)).client!;
  const p = await projectId(client);
  const dirs = (await worktreeList(client, p)).map((w) => canonicalDir(w.directory));
  shown.delete(ctx.threadKey);
  if (!dirs.length) {
    await ctx.postToThread(`No worktrees of \`${esc(basename(base))}\` yet. \`\\new --wt\` or \`\\fork --wt\` makes one.`);
    return;
  }
  const lines = [`*Worktrees of* \`${esc(basename(base))}\``];
  dirs.forEach((d, i) => {
    const threads = ctx.state.threadsInDir(d).map(({ key }) => {
      if (key === ctx.threadKey) return "this thread";
      const url = ctx.threadUrl?.(key);
      return url ? `<${url}|thread>` : "a thread";
    });
    lines.push(`${i + 1}) \`${esc(basename(d))}\` — ${esc(d)} · ${threads.length ? threads.join(", ") : "no thread"}`);
  });
  lines.push("`\\wt remove <#>` removes one.");
  await ctx.postToThread(lines.join("\n"));
  shown.set(ctx.threadKey, { b: base, p, dirs, at: Date.now() });
  if (shown.size > 100) shown.delete(shown.keys().next().value!);
}

async function removeFromList(ctx: CmdCtx, arg: string): Promise<void> {
  if (!/^#?\d+$/.test(arg)) throw new Error("usage: \\wt remove <#>");
  const list = shown.get(ctx.threadKey);
  if (!list || Date.now() - list.at > LIST_TTL_MS) {
    await ctx.postToThread("No fresh worktree list in this thread. Run `\\wt` and pick a number from it.");
    return;
  }
  const d = list.dirs[Number(arg.replace(/^#/, "")) - 1];
  if (!d) throw new Error(`no worktree ${arg} in the list you saw — \`\\wt\` refreshes it`);
  if (busyThread(ctx.state, d)) {
    await ctx.postToThread("A run is active in that worktree's thread — use `\\stop` there first.");
    return;
  }
  const target = { b: list.b, p: list.p, d, at: Date.now() };
  const confirm = async (why: string) => {
    const text = `⚠️ Worktree \`${esc(basename(d))}\` has ${why}. Removing it may lose that work.`;
    await ctx.postToThread(text, removeCardBlocks(text, target));
  };
  const risks = await worktreeRisks(d);
  if (risks.length) return confirm(risks.join(" and "));
  try {
    await ctx.postToThread(await removeWorktree({ state: ctx.state, pool: ctx.pool, render: ctx.render }, target, false));
  } catch (err) {
    // Git looked clean, but OpenCode sees something that needs force: same confirmation.
    if ((err as { forceRequired?: boolean }).forceRequired) return confirm("changes OpenCode won't drop without force");
    throw err;
  }
}

export const worktreesCommand: CmdDef = {
  name: "worktrees",
  aliases: ["wt"],
  usage: "\\worktrees | \\wt remove <#>",
  summary: "List this project's worktrees and their threads, or remove one",
  detail: "`\\new --wt [branch]` and `\\fork --wt [n]` give a thread its own worktree so parallel runs don't share files. `\\wt remove <#>` asks first when the worktree has uncommitted or unpushed work, and unbinds its thread.",
  async run(ctx, args) {
    const [sub = "", arg = ""] = args.trim().split(/\s+/);
    if (!sub) return listWorktrees(ctx);
    if (sub === "remove" || sub === "rm") return removeFromList(ctx, arg);
    throw new Error("usage: \\worktrees | \\wt remove <#>");
  },
};

/** The confirmation card's "Remove anyway" button. Owner-only; the card is edited in place and loses its button. */
export function registerWorktreeControls(app: App, deps: {
  ownerSlackUserId: string; state: StateStore; pool: ServerPool; render: WtRender; isStopping: () => boolean;
}): void {
  app.action(WT_REMOVE_CONFIRM_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    if (deps.isStopping()) return;
    const say = (text: string) => respond({ text, response_type: "ephemeral", replace_original: false }).catch(() => {});
    if (body.user.id !== deps.ownerSlackUserId) {
      await say("Only the paired owner can use these controls.");
      return;
    }
    let t: WtTarget;
    try { t = JSON.parse((action as { value?: string }).value ?? ""); } catch { return; }
    const card = (body as { container?: { channel_id?: string; message_ts?: string } }).container;
    if (!t?.b || !t.p || !t.d || !card?.channel_id || !card.message_ts) return;
    const channel = card.channel_id, ts = card.message_ts;
    if (busyThread(deps.state, t.d)) {
      await say("A run is active in that worktree's thread — use `\\stop` there first.");
      return;
    }
    try {
      // The card only confirmed what the owner saw then: refuse stale cards, and anything that's
      // no longer one of OpenCode's worktrees (or is the project itself) before a forced remove.
      if (!t.at || Date.now() - t.at > LIST_TTL_MS) {
        await say("This confirmation expired. Run `\\wt` and `\\wt remove <#>` again.");
        return;
      }
      const client = (await deps.pool.ensure(t.b)).client!;
      const dirs = (await worktreeList(client, t.p)).map((w) => canonicalDir(w.directory));
      if (canonicalDir(t.d) === canonicalDir(t.b) || !dirs.includes(canonicalDir(t.d))) {
        await say("That folder isn't one of this project's worktrees anymore, so nothing was removed.");
        return;
      }
      const done = await removeWorktree({ state: deps.state, pool: deps.pool, render: deps.render }, t, true);
      await enqueue(() => app.client.chat.update({ channel, ts, text: done, blocks: [] }),
        { channel, method: "chat.update", lane: "interactive", thread: sourceThreadTs(body) })
        .catch((err) => logErr(`worktree card update failed: ${String(err)}`));
    } catch (err) {
      logErr(`worktree remove failed (${t.d}): ${errText(err)}`);
      await say(`That didn't work: ${errText(err)}`);
    }
  });
}
