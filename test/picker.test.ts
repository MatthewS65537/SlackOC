import { describe, expect, it } from "vitest";
import type { CmdCtx } from "../src/commands/registry.js";
import { StateStore } from "../src/state.js";
import {
  SESSION_LIST_CAP,
  invalidatePickerCache,
  noteSessionActivity,
  pickerList,
  pickerResolve,
  renderPickerList,
  type SessionRef,
} from "../src/commands/picker.js";
import type { OcSession } from "../src/opencode/api.js";

let fixtureCounter = 0;

function sess(id: string, dir: string, title: string, ageMs: number, summary?: OcSession["summary"]): OcSession {
  const updated = Date.now() - ageMs;
  return { id, directory: dir, title, summary, time: { created: updated - 1000, updated } };
}

function mkCtx(sessions: OcSession[], opts: { threadSession?: string; cwd?: string; threadDir?: string } = {}): CmdCtx {
  const state = new StateStore(`${import.meta.dirname}/.fixtures/picker-${++fixtureCounter}/state.json`);
  const thread = opts.threadSession
    ? { sessionId: opts.threadSession, projectDir: opts.threadDir ?? "/p", verbose: "on" as const, createdAt: 1, lastUsedAt: 1 }
    : null;
  if (thread) state.setThread("C1:T1", thread);
  return {
    channelId: "C1",
    threadTs: "T1",
    threadKey: "C1:T1",
    thread: thread ? state.getThread("C1:T1") : null,
    state,
    config: null as never,
    cwd: opts.cwd ?? "/p",
    pool: {
      ensure: async () => ({ client: { session: { list: async () => ({ data: sessions }) } } }),
      list: () => [],
    } as never,
    postToThread: async () => {},
    uploadToThread: async () => {},
  } as unknown as CmdCtx;
}

describe("pickerList (machine-wide per spike 2: GET /session is global)", () => {
  const A = sess("ses_aaa", "/p", "Alpha", 5_000);
  const B = sess("ses_bbb", "/other", "Beta", 60_000);
  const C = sess("ses_ccc", "/third", "Gamma", 120_000);

  it("one server call covers every project dir; scope=all keeps all", async () => {
    const ctx = mkCtx([A, B, C]);
    const { refs, total } = await pickerList(ctx, { scope: "all" });
    expect(total).toBe(3);
    expect(refs.map((r) => r.projectDir)).toEqual(["/p", "/other", "/third"]);
    expect(refs[0]!.sessionId).toBe("ses_aaa"); // sorted by updated desc
  });

  it("scope=project keeps the classic current-project behavior", async () => {
    const ctx = mkCtx([A, B, C]);
    const { refs, total } = await pickerList(ctx, { scope: "project" });
    expect(total).toBe(1);
    expect(refs.map((r) => r.sessionId)).toEqual(["ses_aaa"]);
  });

  it("filter narrows by title or id substring, machine-wide", async () => {
    const ctx = mkCtx([A, B, C]);
    const byTitle = await pickerList(ctx, { scope: "all", filter: "bet" });
    expect(byTitle.total).toBe(1);
    expect(byTitle.refs[0]!.sessionId).toBe("ses_bbb");
    const byId = await pickerList(ctx, { scope: "all", filter: "ccc" });
    expect(byId.refs[0]!.sessionId).toBe("ses_ccc");
    const none = await pickerList(ctx, { scope: "all", filter: "zzz" });
    expect(none.total).toBe(0);
  });

  it("caps at 10 with the pre-cap total intact", async () => {
    const many = Array.from({ length: SESSION_LIST_CAP + 5 }, (_, i) => sess(`ses_${String(i).padStart(3, "0")}`, "/p", `s${i}`, i * 1000));
    const ctx = mkCtx(many);
    const { refs, total } = await pickerList(ctx, { scope: "all" });
    expect(total).toBe(SESSION_LIST_CAP + 5);
    expect(refs.length).toBe(SESSION_LIST_CAP);
  });

  it("marks bound sessions and ▶ running from the activity map", async () => {
    noteSessionActivity("ses_bbb", true);
    const ctx = mkCtx([A, B, C], { threadSession: "ses_aaa" });
    const { refs } = await pickerList(ctx, { scope: "all" });
    expect(refs[0]!.mine).toBe(true);
    expect(refs[0]!.boundThreadKey).toBe("C1:T1");
    expect(refs[1]!.running).toBe(true);
    expect(refs[2]!.running).toBe(false);
    invalidatePickerCache("C1:T1");
  });

  it("recency fallback marks fresh sessions active? (TUI activity is invisible to SSE)", async () => {
    const fresh = sess("ses_fresh", "/p", "Just touched", 30_000);
    const ctx = mkCtx([fresh]);
    const { refs } = await pickerList(ctx, { scope: "all" });
    expect(refs[0]!.recent).toBe(true);
    expect(refs[0]!.running).toBe(false);
  });
});

describe("renderPickerList (smart cap + markers)", () => {
  const ref = (over: Partial<SessionRef>): SessionRef => ({
    sessionId: "ses_xxx",
    projectDir: "/p",
    title: "T",
    updated: Date.now() - 60_000,
    running: false,
    recent: false,
    mine: false,
    ...over,
  });

  it("shows markers: ▶ running / ? active? / · idle, bound + mine tags", () => {
    const out = renderPickerList(
      [ref({ sessionId: "ses_run", running: true, mine: true }), ref({ sessionId: "ses_recent", recent: true }), ref({ sessionId: "ses_idle", boundThreadKey: "C2:T9" })],
      { heading: "*Sessions*", total: 3 },
    );
    // shortId renders the middle slice of the id (ses_run → "run")
    expect(out).toContain("1) `run`");
    expect(out).toContain("▶ running ← this thread");
    expect(out).toContain("? active?");
    expect(out).toContain("· idle · bound");
  });

  it("shows the (+N older) hint when capped", () => {
    const refs = Array.from({ length: 10 }, (_, i) => ref({ sessionId: `ses_${i}` }));
    const out = renderPickerList(refs, { heading: "*Sessions*", total: 23 });
    expect(out).toContain("(+13 older — narrow with \\sessions <filter>, or \\sessions all)");
  });

  it("empty scope renders a none line", () => {
    expect(renderPickerList([], { heading: "*Sessions*", total: 0 })).toContain("(none)");
  });
});

describe("pickerResolve (stable numbers per the design)", () => {
  it("# resolves against what the user SAW, even when the server order has drifted", async () => {
    const A = sess("ses_aaa", "/p", "Alpha", 20_000); // older
    const B = sess("ses_bbb", "/p", "Beta", 10_000); // newer → displayed first
    const ctx = mkCtx([A, B]); // displayed: 1=B, 2=A
    const { refs } = await pickerList(ctx, { scope: "all" });
    expect(refs.map((r) => r.sessionId)).toEqual(["ses_bbb", "ses_aaa"]);
    // Server now returns the flipped order — the cached list still wins.
    (ctx.pool as { ensure: (d: string) => Promise<{ client: unknown }> }).ensure = async () => ({
      client: { session: { list: async () => ({ data: [B, A] }) } },
    });
    const pick = await pickerResolve(ctx, "2");
    expect(pick.kind).toBe("ref");
    if (pick.kind === "ref") expect(pick.ref.sessionId).toBe("ses_aaa");
  });

  it("an expired list makes the pick stale: fresh list, user picks again", async () => {
    const A = sess("ses_aaa", "/p", "Alpha", 10_000);
    const B = sess("ses_bbb", "/p", "Beta", 20_000);
    const ctx = mkCtx([A, B]);
    await pickerList(ctx, { scope: "all" }); // cache written "now"
    const later = Date.now() + 11 * 60_000; // past the 10 min TTL
    const pick = await pickerResolve(ctx, "1", later);
    expect(pick.kind).toBe("stale");
    if (pick.kind === "stale") {
      expect(pick.total).toBe(2);
      expect(pick.list.length).toBe(2);
    }
  });

  it("out-of-range numbers error against the seen list", async () => {
    const ctx = mkCtx([sess("ses_aaa", "/p", "Alpha", 10_000)]);
    await pickerList(ctx, { scope: "all" });
    await expect(pickerResolve(ctx, "5")).rejects.toThrow(/no session #5/);
  });

  it("id substrings search the FULL machine-wide list, not just the cap", async () => {
    const many = Array.from({ length: SESSION_LIST_CAP + 3 }, (_, i) =>
      sess(`ses_${String(i).padStart(3, "0")}`, "/p", `s${i}`, i * 1000),
    );
    const needle = sess("ses_zneedle", "/deep/dir", "Hidden", 500);
    const ctx = mkCtx([...many, needle]);
    const pick = await pickerResolve(ctx, "zneedle");
    expect(pick.kind).toBe("ref");
    if (pick.kind === "ref") {
      expect(pick.ref.sessionId).toBe("ses_zneedle");
      expect(pick.ref.projectDir).toBe("/deep/dir");
    }
  });

  it("ambiguous ids error; unknown ids error with a hint", async () => {
    const ctx = mkCtx([sess("ses_abcd", "/p", "a", 1000), sess("ses_abce", "/p", "b", 2000)]);
    await expect(pickerResolve(ctx, "abc")).rejects.toThrow(/ambiguous/);
    await expect(pickerResolve(ctx, "zzzzz")).rejects.toThrow(/no session matches/);
  });

  it("invalidatePickerCache forces a stale re-pick", async () => {
    const ctx = mkCtx([sess("ses_aaa", "/p", "Alpha", 10_000)]);
    await pickerList(ctx, { scope: "all" });
    invalidatePickerCache("C1:T1");
    const pick = await pickerResolve(ctx, "1");
    expect(pick.kind).toBe("stale");
  });
});
