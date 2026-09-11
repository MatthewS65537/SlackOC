import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claimPidfile } from "../src/start.js";

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
});
