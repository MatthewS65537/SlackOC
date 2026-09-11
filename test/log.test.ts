import { describe, expect, it, vi } from "vitest";
import { LogLevel } from "@slack/bolt";
import { clearLogs, logErr, pushLog, recentLogs, ringLogger } from "../src/log.js";

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
