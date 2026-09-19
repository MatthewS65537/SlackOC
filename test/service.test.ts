import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  boundedShutdown, installService, parseServiceArgs, renderServicePlist, serviceEnvironment,
  serviceStatus, startService, stopManagedService, stopService, uninstallService,
  SERVICE_LABEL, type ServiceContext, type ServiceDefinition,
} from "../src/service.js";
import { rotatingLog } from "../src/service-log.js";

const root = resolve("test/.fixtures/service");
let ctx: ServiceContext;
let def: ServiceDefinition;
let loaded: boolean;
let jobPid: number | null;
let commands: string[][];
let output: ReturnType<typeof vi.spyOn>;
const plist = () => join(ctx.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const pidfile = () => join(ctx.configDir, "slackoc.pid");

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home & <quoted> ' \"");
  const cwd = join(root, "project with spaces");
  const configDir = join(home, ".config", "slackoc");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const cli = join(root, "cli with spaces.js");
  writeFileSync(cli, "// harmless fixture");
  writeFileSync(join(configDir, "config.json"), '{"slackBotToken":"secret-fixture"}');
  loaded = false;
  jobPid = null;
  commands = [];
  ctx = {
    platform: "darwin", home, cwd, configDir, cli, node: process.execPath, uid: 555,
    env: { HOME: home, PATH: "/usr/bin:/bin", AWS_SECRET_ACCESS_KEY: "do-not-copy", NODE_OPTIONS: "do-not-copy" },
    alive: pid => [4321, 5432, 6543].includes(pid),
    run: (cmd, args) => {
      if (cmd === "/usr/bin/plutil") {
        if (process.platform === "darwin") return execFileSync(cmd, args, { encoding: "utf8" });
        return JSON.stringify({ Label: SERVICE_LABEL, WorkingDirectory: def.cwd, ProgramArguments: [def.node, def.cli, "service", "run"], EnvironmentVariables: { ...def.env, SLACKOC_SERVICE: "supervisor", SLACKOC_SERVICE_KEEP_AWAKE: String(def.keepAwake) } });
      }
      commands.push(args);
      switch (args[0]) {
        case "print": return "GUI domain exists";
        case "list": return `PID\tStatus\tLabel\n${loaded ? `${jobPid ?? "-"}\t0\t${SERVICE_LABEL}\n` : ""}`;
        case "bootstrap": loaded = true; jobPid = 4321; return "";
        case "bootout": loaded = false; jobPid = null; return "";
        default: return "";
      }
    },
  };
  def = { node: ctx.node, cli, cwd, configDir, keepAwake: false, env: serviceEnvironment(ctx.env, cwd, ctx.node, home) };
  output = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe("service CLI arguments", () => {
  it("uses explicit booleans with both parseFlags spellings and leaves cwd as the install default", () => {
    expect(parseServiceArgs(["install"])).toEqual({ command: "install", dir: undefined, keepAwake: undefined });
    expect(parseServiceArgs(["install", "--dir", "/with spaces", "--keep-awake=true"])).toEqual({ command: "install", dir: "/with spaces", keepAwake: true });
    expect(parseServiceArgs(["install", "--keep-awake", "false"]).keepAwake).toBe(false);
  });
  it.each([
    [], ["run"], ["install", "--dir", "relative"], ["install", "--dir"],
    ["install", "--keep-awake"], ["install", "--keep-awake", "yes"], ["install", "--keep-awake", "TRUE"],
    ["start", "--dir", "/somewhere"], ["stop", "--keep-awake", "false"], ["status", "junk"],
    ["install", "--dir=/valid", "junk"], ["install", "--unknown=true"],
  ])("rejects malformed arguments %j", (...args) => {
    expect(() => parseServiceArgs(args as string[])).toThrow();
  });
});

describe("service definition and environment", () => {
  it("escapes plist strings and saves absolute executable/cwd paths without secrets", () => {
    installService({}, ctx);
    const text = readFileSync(plist(), "utf8");
    expect(text).toContain("&amp; &lt;quoted&gt; &apos; &quot;");
    expect(text).not.toContain("secret-fixture");
    expect(text).not.toContain("do-not-copy");
    expect(text).toContain("<key>Disabled</key><true/>");
    expect(text).toContain("<key>KeepAlive</key><true/>");
    expect(text).toContain("<key>AbandonProcessGroup</key><false/>");
    expect(statSync(plist()).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.configDir, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(ctx.configDir, "logs", "bridge.log")).mode & 0o777).toBe(0o600);
    expect(commands.every(c => ["print", "list"].includes(c[0]!))).toBe(true);
    serviceStatus(ctx);
    expect(output.mock.calls.flat().join("\n")).toContain(`default cwd: ${ctx.cwd}`);
  });
  it("whitelists environment, normalizes PATH, and preserves SLACKOC_HOME", () => {
    const env = serviceEnvironment({ PATH: ":relative/bin:/absolute bin:", SLACKOC_HOME: "alternate home", LANG: "en_US.UTF-8", OPENAI_API_KEY: "secret", SLACKOC_SERVICE: "fake" }, root, "/node dir/node", "/home");
    expect(env.SLACKOC_HOME).toBe(join(root, "alternate home"));
    expect(env.PATH).toContain(join(root, "relative/bin"));
    expect(env.PATH!.split(":").every(p => p.startsWith("/"))).toBe(true);
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("SLACKOC_SERVICE");
  });
  it("rejects control characters, relative or missing cwd, dev entrypoints and non-macOS", () => {
    expect(() => renderServicePlist({ ...def, cwd: "/bad\u0000path" })).toThrow(/control character/);
    expect(() => installService({ dir: "relative" }, ctx)).toThrow(/absolute/);
    expect(() => installService({ dir: join(root, "missing") }, ctx)).toThrow();
    expect(() => installService({}, { ...ctx, platform: "linux" })).toThrow(/macOS/);
    expect(() => startService({ ...ctx, platform: "linux" })).toThrow(/macOS/);
    expect(() => stopService({ ...ctx, platform: "linux" })).toThrow(/macOS/);
    expect(() => serviceStatus({ ...ctx, platform: "linux" })).toThrow(/macOS/);
    expect(() => uninstallService({ ...ctx, platform: "linux" })).toThrow(/macOS/);
    const cli = join(root, "cli.ts"); writeFileSync(cli, "");
    expect(() => installService({}, { ...ctx, cli })).toThrow(/built slackoc/);
  });
  it("refuses to overwrite a loaded job; repeat stopped install updates only files", () => {
    installService({}, ctx);
    loaded = true;
    expect(() => installService({ keepAwake: true }, ctx)).toThrow(/stop/);
    loaded = false;
    installService({ keepAwake: true }, ctx);
    expect(readFileSync(plist(), "utf8")).toContain("<key>SLACKOC_SERVICE_KEEP_AWAKE</key><string>true</string>");
  });
});

describe("service lifecycle", () => {
  it("checks the live pidfile BEFORE enabling/loading, including incomplete concurrent claims", () => {
    installService({}, ctx);
    for (const value of ["5432", "", "1", "nonsense"]) {
      commands = [];
      writeFileSync(pidfile(), value);
      expect(() => startService(ctx)).toThrow();
      expect(commands.some(c => ["enable", "bootstrap"].includes(c[0]!))).toBe(false);
    }
    writeFileSync(pidfile(), "999999"); // stale: safe for startBridge's claim path
    startService(ctx);
    expect(commands.slice(-2)).toEqual([["enable", "gui/555/com.slackoc.bridge"], ["bootstrap", "gui/555", plist()]]);
    commands = [];
    startService(ctx);
    expect(commands.every(c => ["print", "list"].includes(c[0]!))).toBe(true);
  });
  it("disables before bootout so intentional stop stays stopped; repeated stop/uninstall retain config/logs", () => {
    installService({}, ctx);
    startService(ctx);
    commands = [];
    stopService(ctx);
    expect(commands.slice(-2)).toEqual([["disable", "gui/555/com.slackoc.bridge"], ["bootout", "gui/555/com.slackoc.bridge"]]);
    commands = [];
    stopService(ctx);
    expect(commands.slice(-2)).toEqual([["disable", "gui/555/com.slackoc.bridge"], ["bootout", "gui/555/com.slackoc.bridge"]]);
    uninstallService(ctx);
    uninstallService(ctx);
    expect(existsSync(plist())).toBe(false);
    expect(existsSync(join(ctx.configDir, "config.json"))).toBe(true);
    expect(existsSync(join(ctx.configDir, "logs", "bridge.log"))).toBe(true);
  });
  it("allows an abandoned partial pidfile through preflight for locked bridge-side recovery", () => {
    installService({}, ctx);
    writeFileSync(pidfile(), "");
    expect(() => startService(ctx)).toThrow(/incomplete pidfile/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(pidfile(), old, old);
    startService(ctx);
    expect(loaded).toBe(true);
    expect(readFileSync(pidfile(), "utf8")).toBe(""); // preflight does not delete it
  });
  it("unloads a job that starts just before disable, instead of trusting an earlier unloaded snapshot", () => {
    installService({}, ctx);
    const original = ctx.run;
    ctx.run = (cmd, args, input) => {
      if (args[0] === "disable") loaded = true;
      return original(cmd, args, input);
    };
    stopService(ctx);
    expect(loaded).toBe(false);
    expect(commands.at(-1)).toEqual(["bootout", "gui/555/com.slackoc.bridge"]);
  });
  it("ordinary stop recognizes a managed bridge but never claims a manual pid as its own", async () => {
    installService({}, ctx);
    startService(ctx);
    writeFileSync(pidfile(), "5432");
    expect(await stopManagedService(ctx)).toBe(false);
    writeFileSync(join(ctx.configDir, "logs", "service-runtime.json"), JSON.stringify({ supervisorPid: 4321, bridgePid: 5432 }));
    expect(await stopManagedService(ctx)).toBe(true);
    expect(loaded).toBe(false);
  });
  it("ordinary stop disables a crash-restarting job even without a live pidfile", async () => {
    installService({}, ctx);
    loaded = true; jobPid = null;
    writeFileSync(pidfile(), "999999");
    expect(await stopManagedService(ctx)).toBe(true);
    expect(commands.some(c => c[0] === "disable")).toBe(true);
  });
  it("reports installed, loaded and verified owned bridge PID separately", () => {
    installService({}, ctx);
    serviceStatus(ctx);
    expect(output.mock.calls.flat().join("\n")).toContain("loaded: false\nrunning: false");
    startService(ctx);
    writeFileSync(pidfile(), "5432");
    writeFileSync(join(ctx.configDir, "logs", "service-runtime.json"), JSON.stringify({ supervisorPid: 4321, bridgePid: 5432 }));
    serviceStatus(ctx);
    expect(output.mock.calls.flat().join("\n")).toContain("loaded: true\nrunning: true\nbridge pid: 5432");
    writeFileSync(pidfile(), "");
    expect(() => serviceStatus(ctx)).not.toThrow();
    expect(output.mock.calls.at(-1)![0]).toContain("loaded: true\nrunning: false");
    expect(output.mock.calls.at(-1)![0]).toContain("Invalid or incomplete pidfile");
  });
  it("surfaces launchctl access errors and keeps the definition on failed bootout", () => {
    installService({}, ctx);
    loaded = true;
    const original = ctx.run;
    ctx.run = (cmd, args, input) => { if (args[0] === "bootout") throw new Error("permission denied"); return original(cmd, args, input); };
    expect(() => uninstallService(ctx)).toThrow(/permission denied/);
    expect(existsSync(plist())).toBe(true);
    ctx.run = () => { throw new Error("GUI unavailable"); };
    expect(() => serviceStatus(ctx)).toThrow(/GUI unavailable/);
  });
  it("rolls back enable when bootstrap fails", () => {
    installService({}, ctx);
    const original = ctx.run;
    ctx.run = (cmd, args, input) => { if (args[0] === "bootstrap") throw new Error("bootstrap failed"); return original(cmd, args, input); };
    expect(() => startService(ctx)).toThrow(/bootstrap failed/);
    expect(commands.at(-1)).toEqual(["disable", "gui/555/com.slackoc.bridge"]);
  });
  it("does not disable a concurrent successful activation when its own bootstrap loses", () => {
    installService({}, ctx);
    const original = ctx.run;
    ctx.run = (cmd, args, input) => {
      if (args[0] === "bootstrap") { loaded = true; throw new Error("already loaded"); }
      return original(cmd, args, input);
    };
    startService(ctx);
    expect(commands.some(c => c[0] === "disable")).toBe(false);
  });
});

describe("managed log rotation and shutdown", () => {
  it("bounds all three generations during interleaved stdout/stderr writes, including a huge chunk", () => {
    const path = join(root, "logs", "bridge.log");
    const append = rotatingLog(path, 64);
    for (let i = 0; i < 40; i++) append(`${i % 2 ? "stderr" : "stdout"}: ${i}\n`);
    append(Buffer.alloc(300, "x"));
    append("final stderr\n");
    for (const file of [path, `${path}.1`, `${path}.2`]) {
      expect(statSync(file).size).toBeLessThanOrEqual(64);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path, "utf8")).toContain("final stderr");
    chmodSync(path, 0o666);
    rotatingLog(path, 64)("restart\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("shutdown invokes cleanup once, exits on deadline, and ignores late completion", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(r => { finish = r; }));
    const done = vi.fn();
    const shutdown = boundedShutdown(cleanup, done, 500);
    const first = shutdown();
    expect(shutdown()).toBe(first);
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(done).toHaveBeenCalledExactlyOnceWith(1);
    finish();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("successful shutdown cancels its deadline and preserves the requested exit code", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    await boundedShutdown(async () => {}, done)(2);
    expect(done).toHaveBeenCalledExactlyOnceWith(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
