import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startManagedRuntime, superviseBridge, type ServiceContext } from "../src/service.js";
import { enableFileLog, fileLogPath, pushLog } from "../src/log.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>() }));

const root = resolve("test/.fixtures/service-runtime");
const oldCode = process.exitCode;
const oldUmask = process.umask();
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
  process.exitCode = oldCode; process.umask(oldUmask);
  rmSync(root, { recursive: true, force: true });
});

describe("managed runtime", () => {
  it("keeps foreground runtimes inert", () => {
    vi.stubEnv("SLACKOC_SERVICE", "");
    vi.stubEnv("SLACKOC_SERVICE_KEEP_AWAKE", "true");
    const runtime = startManagedRuntime();
    expect(() => { runtime.close(); runtime.close(); }).not.toThrow();
  });
  it("routes ring-only logs into the supervisor pipe without opening a competing disk writer", () => {
    vi.stubEnv("SLACKOC_SERVICE", "bridge");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const path = join(root, "must-not-open.log");
    enableFileLog(path);
    pushLog("ring-only diagnostic");
    expect(write).toHaveBeenCalledWith(expect.stringContaining("ring-only diagnostic"));
    expect(fileLogPath()).toMatch(/logs\/bridge\.log$/);
    expect(existsSync(path)).toBe(false);
  });
  it("captures actual child stdout/stderr and turns a bridge crash into a restartable supervisor exit", async () => {
    mkdirSync(root, { recursive: true });
    const cli = join(root, "harmless child.js");
    writeFileSync(cli, `console.log('stdout-before-crash'); console.error('stderr-before-crash'); process.exitCode = 7;`);
    const ctx: ServiceContext = {
      platform: "darwin", home: root, configDir: join(root, "config"), cwd: root,
      node: process.execPath, cli, uid: 555, env: { PATH: "/usr/bin:/bin" },
      alive: () => false, run: () => { throw new Error("no launchctl in supervisor test"); },
    };
    await superviseBridge(ctx);
    expect(process.exitCode).toBe(7);
    const text = readFileSync(join(ctx.configDir, "logs", "bridge.log"), "utf8");
    expect(text).toContain("stdout-before-crash");
    expect(text).toContain("stderr-before-crash");
    expect(text).toContain("code=7");
    expect(existsSync(join(ctx.configDir, "logs", "service-runtime.json"))).toBe(false);
  });
  it.each(["metadata", "log pipe"])("reaps and escalates the child after a %s write failure", async failure => {
    vi.useFakeTimers();
    const configDir = join(root, "config");
    // A directory here produces a deterministic metadata-write EISDIR error.
    if (failure === "metadata") mkdirSync(join(configDir, "logs", "service-runtime.json"), { recursive: true });
    const fake = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      kill: vi.fn((signal: string) => {
        if (signal === "SIGKILL") { fake.emit("exit", null, signal); fake.emit("close", null, signal); }
        return true;
      }),
    });
    vi.spyOn(childProcess, "spawn").mockReturnValue(fake as unknown as childProcess.ChildProcess);
    const ctx: ServiceContext = {
      platform: "darwin", home: root, configDir, cwd: root, node: process.execPath,
      cli: join(root, "unused.js"), uid: 555, env: {}, alive: () => false, run: () => "",
    };
    const before = process.listenerCount("SIGTERM");
    let finished = false;
    const pending = superviseBridge(ctx).then(() => { finished = true; });
    await Promise.resolve();
    if (failure === "log pipe") {
      const log = join(configDir, "logs", "bridge.log");
      rmSync(log);
      mkdirSync(log);
      expect(() => fake.stdout.emit("data", Buffer.from("will fail to write"))).not.toThrow();
    }
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(fake.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(process.exitCode).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});
