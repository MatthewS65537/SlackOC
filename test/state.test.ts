import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

// Test fixtures stay inside the project (never the system tmpdir). This suite
// owns its own subdir: suites run in parallel workers, so removing the shared
// .fixtures root while another suite writes flakes with ENOTEMPTY.
const FIXTURES = join(import.meta.dirname ?? __dirname, ".fixtures", "state");

function tempStore(name: string): { store: StateStore; path: string } {
  const path = join(FIXTURES, name, "state.json");
  return { store: new StateStore(path), path };
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

describe("catch-up watermark (markThreadSeen / threadsForCatchup)", () => {
  it("advances the watermark monotonically and persists it", () => {
    const { store: s, path } = tempStore("wm");
    s.setThread("C:1", { sessionId: "ses_a", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });
    s.markThreadSeen("C:1", "100.000010");
    expect(s.getThread("C:1")?.lastSeenTs).toBe("100.000010");
    s.markThreadSeen("C:1", "100.000005"); // older — must not regress
    expect(s.getThread("C:1")?.lastSeenTs).toBe("100.000010");
    s.markThreadSeen("C:1", "100.000020");
    expect(s.getThread("C:1")?.lastSeenTs).toBe("100.000020");
    expect(new StateStore(path).getThread("C:1")?.lastSeenTs).toBe("100.000020"); // persisted
  });

  it("is a no-op for unbound threads (a later binding seeds its own watermark)", () => {
    const { store: s } = tempStore("wm-unbound");
    s.markThreadSeen("C:9", "100.000010");
    expect(s.getThread("C:9")).toBeNull();
  });

  it("threadsForCatchup filters by window, newest first", () => {
    const { store: s } = tempStore("wm-sweep");
    const now = Date.now();
    s.setThread("C:new", { sessionId: "a", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: now });
    const stale = storeStale("wm-sweep", "C:old", now - 13 * 60 * 60 * 1000);
    expect(stale).toBeDefined(); // sanity
    const s2 = new StateStore(join(FIXTURES, "wm-sweep", "state.json"));
    const keys = s2.threadsForCatchup(now - 12 * 60 * 60 * 1000).map((r) => r.key);
    expect(keys).toEqual(["C:new"]); // stale excluded
  });

  /** setThread bumps lastUsedAt to now — hand-write a stale binding. */
  function storeStale(name: string, key: string, lastUsedAt: number): boolean {
    const dir = join(FIXTURES, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    const prev = JSON.parse(readFileSync(path, "utf8")) as { threads: Record<string, unknown>; projects: Record<string, unknown> };
    prev.threads[key] = { sessionId: "old", projectDir: "/p", verbose: "on", lastSeenTs: "1.1", createdAt: lastUsedAt, lastUsedAt };
    writeFileSync(path, JSON.stringify(prev));
    return true;
  }
});

describe("seedMissingWatermarks (legacy-thread migration)", () => {
  /** Hand-written state: exact lastUsedAt control (setThread would bump to now). */
  function rawStore(name: string, threads: Record<string, unknown>): StateStore {
    const dir = join(FIXTURES, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ threads, projects: {} }));
    return new StateStore(path);
  }

  it("seeds only missing watermarks from lastUsedAt, in fixed 6-digit ts form", () => {
    const s = rawStore("seed-basic", {
      "C1:100.1": { sessionId: "s1", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1788763822098 },
      // fresh lastUsedAt — the 60d-idle prune would evict a stale binding on save
      "C2:200.2": { sessionId: "s2", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: Date.now(), lastSeenTs: "200.000002" },
    });
    expect(s.seedMissingWatermarks()).toBe(1);
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBe("1788763822.098000");
    expect(s.getThread("C2:200.2")?.lastSeenTs).toBe("200.000002"); // already watermarked — untouched
    expect(s.seedMissingWatermarks()).toBe(0); // idempotent
  });

  it("seeded ts keeps the lexical-order invariant (a 3-digit fraction would corrupt it)", () => {
    const s = rawStore("seed-order", {
      "C1:100.1": { sessionId: "s1", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1788763822098 },
    });
    s.seedMissingWatermarks();
    s.markThreadSeen("C1:100.1", "1788763822.09"); // numerically bigger, lexically smaller — must not regress
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBe("1788763822.098000");
    s.markThreadSeen("C1:100.1", "1788763823.000000");
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBe("1788763823.000000");
  });

  it("falls back to createdAt when lastUsedAt is missing (kept alive by a pending tombstone)", () => {
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
    expect(s.seedMissingWatermarks()).toBe(1);
    expect(s.getThread("C1:100.1")?.lastSeenTs).toBe("1788763811.111000");
  });
});
