/**
 * C2/E2: the App Home tab as the owner's live inbox — running sessions (Stop),
 * items waiting on the owner (Approve once / Deny), saved-prompt quick actions
 * (D1), scheduled reports and today's usage. Published when the owner opens the
 * tab (at most once per 10s), then kept current: state changes call
 * scheduleRefresh(), which republishes within 5s, but only after the owner has
 * opened Home since boot. views.publish is silent (no notification, no badge),
 * so a live Home never breaks the no-unsolicited-DM rule.
 */
import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import type { ServerPool } from "../opencode/server.js";
import type { PermissionRecord } from "./permissions-store.js";
import type { QuestionSnapshot } from "./questions-store.js";
import type { HomeReport } from "../schedules/slack.js";
import type { BridgeDeps } from "./router.js";
import { sessionStats } from "../opencode/client.js";
import { formatUsage, rangeStart, dayKeys } from "../commands/usage.js";
import { stopThreadFromButton } from "../commands/handlers.js";
import { MAX_QUICK_RUN, QUICK_RUN_PATTERN, quickRunBlock } from "../commands/prompts.js";
import { describeActiveRuns } from "./render.js";
import { runViaCarrier } from "./shortcut.js";
import { boundedSection, permissionDetail } from "./blocks.js";
import { dur, esc, truncate } from "../util.js";
import { logErr } from "../log.js";

export const HOME_STOP = "home_stop";
export const HOME_PERM_ONCE = "home_perm_once";
export const HOME_PERM_DENY = "home_perm_deny";
export const HOME_REFRESH_MS = 5_000;

/** What a Home approval sends back to the shared permission respond path. */
export interface HomePerm { k: string; s: string; p: string; g: number }

export interface HomeData {
  /** `threadKey` adds a Stop button. */
  runs: Array<{ project: string; url: string | null; elapsedMs: number; queued: number; threadKey?: string }>;
  /** `perm` adds Approve once / Deny buttons. */
  /** `detail`: preformatted mrkdwn lines (a permission's pattern/command/file), so Approve isn't blind. */
  waiting: Array<{ kind: "permission" | "question"; title: string; project: string; url: string | null; perm?: HomePerm; detail?: string[] }>;
  /** Saved prompt names (D1), shown as ▶ quick actions. */
  prompts?: string[];
  /** `last` is the newest run's outcome (controls.ts lastRunStatus), so a skipped report shows here (#34). */
  reports: Array<Pick<HomeReport, "name" | "enabled" | "nextRunAt" | "last">>;
  /** Formatted usage lines, or null when no server could answer. */
  usage: string | null;
  /** Why the last Home button didn't go through (e.g. a stale approval); shown once. */
  notice?: string;
}

// Block budget (Slack allows 100 per Home view): rows are capped at MAX_ROWS per
// section and use at most 2 blocks each, so the worst case stays under 50.
const MAX_ROWS = 10;
const project = (dir: string): string => dir.split("/").filter(Boolean).pop() ?? dir;
const link = (url: string | null, text: string): string => url ? `<${url}|${esc(text)}>` : esc(text);
const header = (text: string) => ({ type: "header", text: { type: "plain_text", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const button = (text: string, action_id: string, value: string, style?: "primary" | "danger", confirm?: unknown) =>
  ({ type: "button", text: { type: "plain_text", text }, action_id, value, ...(style ? { style } : {}), ...(confirm ? { confirm } : {}) });
const plain = (text: string) => ({ type: "plain_text", text });
const STOP_CONFIRM = { title: plain("Stop this run?"), text: plain("Aborts the run and cancels its queued messages."), confirm: plain("Stop"), deny: plain("Keep running") };

/** A text list in one section block. */
function section(title: string, rows: string[], empty: string): unknown[] {
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length > MAX_ROWS) shown.push(`_…and ${rows.length - MAX_ROWS} more_`);
  return [header(title), rows.length ? { type: "section", text: { type: "mrkdwn", text: boundedSection(shown.join("\n")) } } : context(empty)];
}

/** One block group per row, for rows that carry buttons. */
function rowSection(title: string, rows: unknown[][], empty: string): unknown[] {
  if (!rows.length) return [header(title), context(empty)];
  return [header(title), ...rows.slice(0, MAX_ROWS).flat(), ...(rows.length > MAX_ROWS ? [context(`_…and ${rows.length - MAX_ROWS} more_`)] : [])];
}

/** Pure: the owner's Home tab from a snapshot. */
export function homeView(d: HomeData): { type: "home"; blocks: unknown[] } {
  const when = (ms: number) => `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${new Date(ms).toISOString()}>`;
  const row = (text: string, accessory?: unknown) => ({ type: "section", text: { type: "mrkdwn", text: boundedSection(text) }, ...(accessory ? { accessory } : {}) });
  const prompts = d.prompts ?? [];
  return { type: "home", blocks: [
    ...(d.notice ? [context(`⚠️ ${esc(d.notice)}`)] : []),
    ...rowSection("Running", d.runs.map(r => [row(`▶ ${link(r.url, r.project)} · ${dur(r.elapsedMs)}${r.queued ? ` · ${r.queued} queued` : ""}`,
      r.threadKey ? button("■ Stop", HOME_STOP, r.threadKey, "danger", STOP_CONFIRM) : undefined)]),
    "Nothing running."),
    ...rowSection("Waiting on you", d.waiting.map(w => {
      const text = row([`${w.kind === "permission" ? "🔐" : "❓"} ${link(w.url, w.project)} · ${esc(truncate(w.title, 120))}`, ...w.detail ?? []].join("\n"));
      if (!w.perm) return [text];
      const value = JSON.stringify(w.perm);
      return [text, { type: "actions", elements: [button("✓ Approve once", HOME_PERM_ONCE, value, "primary"), button("✕ Deny", HOME_PERM_DENY, value, "danger")] }];
    }), "Nothing is waiting on you."),
    header("Quick actions"),
    prompts.length ? quickRunBlock(prompts) : context("Save a prompt with `\\save <name> <prompt…>` to run it from here."),
    ...(prompts.length > MAX_QUICK_RUN ? [context(`_…and ${prompts.length - MAX_QUICK_RUN} more; \`\\saved\` lists them all._`)] : []),
    ...section("Reports", d.reports.map(r => `${r.enabled ? "🗓" : "⏸"} *${esc(r.name)}*${r.enabled ? ` · next ${when(r.nextRunAt)}` : " · paused"}${r.last ? ` · last ${r.last}` : ""}`),
      "No scheduled reports. Add one with `\\schedule add`."),
    ...section("Today", d.usage ? [d.usage] : [], "Usage is unavailable until an OpenCode server is running."),
    context(`Updated ${when(Date.now())}`),
  ] };
}

export function notOwnerView(): { type: "home"; blocks: unknown[] } {
  return { type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "This SlackOC belongs to someone else." } }] };
}

function parsePerm(raw: unknown): HomePerm | undefined {
  try {
    const v = JSON.parse(String(raw)) as HomePerm;
    return v && typeof v === "object" && typeof v.k === "string" ? v : undefined;
  } catch { return; }
}

export function registerHome(app: App, deps: {
  ownerSlackUserId: string;
  state: StateStore;
  pool: ServerPool;
  permissions: { list(): PermissionRecord[] };
  questions: { list(): QuestionSnapshot[] };
  reports: () => HomeReport[];
  threadUrl: (threadKey: string) => string | null;
  isStopping: () => boolean;
  /** Stop, approvals (bridge.permissions.respond), saved prompts and their carrier runs. */
  bridge: BridgeDeps;
}): { scheduleRefresh(): void } {
  const { state, bridge } = deps;
  const owner = deps.ownerSlackUserId;
  const lastPublish = new Map<string, number>();
  let notice: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let publishing = Promise.resolve();

  async function todayUsage(): Promise<string | null> {
    const dir = state.currentProjectDir;
    const client = (dir ? deps.pool.get(dir) : null)?.client;
    if (!client) return null;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const from = rangeStart(1, now);
    const stats = await sessionStats(client, { from: from.getTime(), to: now.getTime(), timezone, tools: "none" });
    // Drop formatUsage's own heading; the tab already says "Today".
    return formatUsage(stats, { scope: "all projects", range: "today", days: dayKeys(from, 1, timezone) }).split("\n").slice(1).join("\n");
  }

  async function snapshot(): Promise<HomeData> {
    const waiting: HomeData["waiting"] = [
      ...deps.permissions.list().filter(r => r.response.status !== "resolved").map(r => ({ kind: "permission" as const,
        title: r.permission.title || r.permission.type, detail: permissionDetail(r.permission),
        project: project(state.getThread(r.threadKey)?.projectDir ?? "?"), url: deps.threadUrl(r.threadKey),
        perm: { k: r.threadKey, s: r.sessionId, p: r.requestId, g: r.generation } })),
      ...deps.questions.list().filter(q => q.response !== "resolved").map(q => ({ kind: "question" as const,
        title: q.req.questions[0]?.question ?? "Question", project: project(q.projectDir), url: deps.threadUrl(`${q.channel}:${q.threadTs}`) })),
    ];
    return {
      // No Stop for a \watch view: it would interrupt a session the TUI is driving.
      runs: describeActiveRuns().map(r => ({ project: project(r.projectDir), url: deps.threadUrl(r.threadKey), elapsedMs: r.elapsedMs, queued: r.queued,
        threadKey: r.watching ? undefined : r.threadKey })),
      waiting,
      prompts: bridge.prompts?.list().map(p => p.name),
      reports: deps.reports().sort((a, b) => a.nextRunAt - b.nextRunAt),
      usage: await todayUsage().catch(err => { logErr(`home usage failed: ${String(err)}`); return null; }),
    };
  }

  /** Serialized, so an older snapshot never lands after a newer one. A pending notice shows once. */
  function publishOwner(): Promise<void> {
    publishing = publishing.then(async () => {
      if (deps.isStopping()) return;
      lastPublish.set(owner, Date.now());
      const data = await snapshot();
      const shown = notice;
      notice = undefined;
      await app.client.views.publish({ user_id: owner, view: homeView({ ...data, notice: shown }) as never });
    }).catch(err => logErr(`home tab publish failed: ${String((err as Error)?.message ?? err)}`));
    return publishing;
  }

  /** Coalesces bursts: the first change arms one publish HOME_REFRESH_MS later; later changes ride along. */
  function scheduleRefresh(): void {
    if (timer || deps.isStopping() || !lastPublish.has(owner)) return;
    timer = setTimeout(() => { timer = undefined; void publishOwner(); }, HOME_REFRESH_MS);
    timer.unref?.();
  }

  app.event("app_home_opened", async ({ event }) => {
    if (deps.isStopping() || event.tab !== "home") return;
    const user = event.user;
    const now = Date.now();
    if (now - (lastPublish.get(user) ?? 0) < 10_000) return;
    lastPublish.set(user, now);
    if (user === owner) return publishOwner();
    await app.client.views.publish({ user_id: user, view: notOwnerView() as never })
      .catch(err => logErr(`home tab publish failed: ${String((err as Error)?.message ?? err)}`));
  });

  // Home buttons: owner only (others see notOwnerView, so a click from them is forged). Each republishes at once.
  const isOwner = (body: { user: { id: string } }) => !deps.isStopping() && body.user.id === owner;

  app.action(HOME_STOP, async ({ ack, body, action }) => {
    await ack();
    if (!isOwner(body)) return;
    await stopThreadFromButton(bridge, String((action as { value?: string }).value ?? ""));
    await publishOwner();
  });

  for (const [actionId, response] of [[HOME_PERM_ONCE, "once"], [HOME_PERM_DENY, "reject"]] as const) {
    app.action(actionId, async ({ ack, body, action }) => {
      await ack();
      if (!isOwner(body)) return;
      const v = parsePerm((action as { value?: string }).value);
      if (!v || !bridge.permissions) return;
      try {
        // The card buttons' respond path: its lock, pending re-check, and card collapse all apply.
        const result = await bridge.permissions.respond({ actor: body.user.id, requestId: v.p, response,
          sessionId: v.s, generation: v.g, source: "live", context: { threadKey: v.k } });
        if (result.notificationError) logErr(`permission result delivery failed: ${result.notificationError}`);
        if (result.status !== "resolved") notice = result.text;
      } catch (err) {
        logErr(`home permission respond failed: ${String((err as Error)?.message ?? err)}`);
        notice = `Failed to reply to OpenCode: ${truncate(String((err as Error)?.message ?? err), 200)}`;
      }
      await publishOwner();
    });
  }

  // ▶ quick actions (D1). Home: a new carrier root in the owner DM. A `\saved` card: that card's thread.
  app.action(QUICK_RUN_PATTERN, async ({ ack, body, action, respond }) => {
    await ack();
    if (deps.isStopping()) return;
    if (body.user.id !== owner) {
      // A `\saved` card in a shared channel is visible to others; Home never is.
      await respond?.({ text: "Only the paired owner can run saved prompts.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const name = String((action as { value?: string }).value ?? "");
    const env = body as { channel?: { id?: string }; message?: { ts?: string; thread_ts?: string }; container?: { thread_ts?: string } };
    const channel = env.channel?.id ?? bridge.ownerDmChannel?.();
    if (!name || !channel) return;
    const root = env.channel?.id ? env.message?.thread_ts ?? env.container?.thread_ts ?? env.message?.ts : undefined;
    try {
      // `\run` expands in the router, so binding, pins and queueing match a typed prompt.
      await runViaCarrier(bridge, channel, root, `▶ *${esc(name)}*`, { text: `\\run ${name}` });
    } catch (err) {
      logErr(`quick run failed (${name}): ${String((err as Error)?.message ?? err)}`);
    }
  });

  return { scheduleRefresh };
}
