/**
 * Session picker shared by \sessions, \resume, \watch, \history and \summary:
 * one listing, one numbering, one resolution path.
 *
 * Grounded in two live spikes (2026-09-16, opencode 1.18.31):
 *  - `GET /session` is MACHINE-GLOBAL: a server rooted at dir A lists sessions
 *    created via other processes/servers on the box (shared on-disk storage),
 *    and accepts `?directory=` to scope it. So machine scope is a single call —
 *    no per-dir fan-out needed.
 *  - Cross-process SSE does NOT propagate (a TUI-driven session's events stay
 *    on the TUI's own server bus), so "running" markers come from two cheap
 *    signals instead of live events for every session: the process-wide
 *    activity map fed by `session.status` events (SlackOC's own servers), plus
 *    a recency fallback for TUI-driven sessions.
 */

import { sessionList } from "../opencode/client.js";
import type { OcSession } from "../opencode/api.js";
import { age, esc, shortId, truncate } from "../util.js";
import type { CmdCtx } from "./registry.js";

export interface SessionRef {
  sessionId: string;
  /** From OcSession.directory — the project the session belongs to. */
  projectDir: string;
  title: string;
  updated: number;
  summary?: { additions: number; deletions: number };
  /** Live busy signal from the SSE activity map (Slack-driven sessions). */
  running: boolean;
  /** Touched < RECENT_MS — shown as "active?" since TUI activity isn't visible here. */
  recent: boolean;
  /** Thread (channel:ts) this session is bound to, if any. */
  boundThreadKey?: string;
  /** Bound to the thread the command ran in. */
  mine: boolean;
}

/** Most-recent sessions shown before the "(+N older)" hint kicks in. */
export const SESSION_LIST_CAP = 10;
/** Recency fallback window for the "active?" marker (design: ~90s). */
const RECENT_MS = 90_000;
/** Activity-map entries older than this fall back to recency (a crashed run never sends idle). */
const ACTIVITY_TTL_MS = 15 * 60_000;
/** Stable-number cache TTL: how long the numbers a user saw stay authoritative. */
const LIST_TTL_MS = 10 * 60_000;

/**
 * sessionID → last known busy state, recorded from `session.status` /
 * `session.idle` SSE events BEFORE the view lookup (events for view-less
 * sessions are otherwise dropped — this map is why they must not be).
 */
const activity = new Map<string, { busy: boolean; at: number }>();

/** Called from the bridge's onPoolEvent for session.status/idle events. */
export function noteSessionActivity(sessionId: string, busy: boolean): void {
  if (!sessionId) return;
  activity.set(sessionId, { busy, at: Date.now() });
  if (activity.size > 500) {
    const cutoff = Date.now() - ACTIVITY_TTL_MS;
    for (const [k, v] of activity) if (v.at <= cutoff) activity.delete(k);
  }
}

/** The cache: threadKey → the list as last rendered (numbers must match what was shown). */
const listCache = new Map<string, { refs: SessionRef[]; at: number }>();

function cacheFresh(threadKey: string, now = Date.now()): SessionRef[] | null {
  const hit = listCache.get(threadKey);
  if (!hit) return null;
  if (now - hit.at > LIST_TTL_MS) return null;
  return hit.refs;
}

function cacheStore(threadKey: string, refs: SessionRef[]): void {
  listCache.set(threadKey, { refs, at: Date.now() });
  if (listCache.size > 100) {
    const first = listCache.keys().next().value;
    if (first) listCache.delete(first);
  }
}

/** Drop a thread's cached list — numbers it showed are no longer authoritative. */
export function invalidatePickerCache(threadKey: string): void {
  listCache.delete(threadKey);
}

const normDir = (d: string): string => (d ?? "").replace(/\/+$/, "");

/** Sort by recency and build display refs (markers, bound-thread info). */
function toRefs(ctx: CmdCtx, sessions: OcSession[], serverDir: string): SessionRef[] {
  const now = Date.now();
  const threadSessionId = ctx.thread?.sessionId;
  return [...sessions]
    .sort((a, b) => b.time.updated - a.time.updated)
    .map((s) => {
      const bound = ctx.state.findThreadBySession(s.id);
      const act = activity.get(s.id);
      return {
        sessionId: s.id,
        projectDir: s.directory ?? serverDir,
        title: s.title ?? "",
        updated: s.time.updated,
        summary: s.summary
          ? { additions: s.summary.additions, deletions: s.summary.deletions }
          : undefined,
        running: !!act?.busy && now - act.at <= ACTIVITY_TTL_MS,
        recent: now - s.time.updated < RECENT_MS,
        boundThreadKey: bound?.key,
        mine: bound != null && threadSessionId === s.id,
      };
    });
}

/**
 * Fetch machine-wide refs (uncapped). One server call: `GET /session` on any
 * local server lists every session in the shared on-disk storage (spike 2).
 */
export async function pickerRefs(ctx: CmdCtx): Promise<SessionRef[]> {
  const serverDir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
  const entry = await ctx.pool.ensure(serverDir);
  const raw = (await sessionList(entry.client!)) as OcSession[];
  return toRefs(ctx, raw, serverDir);
}

/**
 * Scoped + filtered + capped view for display. `scope: "project"` keeps the
 * classic current-project behavior (`\sessions` bare); `"all"` is machine-wide.
 * The capped list is cached per thread — that's what `#` numbers resolve
 * against, so they stay stable between \sessions and \resume.
 */
export async function pickerList(
  ctx: CmdCtx,
  opts: { scope: "project" | "all"; filter?: string } = { scope: "all" },
): Promise<{ refs: SessionRef[]; total: number }> {
  const all = await pickerRefs(ctx);
  const serverDir = ctx.thread?.projectDir ?? ctx.state.currentProjectDir ?? ctx.cwd;
  const q = opts.filter?.trim().toLowerCase();
  const inScope = all
    .filter((r) => (opts.scope === "all" ? true : normDir(r.projectDir) === normDir(serverDir)))
    .filter((r) => (q ? r.title.toLowerCase().includes(q) || r.sessionId.toLowerCase().includes(q) : true));
  const capped = inScope.slice(0, SESSION_LIST_CAP);
  if (capped.length) cacheStore(ctx.threadKey, capped);
  return { refs: capped, total: inScope.length };
}

/**
 * Render the picker list with running/idle markers. Numbers here are the ones
 * `\resume <#>` / `\watch <#>` resolve against (via the per-thread cache).
 */
export function renderPickerList(refs: SessionRef[], opts: { heading: string; total: number }): string {
  const hidden = Math.max(0, opts.total - refs.length);
  const lines: string[] = [`${opts.heading} — ${opts.total} session${opts.total === 1 ? "" : "s"}`];
  if (!refs.length) {
    lines.push("(none)");
    return lines.join("\n");
  }
  refs.forEach((r, i) => {
    const mark = r.running ? "▶ running" : r.recent ? "? active?" : "· idle";
    const sum = r.summary ? ` +${r.summary.additions}/−${r.summary.deletions}` : "";
    const bound = r.mine ? " ← this thread" : r.boundThreadKey ? " · bound" : "";
    lines.push(
      `${i + 1}) \`${shortId(r.sessionId)}\` ${truncate(esc(r.title || "(untitled)"), 40)}${sum} · ${age(r.updated)} · ${mark}${bound}`,
    );
  });
  if (hidden > 0) lines.push(`(+${hidden} older — narrow with \\sessions <filter>, or \\sessions all)`);
  lines.push("`\\resume <# or id>` binds this thread · `\\watch <# or id>` mirrors a computer-driven one.");
  return lines.join("\n");
}

export type ResolvedPick =
  | { kind: "ref"; ref: SessionRef }
  /** `#` given but the seen-list expired: fresh list attached, ask the user to pick again. */
  | { kind: "stale"; list: SessionRef[]; total: number };

/**
 * Resolve a picker argument to a session. `#N` (or bare N, for \resume's
 * existing UX) resolves against the list the user actually saw; expired or
 * missing cache ⇒ re-list and make them pick again (a stale number could bind
 * the wrong session). Non-numbers are id substrings over the machine-wide list.
 */
export async function pickerResolve(ctx: CmdCtx, arg: string, now = Date.now()): Promise<ResolvedPick> {
  const raw = arg.trim().replace(/^#/, "").trim();
  if (!raw) throw new Error("no session given — see \\sessions");
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && `${n}` === raw) {
    const cached = cacheFresh(ctx.threadKey, now);
    if (cached) {
      const ref = cached[n - 1];
      if (ref) return { kind: "ref", ref };
      throw new Error(`no session #${n} in the list you saw — \\sessions refreshes it`);
    }
    const fresh = await pickerList(ctx, { scope: "all" });
    return { kind: "stale", list: fresh.refs, total: fresh.total };
  }
  // Id substring: search the full machine-wide list (the display cap must not
  // hide a match — \resume's pre-picker behavior searched its own top-10, but
  // with one cheap global call there's no reason to keep that limit).
  const all = await pickerRefs(ctx);
  const matches = all.filter((r) => r.sessionId.includes(raw));
  if (matches.length === 1) return { kind: "ref", ref: matches[0]! };
  if (matches.length > 1) throw new Error(`ambiguous id \`${raw}\` — be more specific`);
  throw new Error(`no session matches \`${raw}\` — see \\sessions`);
}
