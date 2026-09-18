import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LogLevel } from "@slack/bolt";
import {
  clearLogs,
  enableFileLog,
  fileLogPath,
  logCount,
  logErr,
  newLogsSince,
  pushLog,
  recentLogs,
  ringLogger,
} from "../src/log.js";

// Per-suite fixture dir (the shared .fixtures root races between suites).
const FIXTURES = join(import.meta.dirname ?? __dirname, ".fixtures", "log");
const LOG_FILE = join(FIXTURES, "bridge.log");

describe("bridge log ring buffer (\\logs)", () => {
  it("keeps the most recent lines and caps at 200", () => {
    clearLogs();
    pushLog("hello");
    pushLog("world");
    expect(recentLogs().length).toBe(2);
    expect(recentLogs().some((l) => l.includes("hello"))).toBe(true);
    for (let i = 0; i < 300; i++) pushLog(`line ${i}`);
    const all = recentLogs(500);
    expect(all.length).toBe(200); // capped
    expect(all.at(-1)).toContain("line 299"); // newest kept
    expect(all.some((l) => l.includes("hello"))).toBe(false); // oldest dropped
  });

  it("recentLogs(n) returns only the last n", () => {
    clearLogs();
    for (let i = 0; i < 10; i++) pushLog(`m${i}`);
    const last3 = recentLogs(3);
    expect(last3.length).toBe(3);
    expect(last3[0]).toContain("m7");
    clearLogs();
  });

  it("logErr feeds both stderr and the ring buffer", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      clearLogs();
      logErr("boom happened");
      expect(spy).toHaveBeenCalledWith("boom happened");
      expect(recentLogs(1)[0]).toContain("boom happened");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ringLogger (bolt/socket diagnostics → \\logs)", () => {
  it("info reaches the ring, debug is filtered at the default level", () => {
    clearLogs();
    const log = ringLogger();
    log.debug("chatty internals");
    log.info("socket connected");
    const lines = recentLogs(10);
    expect(lines.some((l) => l.includes("socket connected"))).toBe(true);
    expect(lines.some((l) => l.includes("chatty internals"))).toBe(false);
  });

  it("warn/error also hit stderr; setLevel re-enables debug", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      clearLogs();
      const log = ringLogger();
      log.warn("ping timeout");
      expect(spy).toHaveBeenCalled();
      expect(recentLogs(5).some((l) => l.includes("ping timeout"))).toBe(true);
      log.setLevel(LogLevel.DEBUG);
      log.debug("now visible");
      expect(recentLogs(5).some((l) => l.includes("now visible"))).toBe(true);
      expect(log.getLevel()).toBe(LogLevel.DEBUG);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("persistent file log (D8)", () => {
  it("is off by default and appends full-ISO-stamped lines when enabled", () => {
    rmSync(FIXTURES, { recursive: true, force: true });
    clearLogs();
    expect(fileLogPath()).toBeNull();
    pushLog("no file yet");
    expect(existsSync(LOG_FILE)).toBe(false);

    mkdirSync(FIXTURES, { recursive: true });
    enableFileLog(LOG_FILE);
    expect(fileLogPath()).toBe(LOG_FILE);
    pushLog("hello file");
    const content = readFileSync(LOG_FILE, "utf8");
    // Full ISO date in the file (post-mortems span days), compact HH:MM:SS in the ring.
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z hello file\n$/);
    expect(recentLogs(1)[0]).toMatch(/^\d{2}:\d{2}:\d{2} hello file$/);
  });

  it("rotates .log → .1 → .2 once the size cap is crossed", () => {
    rmSync(FIXTURES, { recursive: true, force: true });
    clearLogs();
    mkdirSync(FIXTURES, { recursive: true });
    enableFileLog(LOG_FILE);
    pushLog("seed");
    // Pad past the 5MB cap in one write instead of 5MB of log lines.
    writeFileSync(LOG_FILE, "x".repeat(5 * 1024 * 1024 + 1));
    pushLog("after rotation");
    expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
    const fresh = readFileSync(LOG_FILE, "utf8");
    expect(fresh).toContain("after rotation");
    expect(fresh.length).toBeLessThan(1024);
    expect(readFileSync(`${LOG_FILE}.1`, "utf8")).toBe("x".repeat(5 * 1024 * 1024 + 1));
  });

  it("survives a missing directory (best-effort, never throws)", () => {
    rmSync(FIXTURES, { recursive: true, force: true });
    enableFileLog(join(FIXTURES, "bridge.log"));
    expect(() => pushLog("still fine")).not.toThrow();
    expect(recentLogs(1)[0]).toContain("still fine");
  });
});

describe("follow cursor (\\logs --follow)", () => {
  it("newLogsSince returns only lines pushed after the cursor", () => {
    clearLogs();
    for (let i = 0; i < 5; i++) pushLog(`a${i}`);
    const cursor = logCount();
    expect(newLogsSince(cursor)).toEqual([]);
    pushLog("b0");
    pushLog("b1");
    const fresh = newLogsSince(cursor);
    expect(fresh).toHaveLength(2);
    expect(fresh[0]).toContain("b0");
    expect(fresh[1]).toContain("b1");
    // A stale cursor before the ring window still returns what the ring holds.
    expect(newLogsSince(0).length).toBe(7);
  });

  it("clearLogs resets the cursor", () => {
    clearLogs();
    pushLog("x");
    expect(logCount()).toBe(1);
    clearLogs();
    expect(logCount()).toBe(0);
    expect(newLogsSince(0)).toEqual([]);
  });
});
