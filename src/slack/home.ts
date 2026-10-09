/**
 * C2: the App Home tab as a pull-based inbox — running sessions, items waiting
 * on the owner, scheduled reports and today's usage. Published only when the
 * owner opens the tab (never in the background), at most once per 10s.
 */
import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import type { ServerPool } from "../opencode/server.js";
import type { PermissionRecord } from "./permissions-store.js";
import type { QuestionSnapshot } from "./questions-store.js";
import type { ScheduleJob } from "../schedules/store.js";
import { sessionStats } from "../opencode/client.js";
import { formatUsage, rangeStart, dayKeys } from "../commands/usage.js";
import { describeActiveRuns } from "./render.js";
import { boundedSection } from "./blocks.js";
import { dur, esc, truncate } from "../util.js";
import { logErr } from "../log.js";

export interface HomeData {
  runs: Array<{ project: string; url: string | null; elapsedMs: number; queued: number }>;
  waiting: Array<{ kind: "permission" | "question"; title: string; project: string; url: string | null }>;
  reports: Array<Pick<ScheduleJob, "name" | "enabled" | "nextRunAt">>;
  /** Formatted usage lines, or null when no server could answer. */
  usage: string | null;
}

const MAX_ROWS = 10;
const project = (dir: string): string => dir.split("/").filter(Boolean).pop() ?? dir;
const link = (url: string | null, text: string): string => url ? `<${url}|${esc(text)}>` : esc(text);

function section(title: string, rows: string[], empty: string): unknown[] {
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length > MAX_ROWS) shown.push(`_…and ${rows.length - MAX_ROWS} more_`);
  return [
    { type: "header", text: { type: "plain_text", text: title } },
    rows.length ? { type: "section", text: { type: "mrkdwn", text: boundedSection(shown.join("\n")) } }
      : { type: "context", elements: [{ type: "mrkdwn", text: empty }] },
  ];
}

/** Pure: the owner's Home tab from a snapshot. */
export function homeView(d: HomeData): { type: "home"; blocks: unknown[] } {
  const when = (ms: number) => `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${new Date(ms).toISOString()}>`;
  return { type: "home", blocks: [
    ...section("Running", d.runs.map(r => `▶ ${link(r.url, r.project)} · ${dur(r.elapsedMs)}${r.queued ? ` · ${r.queued} queued` : ""}`),
      "Nothing running."),
    ...section("Waiting on you", d.waiting.map(w => `${w.kind === "permission" ? "🔐" : "❓"} ${link(w.url, w.project)} · ${esc(truncate(w.title, 120))}`),
      "Nothing is waiting on you."),
    ...section("Reports", d.reports.map(r => `${r.enabled ? "🗓" : "⏸"} *${esc(r.name)}*${r.enabled ? ` · next ${when(r.nextRunAt)}` : " · paused"}`),
      "No scheduled reports. Add one with `\\schedule add`."),
    ...section("Today", d.usage ? [d.usage] : [], "Usage is unavailable until an OpenCode server is running."),
    { type: "context", elements: [{ type: "mrkdwn", text: `Snapshot from ${when(Date.now())}. Reopen the tab to refresh.` }] },
  ] };
}

export function notOwnerView(): { type: "home"; blocks: unknown[] } {
  return { type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "This SlackOC belongs to someone else." } }] };
}

export function registerHome(app: App, deps: {
  ownerSlackUserId: string;
  state: StateStore;
  pool: ServerPool;
  permissions: { list(): PermissionRecord[] };
  questions: { list(): QuestionSnapshot[] };
  reports: () => ScheduleJob[];
  threadUrl: (threadKey: string) => string | null;
  isStopping: () => boolean;
}): void {
  const { state } = deps;
  const lastPublish = new Map<string, number>();

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
        title: r.permission.title || r.permission.type, project: project(state.getThread(r.threadKey)?.projectDir ?? "?"), url: deps.threadUrl(r.threadKey) })),
      ...deps.questions.list().filter(q => q.response !== "resolved").map(q => ({ kind: "question" as const,
        title: q.req.questions[0]?.question ?? "Question", project: project(q.projectDir), url: deps.threadUrl(`${q.channel}:${q.threadTs}`) })),
    ];
    return {
      runs: describeActiveRuns().map(r => ({ project: project(r.projectDir), url: deps.threadUrl(r.threadKey), elapsedMs: r.elapsedMs, queued: r.queued })),
      waiting,
      reports: deps.reports().sort((a, b) => a.nextRunAt - b.nextRunAt),
      usage: await todayUsage().catch(err => { logErr(`home usage failed: ${String(err)}`); return null; }),
    };
  }

  app.event("app_home_opened", async ({ event }) => {
    if (deps.isStopping() || event.tab !== "home") return;
    const user = event.user;
    const now = Date.now();
    if (now - (lastPublish.get(user) ?? 0) < 10_000) return;
    lastPublish.set(user, now);
    try {
      const view = user === deps.ownerSlackUserId ? homeView(await snapshot()) : notOwnerView();
      await app.client.views.publish({ user_id: user, view: view as never });
    } catch (err) {
      logErr(`home tab publish failed: ${String((err as Error)?.message ?? err)}`);
    }
  });
}
