import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { claimPidfile } from "../src/start.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

// Test fixtures stay inside the project (never the system tmpdir).
const FIXTURES = join(import.meta.dirname ?? __dirname, ".fixtures");

function pidPath(name: string): string {
  return join(FIXTURES, "pid", name, "slackoc.pid");
}

function seed(path: string, pid: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
}

afterAll(() => {
  // Only this suite's own subdir — other suites share the .fixtures root and
  // may still have it open (parallel workers → ENOTEMPTY flakes).
  rmSync(join(FIXTURES, "pid"), { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

const deadPid = 2 ** 22 + 12345;
const markerFor = (pid: number) => `${pid}-00000000-0000-4000-8000-000000000000`;
function seedLock(p: string, pid: number): string {
  mkdirSync(`${p}.lock`, { recursive: true });
  const marker = markerFor(pid);
  writeFileSync(join(`${p}.lock`, marker), "");
  return marker;
}

describe("claimPidfile", () => {
  it("claims an absent pidfile, writing our pid", () => {
    const p = pidPath("absent");
    expect(claimPidfile(p)).toBe("claimed");
    expect(existsSync(p)).toBe(true);
    expect(Number(readFileSync(p, "utf8"))).toBe(process.pid);
  });

  it("refuses when a live process holds it", () => {
    const p = pidPath("live");
    seed(p, process.pid); // our own pid is alive — another start sees "running"
    expect(claimPidfile(p)).toBe("running");
    expect(Number(readFileSync(p, "utf8"))).toBe(process.pid);
  });

  it("replaces a stale pidfile from a dead process", () => {
    const p = pidPath("stale");
    seed(p, 2 ** 22 + 12345); // almost surely not a live pid
    expect(claimPidfile(p)).toBe("claimed");
    expect(Number(readFileSync(p, "utf8"))).toBe(process.pid);
  });

  it("preserves recent empty/partial claims and recovers abandoned partial files after a grace period", () => {
    for (const value of ["", "123unfinished", "-2", "0"]) {
      const p = pidPath(`partial-${value || "empty"}`);
      seed(p, 0); writeFileSync(p, value);
      expect(claimPidfile(p)).toBe("starting");
      expect(readFileSync(p, "utf8")).toBe(value);
      const old = new Date(Date.now() - 60_000);
      utimesSync(p, old, old);
      expect(claimPidfile(p)).toBe("claimed");
      expect(readFileSync(p, "utf8")).toBe(String(process.pid));
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it("respects a live claim lock, including before its pidfile is published", () => {
    const p = pidPath("live-lock");
    const marker = seedLock(p, process.pid);
    expect(claimPidfile(p)).toBe("starting");
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(`${p}.lock`)).toEqual([marker]);
    writeFileSync(p, "");
    const old = new Date(Date.now() - 60_000); utimesSync(p, old, old);
    expect(claimPidfile(p)).toBe("starting");
    expect(readFileSync(p, "utf8")).toBe(""); // live lock beats partial-file age
  });

  it("recovers a dead owner's lock and an empty lock left during release", () => {
    for (const kind of ["dead-lock", "empty-lock"]) {
      const p = pidPath(kind);
      if (kind === "dead-lock") seedLock(p, deadPid);
      else mkdirSync(`${p}.lock`, { recursive: true });
      seed(p, deadPid);
      expect(claimPidfile(p)).toBe("claimed");
      expect(readFileSync(p, "utf8")).toBe(String(process.pid));
      expect(readdirSync(dirname(p))).toEqual(["slackoc.pid"]);
    }
  });

  it("a late stale-lock reaper cannot unlink a newly acquired live owner's lock", () => {
    const p = pidPath("stale-lock-race");
    const stale = seedLock(p, deadPid);
    const unlink = fs.unlinkSync;
    let raced = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation(path => {
      if (String(path) === join(`${p}.lock`, stale) && !raced) {
        raced = true;
        unlink(path);
        fs.rmdirSync(`${p}.lock`);
        seedLock(p, process.pid);
      }
      return unlink(path);
    });
    expect(claimPidfile(p)).toBe("starting");
    expect(raced).toBe(true);
    expect(readdirSync(`${p}.lock`)).toEqual([markerFor(process.pid)]);
    expect(existsSync(p)).toBe(false);
  });

  it("does not treat EPERM as proof of a stale process", () => {
    const p = pidPath("permission");
    seed(p, 12345);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); });
    expect(claimPidfile(p)).toBe("running");
    expect(readFileSync(p, "utf8")).toBe("12345");
  });

  it.each(["absent", "stale", "old-empty"])("allows exactly one of eight simultaneous real starters to claim a %s pidfile", async initial => {
    const p = pidPath(`concurrent-${initial}`);
    mkdirSync(dirname(p), { recursive: true });
    if (initial !== "absent") {
      seed(p, deadPid);
      if (initial === "old-empty") {
        writeFileSync(p, "");
        const old = new Date(Date.now() - 60_000); utimesSync(p, old, old);
      }
    }
    const worker = join(dirname(p), "claim-worker.mjs");
    writeFileSync(worker, `
      import { claimPidfile } from ${JSON.stringify(pathToFileURL(resolve("src/start.ts")).href)};
      process.on('message', message => {
        if (message === 'claim') process.send({ result: claimPidfile(process.argv[2]), pid: process.pid });
        if (message === 'exit') process.exit(0);
      });
      process.send('ready');
    `);
    const children: ChildProcess[] = [];
    try {
      const results: Promise<{ result: string; pid: number }>[] = [];
      const ready: Promise<void>[] = [];
      for (let i = 0; i < 8; i++) {
        const child = fork(worker, [p], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
        children.push(child);
        ready.push(new Promise((resolveReady, reject) => {
          child.on("message", msg => { if (msg === "ready") resolveReady(); });
          child.on("error", reject);
          child.on("exit", code => reject(new Error(`worker exited before ready: ${code}`)));
        }));
        results.push(new Promise((resolveResult, reject) => {
          child.on("message", msg => { if (typeof msg === "object" && msg !== null && "result" in msg) resolveResult(msg as { result: string; pid: number }); });
          child.on("error", reject);
        }));
      }
      await Promise.all(ready);
      children.forEach(child => child.send("claim"));
      const claims = await Promise.all(results);
      const winners = claims.filter(c => c.result === "claimed");
      expect(winners).toHaveLength(1);
      expect(Number(readFileSync(p, "utf8"))).toBe(winners[0]!.pid);
      expect(claimPidfile(p)).toBe("running"); // winner remains alive until teardown
    } finally {
      await Promise.all(children.map(child => new Promise<void>(done => {
        if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
        child.once("exit", () => done());
        child.kill("SIGTERM"); // fixture workers only
      })));
    }
  }, 20_000);
});
