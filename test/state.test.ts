import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_MESSAGE_RECEIPTS, StateStore, UNBOUND_RECEIPT_HORIZON_MS } from "../src/state.js";
import { canonicalDir } from "../src/paths.js";
import { replayFloor, timestampFromMs } from "../src/slack/recovery-policy.js";

// Test fixtures stay inside the project (never the system tmpdir). This suite
// owns its own subdir: suites run in parallel workers, so removing the shared
// .fixtures root while another suite writes flakes with ENOTEMPTY.
const FIXTURES = join(import.meta.dirname ?? __dirname, ".fixtures", "state");
const NOW = Date.parse("2026-09-22T00:00:00Z");
const ts = (n: number) => timestampFromMs(NOW - 60_000 + n);

function tempStore(name: string): { store: StateStore; path: string } {
  const path = join(FIXTURES, name, "state.json");
  return { store: new StateStore(path, () => NOW), path };
}

afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("round-trips a thread binding", () => {
    const { store: s } = tempStore("rt");
    const key = s.threadKey("C123", "123.456");
    expect(key).toBe("C123:123.456");
    s.setThread(key, { sessionId: "ses_x", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    const t = s.getThread(key);
    expect(t?.sessionId).toBe("ses_x");
    expect(t?.verbose).toBe("on");
  });
  it("persists across instances with 0600 perms", () => {
    const { store: s1, path } = tempStore("persist");
    const key = s1.threadKey("C", "T");
    s1.setThread(key, { sessionId: "ses_y", projectDir: "/q", verbose: "full", createdAt: 2, lastUsedAt: 2 });
    const s2 = new StateStore(path);
    expect(s2.getThread(key)?.sessionId).toBe("ses_y");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("findThreadBySession locates bindings", () => {
    const { store: s } = tempStore("bySession");
    s.setThread("C:1", { sessionId: "ses_a", projectDir: "/p", verbose: "off", createdAt: 1, lastUsedAt: 1 });
    expect(s.findThreadBySession("ses_a")?.key).toBe("C:1");
    expect(s.findThreadBySession("nope")).toBeNull();
  });
  it("setCurrentProject marks it and stores in projects", () => {
    const { store: s } = tempStore("curProj");
    s.setCurrentProject("/x/y");
    expect(s.currentProjectDir).toBe("/x/y");
    expect(s.listProjects()[0]?.dir).toBe("/x/y");
  });
  it("survives a corrupt state file", () => {
    const dir = join(FIXTURES, "corrupt");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    writeFileSync(path, "{not json");
    const s = new StateStore(path);
    expect(s.listProjects()).toEqual([]);
  });

  it("anyThreadInDir finds other threads on the same project (exceptKey excluded)", () => {
    const { store: s } = tempStore("inDir");
    s.setThread("C1:T1", { sessionId: "a", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    s.setThread("C1:T2", { sessionId: "b", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    expect(s.anyThreadInDir("/p")).toBe(true);
    expect(s.anyThreadInDir("/p", "C1:T1")).toBe(true); // C1:T2 still there
    expect(s.anyThreadInDir("/p", "C1:T1") && s.anyThreadInDir("/p", "C1:T2")).toBe(true);
    s.deleteThread("C1:T2");
    expect(s.anyThreadInDir("/p", "C1:T1")).toBe(false); // C1:T1 is the only one
    expect(s.anyThreadInDir("/elsewhere")).toBe(false);
  });

  it("evicts threads idle for 60+ days on save, keeps fresh ones", () => {
    const dir = join(FIXTURES, "prune");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    const old = Date.now() - 61 * 24 * 60 * 60 * 1000;
    writeFileSync(
      path,
      JSON.stringify({
        threads: {
          "C1:OLD": { sessionId: "old", projectDir: "/p", verbose: "on", createdAt: old, lastUsedAt: old },
        },
        projects: {},
      }),
    );
    const s = new StateStore(path);
    expect(s.getThread("C1:OLD")).not.toBeNull(); // loaded…
    s.setCurrentProject("/p"); // triggers save + prune
    expect(s.getThread("C1:OLD")).toBeNull(); // …but evicted on write
    s.setThread("C1:FRESH", { sessionId: "new", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    expect(s.getThread("C1:FRESH")).not.toBeNull(); // fresh survives
  });

  it("threads with a pendingRun tombstone are never evicted", () => {
    const dir = join(FIXTURES, "pruneTomb");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    writeFileSync(
      path,
      JSON.stringify({
        threads: {
          "C1:STUCK": {
            sessionId: "stuck",
            projectDir: "/p",
            verbose: "on",
            createdAt: old,
            lastUsedAt: old,
            pendingRun: { userMsgTs: ["1.2"], statusTs: "3.4" },
          },
        },
        projects: {},
      }),
    );
    const s = new StateStore(path);
    s.setCurrentProject("/p"); // save + prune
    const sw = s.threadsWithPendingRun();
    expect(sw.length).toBe(1);
    expect(sw[0]?.key).toBe("C1:STUCK");
    expect(sw[0]?.thread.pendingRun?.statusTs).toBe("3.4");
    s.clearPendingRun("C1:STUCK");
    expect(s.threadsWithPendingRun()).toEqual([]);
  });
});

describe("StateStore save durability (RB3)", () => {
  it("save leaves no .tmp behind and reloads fine", () => {
    const { store: s, path } = tempStore("atomic");
    s.setThread("C:1", { sessionId: "ses_a", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const s2 = new StateStore(path);
    expect(s2.getThread("C:1")?.sessionId).toBe("ses_a");
  });

  it("a corrupt state.json starts clean (contract)", () => {
    const { path } = tempStore("corrupt");
    mkdirSync(FIXTURES + "/corrupt", { recursive: true });
    writeFileSync(path, "{not json");
    const s = new StateStore(path);
    expect(s.getThread("C:1")).toBeNull();
    expect(s.listProjects()).toEqual([]);
  });
});

describe("canonical identity and durable recovery", () => {
  it("normalizes old state idempotently, merging newest aliases and preserving pending/watch metadata", () => {
    const root = join(FIXTURES, "canonical");
    const real = join(root, "project");
    const alias = join(root, "alias");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, alias);
    const path = join(root, "state.json");
    const now = Date.now();
    const thread = { sessionId: "watching", projectDir: alias, verbose: "full", watchOnly: true,
      notify: true, model: "p/m", agent: "build", hushed: true, lastSeenTs: "100.000002",
      createdAt: now, lastUsedAt: now, pendingRun: { userMsgTs: ["100.000002"], statusTs: "status", futureField: 7 } };
    writeFileSync(path, JSON.stringify({ currentProjectDir: alias + "/", threads: { "C:100": thread },
      projects: { [alias]: { lastUsedAt: 3 }, [real + "/./"]: { lastUsedAt: 8 } } }));
    const s = new StateStore(path);
    expect(s.listProjects()).toEqual([{ dir: canonicalDir(real), lastUsedAt: 8 }]);
    expect(s.currentProjectDir).toBe(canonicalDir(real));
    expect(s.getThread("C:100")).toMatchObject({ ...thread, projectDir: canonicalDir(real), recovery: { version: 1, ownerActivityTs: thread.lastSeenTs } });
    expect(s.getThread("C:100")?.historyCursorTs).toBeUndefined();
    expect(s.anyThreadInDir(alias)).toBe(true);
    s.save();
    const once = readFileSync(path, "utf8");
    new StateStore(path).save();
    expect(readFileSync(path, "utf8")).toBe(once);
  });

  it("lastSeen and stale renderer snapshots cannot advance/regress history; crash-held claims become uncertain", () => {
    const { store: s, path } = tempStore("receipt-lifecycle");
    s.setThread("C:100", { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW, lastSeenTs: ts(1) });
    const stale = s.getThread("C:100")!;
    expect(s.claimMessage("C:100", ts(3))).toBe("claimed");
    s.markThreadSeen("C:100", ts(3));
    expect(s.getThread("C:100")?.historyCursorTs).toBe(ts(1));
    expect(s.claimMessage("C:100", ts(3))).toBe("processing");
    expect(s.confirmHistory("C:100", ts(3))).toBe(false);
    const restarted = new StateStore(path, () => NOW);
    expect(restarted.claimMessage("C:100", ts(3))).toBe("uncertain");
    restarted.settleMessage("C:100", ts(3), "accepted");
    expect(restarted.confirmHistory("C:100", ts(3))).toBe(true);
    expect(restarted.getReceipt("C:100", ts(3))).toBeUndefined();
    restarted.setThread("C:100", { ...stale, pendingRun: { userMsgTs: [ts(3)] } });
    expect(restarted.getThread("C:100")?.historyCursorTs).toBe(ts(3));
    expect(restarted.getThread("C:100")?.lastSeenTs).toBe(ts(3));
    expect(restarted.claimMessage("C:100", ts(2))).toBe("accepted");
  });

  it("pauses on receipt overflow without evicting evidence, then resumes when history drains", () => {
    const { path } = tempStore("receipt-overflow");
    mkdirSync(join(FIXTURES, "receipt-overflow"), { recursive: true });
    const receipts = Object.fromEntries(Array.from({ length: MAX_MESSAGE_RECEIPTS }, (_, i) => {
      const timestamp = ts(i + 1);
      return [`C:${timestamp}`, { threadKey: "C:100", ts: timestamp, disposition: "accepted", updatedAt: NOW }];
    }));
    writeFileSync(path, JSON.stringify({ threads: { "C:100": { sessionId: "s", projectDir: "/p", verbose: "on",
      createdAt: NOW, lastUsedAt: NOW, historyCursorTs: ts(0) } }, projects: {}, receipts }));
    const s = new StateStore(path, () => NOW);
    expect(s.claimMessage("C:100", ts(3000))).toBe("paused");
    expect(s.recoveryStatus()).toMatchObject({ paused: true, receipts: MAX_MESSAGE_RECEIPTS, uncertain: 0 });
    expect(s.getReceipt("C:100", ts(1))?.disposition).toBe("accepted");
    expect(s.getThread("C:100")).not.toBeNull(); // old binding with evidence survives pruning
    expect(s.confirmHistory("C:100", ts(1))).toBe(true);
    expect(s.claimMessage("C:100", ts(3000))).toBe("claimed");
  });

  it("GC expires only accepted unbound receipts, durably suppressing old deliveries and later-binding replay", () => {
    const { path } = tempStore("receipt-gc");
    mkdirSync(join(FIXTURES, "receipt-gc"), { recursive: true });
    const now = Date.now();
    const old = now - UNBOUND_RECEIPT_HORIZON_MS - 60_000;
    const ts = `${Math.floor(old / 1000)}.000001`;
    const futureTs = `${Math.floor(now / 1000) + 60}.000001`;
    const receipt = (threadKey: string, disposition: string, updatedAt = old, timestamp = ts) => ({ threadKey, ts: timestamp, disposition, updatedAt });
    writeFileSync(path, JSON.stringify({ projects: {}, threads: {
      "bound:root": { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: now, lastUsedAt: now, historyCursorTs: "100.000000" },
    }, receipts: {
      [`expire:${ts}`]: receipt("expire:root", "accepted"),
      [`recent:${ts}`]: receipt("recent:root", "accepted", now),
      [`uncertain:${ts}`]: receipt("uncertain:root", "uncertain"),
      [`processing:${ts}`]: receipt("processing:root", "processing"),
      [`bound:${ts}`]: receipt("bound:root", "accepted"),
      [`future:${futureTs}`]: receipt("future:root", "accepted", old, futureTs),
    } }));
    const s = new StateStore(path);
    expect(s.pruneAcceptedUnboundReceipts(now)).toBe(1);
    expect(s.messageReceipts()).toHaveLength(5);
    expect(s.getReceipt("expire:root", ts)).toBeUndefined();
    expect(s.getReceipt("uncertain:root", ts)?.disposition).toBe("uncertain");
    expect(s.getReceipt("processing:root", ts)?.disposition).toBe("uncertain");
    const restarted = new StateStore(path);
    expect(restarted.claimMessage("expire:root", ts)).toBe("held");
    restarted.setThread("expire:root", { sessionId: "later", projectDir: "/p", verbose: "on", createdAt: now,
      lastUsedAt: now, historyCursorTs: "100.000000" });
    expect(restarted.getThread("expire:root")!.historyCursorTs).toBe("100.000000");
    expect(restarted.claimMessage("expire:root", ts)).toBe("held");
    // Existing bound history is not raised to a global age limit.
    expect(restarted.getThread("bound:root")?.historyCursorTs).toBe("100.000000");
  });

  it("reclaims old command-only traffic before checking the cap", () => {
    const { path } = tempStore("receipt-gc-cap");
    mkdirSync(join(FIXTURES, "receipt-gc-cap"), { recursive: true });
    const old = Date.now() - UNBOUND_RECEIPT_HORIZON_MS - 60_000;
    const ts = `${Math.floor(old / 1000)}.000001`;
    const receipts = Object.fromEntries(Array.from({ length: MAX_MESSAGE_RECEIPTS }, (_, i) =>
      [`C${i}:${ts}`, { threadKey: `C${i}:root`, ts, disposition: "accepted", updatedAt: old }]));
    writeFileSync(path, JSON.stringify({ threads: {}, projects: {}, receipts, recoveryPaused: true }));
    const s = new StateStore(path);
    const fresh = `${Math.floor(Date.now() / 1000)}.000001`;
    expect(s.claimMessage("new:root", fresh)).toBe("claimed");
    expect(s.recoveryStatus()).toMatchObject({ paused: false, receipts: 1, uncertain: 0 });
    expect(new StateStore(path).messageReceipts()).toHaveLength(1);
  });

  it("requires exact user message evidence and preserves the submission association across restart", () => {
    const { store: s, path } = tempStore("receipt-evidence");
    s.setThread("C:100", { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW, lastSeenTs: ts(1) });
    s.claimMessage("C:100", ts(2));
    s.associatePrompt("C:100", ts(2), { projectDir: "/p/./", sessionId: "s", messageId: "msg_exact" });
    const restarted = new StateStore(path, () => NOW);
    const info = { id: "msg_exact", sessionID: "s", role: "user" };
    expect(restarted.getReceipt("C:100", ts(2))?.disposition).toBe("uncertain");
    expect(restarted.reconcilePromptAcceptance("/other", info)).toEqual([]);
    expect(restarted.reconcilePromptAcceptance("/p", { ...info, role: "assistant" })).toEqual([]);
    expect(restarted.reconcilePromptAcceptance("/p", { ...info, id: "msg_later" })).toEqual([]);
    expect(restarted.reconcilePromptAcceptance("/p", { ...info, sessionID: "different" })).toEqual([]);
    expect(restarted.reconcilePromptAcceptance("/p/", info)).toHaveLength(1);
    restarted.settleMessage("C:100", ts(2), "uncertain"); // late HTTP timeout cannot undo evidence
    expect(new StateStore(path, () => NOW).getReceipt("C:100", ts(2))?.disposition).toBe("accepted");
    expect(restarted.getThread("C:100")?.historyCursorTs).toBe(ts(1));
    expect(restarted.reconcilePromptAcceptance("/p", info)).toEqual([]);
    expect(restarted.confirmHistory("C:100", ts(2))).toBe(true);
  });
});

describe("catch-up watermark (markThreadSeen / threadsForCatchup)", () => {
  it("advances the watermark monotonically and persists it", () => {
    const { store: s, path } = tempStore("wm");
    s.setThread("C:1", { sessionId: "ses_a", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    s.markThreadSeen("C:1", ts(10));
    expect(s.getThread("C:1")?.lastSeenTs).toBe(ts(10));
    s.markThreadSeen("C:1", ts(5)); // older — must not regress
    expect(s.getThread("C:1")?.lastSeenTs).toBe(ts(10));
    s.markThreadSeen("C:1", ts(20));
    expect(s.getThread("C:1")?.lastSeenTs).toBe(ts(20));
    expect(new StateStore(path, () => NOW).getThread("C:1")?.lastSeenTs).toBe(ts(20)); // persisted
  });

  it("is a no-op for unbound threads (a later binding seeds its own watermark)", () => {
    const { store: s } = tempStore("wm-unbound");
    s.markThreadSeen("C:9", "100.000010");
    expect(s.getThread("C:9")).toBeNull();
  });

  it("threadsForCatchup filters by window, newest first", () => {
    const { store: s } = tempStore("wm-sweep");
    const now = NOW;
    s.setThread("C:new", { sessionId: "a", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: now, lastSeenTs: timestampFromMs(now) });
    s.setThread("C:recent", { sessionId: "b", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: now - 3600_000, lastSeenTs: timestampFromMs(now - 3600_000) });
    const stale = storeStale("wm-sweep", "C:old", now - 13 * 60 * 60 * 1000);
    expect(stale).toBeDefined(); // sanity
    const s2 = new StateStore(join(FIXTURES, "wm-sweep", "state.json"), () => now);
    const keys = s2.threadsForCatchup(now - 12 * 60 * 60 * 1000).map((r) => r.key);
    expect(keys).toEqual(["C:new", "C:recent"]); // stale excluded, newest first
  });

  /** Exercise migration of a legacy binding without recovery metadata. */
  function storeStale(name: string, key: string, lastUsedAt: number): boolean {
    const dir = join(FIXTURES, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    const prev = JSON.parse(readFileSync(path, "utf8")) as { threads: Record<string, unknown>; projects: Record<string, unknown> };
    prev.threads[key] = { sessionId: "old", projectDir: "/p", verbose: "on", lastSeenTs: timestampFromMs(lastUsedAt), createdAt: lastUsedAt, lastUsedAt };
    writeFileSync(path, JSON.stringify(prev));
    return true;
  }
});

describe("versioned recovery migration (legacy-thread migration)", () => {
  function rawStore(name: string, threads: Record<string, unknown>): StateStore {
    const dir = join(FIXTURES, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ threads, projects: {} }));
    return new StateStore(path, () => NOW);
  }

  it("uses owner observation, never a recent maintenance timestamp, and never forges a cursor", () => {
    const s = rawStore("seed-basic", {
      "C1:100.1": { sessionId: "s1", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW },
      "C2:200.2": { sessionId: "s2", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW, lastSeenTs: "1788220800.000002" },
    });
    s.seedMissingWatermarks();
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBeUndefined();
    expect(s.getThread("C1:100.1")?.recovery?.ownerActivityTs).toBeUndefined();
    expect(s.getThread("C2:200.2")?.recovery).toMatchObject({ version: 1, ownerActivityTs: "1788220800.000002", replayFloorTs: replayFloor(NOW) });
    expect(s.getThread("C2:200.2")?.historyCursorTs).toBeUndefined();
    const once = readFileSync(join(FIXTURES, "seed-basic", "state.json"), "utf8");
    s.seedMissingWatermarks();
    expect(readFileSync(join(FIXTURES, "seed-basic", "state.json"), "utf8")).toBe(once);
  });

  it("keeps confirmed cursors and compares owner observation at microsecond precision", () => {
    const s = rawStore("seed-order", {
      "C1:100.1": { sessionId: "s1", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW,
        lastSeenTs: "1790035000.098000", historyCursorTs: "1790034999.000000" },
    });
    s.seedMissingWatermarks();
    s.markThreadSeen("C1:100.1", "1790035000.09");
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBe("1790035000.098000");
    s.markThreadSeen("C1:100.1", "1790035001.000000");
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBe("1790035001.000000");
    expect(s.getThread("C1:100.1")?.historyCursorTs).toBe("1790034999.000000");
  });

  it("keeps ambiguous pending evidence without manufacturing owner activity from createdAt", () => {
    const s = rawStore("seed-fallback", {
      // missing lastUsedAt → prune-eligible; the pendingRun tombstone keeps it
      // through the seed save (a tombstoned thread must still get a sane
      // boundary, never epoch-zero → full-history replay)
      "C1:100.1": {
        sessionId: "s1",
        projectDir: "/p",
        verbose: "on",
        createdAt: 1788763811111,
        pendingRun: { userMsgTs: [] },
      },
    });
    s.seedMissingWatermarks();
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBeUndefined();
    expect(s.getThread("C1:100.1")?.pendingRun).toBeDefined();
  });

  it("maintenance does not refresh activity and cancellation/terminal evidence survives restart", () => {
    const { store: s, path } = tempStore("lifecycle");
    s.setThread("C:T", { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: NOW,
      lastUsedAt: NOW, lastSeenTs: ts(1), historyCursorTs: ts(0) });
    s.markThreadSeen("C:T", ts(2));
    const before = s.getThread("C:T")!;
    s.setThread("C:T", { ...before, pendingRun: { userMsgTs: [ts(2)], statusTs: "status" } });
    s.recordRunOutcome("C:T", "s", "active");
    s.cancelRecovery("C:T", ts(3));
    s.recordRunOutcome("C:T", "s", "completed"); // stale idle after stop cannot undo stop
    s.setThread("C:T", { ...s.getThread("C:T")!, pendingRun: undefined });
    const restarted = new StateStore(path, () => NOW + 86400_000);
    expect(restarted.getThread("C:T")?.lastUsedAt).toBe(before.lastUsedAt);
    expect(restarted.getThread("C:T")?.recovery?.lastRun?.outcome).toBe("stopped");
    expect(restarted.getThread("C:T")?.recovery?.canceledThroughTs).toBe(ts(3));
    expect(restarted.getThread("C:T")?.pendingRun).toBeUndefined();
    const generation = restarted.bindingGeneration("C:T");
    restarted.setThread("C:T", { ...restarted.getThread("C:T")!, sessionId: "replacement" });
    expect(restarted.bindingGeneration("C:T")).toBe(generation + 1);
  });

  it("retirement advances the replay floor without changing uncertain acceptance evidence", () => {
    const { store: s, path } = tempStore("retirement");
    s.setThread("C:T", { sessionId: "s", projectDir: "/p", verbose: "on", createdAt: NOW, lastUsedAt: NOW, historyCursorTs: ts(0) });
    s.claimMessage("C:T", ts(1));
    s.settleMessage("C:T", ts(1), "uncertain");
    s.recordRecoveryDecision("C:T", ts(1), { decision: "held", reason: "submission_uncertain" });
    s.retireHistory("C:T", ts(3));
    const restarted = new StateStore(path, () => NOW);
    expect(restarted.getReceipt("C:T", ts(1))?.disposition).toBe("uncertain");
    expect(restarted.isMessageAccepted("C:T", ts(1))).toBe(false);
    expect(restarted.isMessageAccepted("C:T", ts(2))).toBe(false);
    expect(restarted.claimMessage("C:T", ts(2))).toBe("held");
    expect(restarted.getThread("C:T")?.historyCursorTs).toBe(ts(0));
  });
});

describe("corrupt state.json", () => {
  it("is moved aside (never silently overwritten) and the store starts clean", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = join(FIXTURES, "corrupt");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    writeFileSync(path, '{"threads": {"C1:1.0": {"sessionId": "ses_x"');
    const store = new StateStore(path);
    store.setCurrentProject("/tmp");
    const backups = readdirSync(dir).filter(f => f.startsWith("state.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), "utf8")).toContain("ses_x");
    expect(JSON.parse(readFileSync(path, "utf8")).threads).toEqual({});
  });
});
