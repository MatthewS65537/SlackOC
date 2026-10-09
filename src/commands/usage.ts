/** Pure helpers for `\usage`: argument parsing, day buckets, sparkline, Slack text. */
import type { SessionStatsInfo } from "@opencode/client";

export const USAGE_RANGES = { today: 1, "7d": 7, "30d": 30 } as const;
export type UsageRange = keyof typeof USAGE_RANGES;

/** `[today|7d|30d] [all]` in any order; default 7d for the current project. */
export function parseUsageArgs(args: string): { range: UsageRange; all: boolean } {
  let range: UsageRange = "7d"; let all = false;
  for (const token of args.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token === "all") all = true;
    else if (token in USAGE_RANGES) range = token as UsageRange;
    else throw new Error(`unknown argument \`${token}\` — usage: \`\\usage [today|7d|30d] [all]\``);
  }
  return { range, all };
}

/** Local midnight `days - 1` days before `now`, so the range covers `days` calendar days including today. */
export function rangeStart(days: number, now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

/** YYYY-MM-DD keys for each calendar day from `start` through `days` days, oldest first. */
export function dayKeys(start: Date, days: number, timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    d.setHours(12); // noon: immune to DST shifts at the day boundary
    return fmt.format(d);
  });
}

const BARS = "▁▂▃▄▅▆▇█";

/** One glyph per value, scaled to the max; zero days render as '·'. */
export function sparkline(values: number[]): string {
  const max = Math.max(0, ...values);
  return values.map((v) => v <= 0 || max <= 0 ? "·" : BARS[Math.min(7, Math.ceil((v / max) * 8) - 1)]!).join("");
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const LABELS: Record<UsageRange, string> = { today: "today", "7d": "last 7 days", "30d": "last 30 days" };

/** Slack mrkdwn reply. `todayCost` is shown only for multi-day ranges. */
export function formatUsage(stats: SessionStatsInfo, opts: { scope: string; range: UsageRange; days: string[]; todayCost?: number }): string {
  const t = stats.tokens;
  const cached = t.cache.read + t.cache.write;
  const lines = [
    `*Usage · ${opts.scope} · ${LABELS[opts.range]}*`,
    `*${money(stats.cost)}*${opts.range !== "today" && opts.todayCost !== undefined ? ` · today ${money(opts.todayCost)}` : ""}`,
    `${tokens(t.input + t.output + t.reasoning)} tokens${cached ? ` (+${tokens(cached)} cached)` : ""} · ${stats.sessions} session${stats.sessions === 1 ? "" : "s"} · ${stats.activeDays} active day${stats.activeDays === 1 ? "" : "s"}`,
  ];
  if (opts.days.length > 1) {
    const steps = new Map<string, number>();
    for (const a of stats.activity) steps.set(a.date.slice(0, 10), (steps.get(a.date.slice(0, 10)) ?? 0) + a.steps);
    lines.push(sparkline(opts.days.map((d) => steps.get(d) ?? 0)));
  }
  return lines.join("\n");
}
