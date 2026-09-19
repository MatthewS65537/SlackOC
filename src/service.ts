import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { parseFlags } from "./args.js";
import { rotatingLog } from "./service-log.js";

export const SERVICE_LABEL = "com.slackoc.bridge";
export const SERVICE_LOG_PATH = join(CONFIG_DIR, "logs", "bridge.log");
const ENV_KEYS = ["HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "SLACKOC_HOME"] as const;
const USAGE = "slackoc service install [--dir /absolute/project] [--keep-awake true|false] | start | stop | status | uninstall";

type Run = (command: string, args: string[], input?: string) => string;
const run: Run = (command, args, input) => execFileSync(command, args, {
  encoding: "utf8", input, timeout: 20_000, stdio: ["pipe", "pipe", "pipe"],
});

/** Injectable OS boundary for isolated lifecycle tests (never the real job). */
export interface ServiceContext {
  platform: string;
  home: string;
  configDir: string;
  cwd: string;
  node: string;
  cli: string;
  uid: number;
  env: NodeJS.ProcessEnv;
  run: Run;
  alive: (pid: number) => boolean;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function serviceContext(): ServiceContext {
  return {
    platform: process.platform, home: homedir(), configDir: resolve(CONFIG_DIR),
    cwd: process.cwd(), node: process.execPath, cli: resolve(process.argv[1] ?? ""),
    uid: process.getuid?.() ?? 0, env: process.env, run, alive,
  };
}

function gate(ctx: ServiceContext): void {
  if (ctx.platform !== "darwin") throw new Error("slackoc service requires macOS (a logged-in user's LaunchAgent).");
}
function plistPath(ctx: ServiceContext): string { return join(ctx.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`); }
function domain(ctx: ServiceContext): string { return `gui/${ctx.uid}`; }
function target(ctx: ServiceContext): string { return `${domain(ctx)}/${SERVICE_LABEL}`; }
function ctl(ctx: ServiceContext, args: string[]): string { return ctx.run("/bin/launchctl", args); }

export interface ServiceDefinition {
  node: string;
  cli: string;
  cwd: string;
  configDir: string;
  keepAwake: boolean;
  env: Record<string, string>;
}

export function serviceEnvironment(env: NodeJS.ProcessEnv, cwd: string, node: string, home: string): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ENV_KEYS) if (env[key] !== undefined) safe[key] = env[key]!;
  safe.HOME = home;
  safe.PATH = [...new Set([dirname(node), ...(env.PATH ?? "").split(":").filter(Boolean).map(p => resolve(cwd, p)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  if (safe.SLACKOC_HOME !== undefined) safe.SLACKOC_HOME = resolve(cwd, safe.SLACKOC_HOME);
  return safe;
}

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("Invalid control character in service configuration");
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function renderServicePlist(def: ServiceDefinition): string {
  const strings = [def.node, def.cli, "service", "run"].map(v => `<string>${xml(v)}</string>`).join("");
  const env = { ...def.env, SLACKOC_SERVICE: "supervisor", SLACKOC_SERVICE_KEEP_AWAKE: String(def.keepAwake) };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${strings}</array>
<key>WorkingDirectory</key><string>${xml(def.cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>Disabled</key><true/>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>AbandonProcessGroup</key><false/>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

function definition(ctx: ServiceContext): ServiceDefinition | null {
  const path = plistPath(ctx);
  if (!existsSync(path)) return null;
  const data = JSON.parse(ctx.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path])) as {
    Label?: string; ProgramArguments?: string[]; WorkingDirectory?: string; EnvironmentVariables?: Record<string, string>;
  };
  if (data.Label !== SERVICE_LABEL || !data.ProgramArguments?.[0] || !data.ProgramArguments[1] || !data.WorkingDirectory) {
    throw new Error(`Unrecognized service definition at ${path}`);
  }
  const env = data.EnvironmentVariables ?? {};
  return {
    node: data.ProgramArguments[0], cli: data.ProgramArguments[1], cwd: data.WorkingDirectory,
    configDir: resolve(join(env.SLACKOC_HOME ?? join(ctx.home, ".config"), "slackoc")),
    keepAwake: env.SLACKOC_SERVICE_KEEP_AWAKE === "true", env,
  };
}

function loadedJob(ctx: ServiceContext): { loaded: boolean; pid: number | null; lastExit: number | null } {
  // Check access separately: an inaccessible GUI domain is not "not installed".
  ctl(ctx, ["print", domain(ctx)]);
  // Unlike `print`, this three-column format is documented by launchctl(1).
  const line = ctl(ctx, ["list"]).split("\n").map(l => l.trim().split(/\s+/)).find(parts => parts[2] === SERVICE_LABEL);
  return { loaded: !!line, pid: line && /^\d+$/.test(line[0]!) ? Number(line[0]) : null, lastExit: line ? Number(line[1]) : null };
}

function readPid(path: string, allowStalePartial = false): number | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  const pid = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    // Match claimPidfile's legacy-partial grace. The bridge still owns recovery
    // under its claim lock; service preflight never edits a shared pidfile.
    if (allowStalePartial && Date.now() - statSync(path).mtimeMs >= 30_000) return null;
    throw new Error(`Invalid or incomplete pidfile at ${path}; another instance may be starting.`);
  }
  return pid;
}

function runtimePath(configDir: string): string { return join(configDir, "logs", "service-runtime.json"); }
function runtime(configDir: string): { supervisorPid: number; bridgePid: number } | null {
  try { return JSON.parse(readFileSync(runtimePath(configDir), "utf8")); } catch { return null; }
}

function assertNoBridge(ctx: ServiceContext, configDir: string): void {
  // Check both the install's home and the invoking CLI's home before activation.
  for (const dir of new Set([configDir, ctx.configDir])) {
    const pid = readPid(join(dir, "slackoc.pid"), true);
    if (pid && ctx.alive(pid)) throw new Error(`slackoc already running (pid ${pid}); stop that bridge before starting the service.`);
  }
}

function secureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function installService(opts: { dir?: string; keepAwake?: boolean }, ctx = serviceContext()): void {
  gate(ctx);
  const cwd = opts.dir ?? ctx.cwd;
  if (!isAbsolute(cwd)) throw new Error("--dir must be an absolute directory path");
  if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  if (!existsSync(join(ctx.configDir, "config.json"))) throw new Error("No SlackOC config; run slackoc init first.");
  const node = realpathSync(ctx.node);
  const cli = realpathSync(ctx.cli);
  if (!/\.[cm]?js$/.test(cli)) throw new Error("Install using the built slackoc CLI (npm run build), not a TypeScript dev invocation.");
  if (loadedJob(ctx).loaded) throw new Error("Service is loaded; run slackoc service stop before changing its installation.");
  const def: ServiceDefinition = { node, cli, cwd: realpathSync(cwd), configDir: ctx.configDir,
    keepAwake: opts.keepAwake ?? false, env: serviceEnvironment(ctx.env, ctx.cwd, node, ctx.home) };
  const plist = renderServicePlist(def);
  secureDir(ctx.configDir);
  rotatingLog(join(ctx.configDir, "logs", "bridge.log"));
  const path = plistPath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.new`;
  try {
    writeFileSync(temp, plist, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  console.log(`installed: ${path}\ndefault cwd: ${def.cwd}\nkeep awake: ${def.keepAwake}\nRun slackoc service start to activate.`);
  console.log("Only HOME, PATH, LANG, LC_ALL, LC_CTYPE and SLACKOC_HOME are saved. Configure environment-only providers in OpenCode's saved configuration/auth before starting.");
}

export function startService(ctx = serviceContext()): void {
  gate(ctx);
  const def = definition(ctx);
  if (!def) throw new Error("Service is not installed; run slackoc service install first.");
  const job = loadedJob(ctx);
  if (job.loaded) {
    // No kickstart: it could create a competing consumer while a manual bridge owns the pidfile.
    console.log("service already loaded; use slackoc service status for bridge health.");
    return;
  }
  if (def.env.SLACKOC_SERVICE !== "supervisor") throw new Error("Legacy daemon definition: stop it and run slackoc service install to migrate.");
  for (const path of [def.node, def.cli, join(def.configDir, "config.json")]) {
    if (!existsSync(path)) throw new Error(`Service path no longer exists: ${path}; reinstall the service.`);
  }
  if (!statSync(def.cwd).isDirectory()) throw new Error(`Service working directory is unavailable: ${def.cwd}`);
  assertNoBridge(ctx, def.configDir);
  ctl(ctx, ["enable", target(ctx)]);
  try { ctl(ctx, ["bootstrap", domain(ctx), plistPath(ctx)]); }
  catch (err) {
    // Another start may have won the race for the same launchd label.
    if (loadedJob(ctx).loaded) {
      console.log("service already loaded by another start; check service status.");
      return;
    }
    // A failed activation must not silently enable a future login launch.
    ctl(ctx, ["disable", target(ctx)]);
    throw err;
  }
  console.log("service activated; run slackoc service status to check the bridge PID and logs.");
}

export function stopService(ctx = serviceContext()): void {
  gate(ctx);
  ctl(ctx, ["print", domain(ctx)]);
  ctl(ctx, ["disable", target(ctx)]);
  // Always attempt bootout after disable: a concurrent start could have loaded
  // the job after an earlier status snapshot. Missing jobs are already stopped.
  try { ctl(ctx, ["bootout", target(ctx)]); }
  catch (err) { if (loadedJob(ctx).loaded) throw err; }
  console.log("service stopped and disabled (including at login); service start re-enables it.");
}

/** Called by stopBridge BEFORE reading/signaling the pidfile. False => manual stop path. */
export async function stopManagedService(ctx = serviceContext()): Promise<boolean> {
  if (ctx.platform !== "darwin") return false;
  const def = definition(ctx);
  if (!def || def.configDir !== ctx.configDir) return false;
  const job = loadedJob(ctx);
  if (!job.loaded) return false;
  const pid = readPid(join(ctx.configDir, "slackoc.pid"));
  const owned = runtime(ctx.configDir);
  if (pid && ctx.alive(pid) && pid !== job.pid && !(owned?.supervisorPid === job.pid && owned?.bridgePid === pid)) return false;
  stopService(ctx);
  return true;
}

export function serviceStatus(ctx = serviceContext()): void {
  gate(ctx);
  const def = definition(ctx);
  const job = loadedJob(ctx);
  const dir = def?.configDir ?? ctx.configDir;
  const owned = runtime(dir);
  let pid: number | null = null;
  let pidError: string | undefined;
  try { pid = readPid(join(dir, "slackoc.pid")); }
  catch (err) { pidError = err instanceof Error ? err.message : String(err); }
  const running = !!(pid && ctx.alive(pid) && (pid === job.pid || (owned?.supervisorPid === job.pid && owned?.bridgePid === pid)));
  console.log([
    `installed: ${!!def}`, `loaded: ${job.loaded}`, `running: ${running}`,
    `bridge pid: ${running ? pid : "none"}`, `supervisor pid: ${job.pid ?? "none"}`,
    `last exit: ${job.lastExit ?? "none"}`, `default cwd: ${def?.cwd ?? "not installed"}`,
    `log: ${join(dir, "logs", "bridge.log")}`, `keep awake: ${def?.keepAwake ?? false}`,
    `node: ${def?.node ?? "not installed"}`, `cli: ${def?.cli ?? "not installed"}`,
    `config: ${dir}`, `pidfile: ${pidError ?? pid ?? "none"}${pid && ctx.alive(pid) && !running ? " (live, not owned by this service)" : ""}`,
    "running means a live process, not verified Slack connectivity; inspect the log for startup errors.",
  ].join("\n"));
}

export function uninstallService(ctx = serviceContext()): void {
  gate(ctx);
  stopService(ctx);
  rmSync(plistPath(ctx), { force: true });
  console.log("service definition removed; config, state and logs retained.");
}

export function parseServiceArgs(args: string[]): { command: string; dir?: string; keepAwake?: boolean } {
  const command = args[0] ?? "";
  if (!["install", "start", "stop", "status", "uninstall"].includes(command)) throw new Error(`usage: ${USAGE}`);
  const flags = parseFlags(args.slice(1), command === "install" ? ["dir", "keep-awake"] : []);
  // parseFlags intentionally ignores positionals for other commands; service does not.
  for (let i = 1; i < args.length; i++) {
    if (!args[i]!.startsWith("--")) throw new Error(`Unexpected argument: ${args[i]}`);
    if (!args[i]!.includes("=")) i++;
  }
  if (flags.dir !== undefined && !isAbsolute(flags.dir)) throw new Error("--dir must be an absolute directory path");
  if (flags["keep-awake"] !== undefined && !["true", "false"].includes(flags["keep-awake"])) throw new Error("--keep-awake must be explicitly true or false");
  return { command, dir: flags.dir, keepAwake: flags["keep-awake"] === undefined ? undefined : flags["keep-awake"] === "true" };
}

export async function runServiceCommand(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "run" && process.env.SLACKOC_SERVICE === "supervisor") {
    await superviseBridge();
    return;
  }
  const opts = parseServiceArgs(args);
  switch (opts.command) {
    case "install": installService(opts); break;
    case "start": startService(); break;
    case "stop": stopService(); break;
    case "status": serviceStatus(); break;
    case "uninstall": uninstallService(); break;
  }
}

/** Call once after the pidfile is claimed; close during bounded bridge shutdown.
 * -w releases the assertion even on SIGKILL, where JS cleanup cannot run.
 */
export function startManagedRuntime(): { close: () => void } {
  let child: ChildProcess | undefined;
  if (process.platform === "darwin" && process.env.SLACKOC_SERVICE === "bridge" && process.env.SLACKOC_SERVICE_KEEP_AWAKE === "true") {
    child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", err => console.error(`keep-awake failed: ${err.message}`));
    child.unref();
  }
  let closed = false;
  return { close: () => { if (closed) return; closed = true; child?.kill("SIGTERM"); } };
}

/** Register the returned function as early as possible. Cleanup runs once;
 * onDone runs once even when cleanup stalls. Caller owns process.exit and pidfile removal.
 */
export function boundedShutdown(cleanup: () => Promise<void>, onDone: (code: number) => void, timeoutMs = 8_000): (code?: number) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (code = 0) => {
    pending ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      let failed = false;
      await Promise.race([
        Promise.resolve().then(cleanup).catch(err => { failed = true; console.error("shutdown:", err); }),
        new Promise<void>(resolveDone => { timer = setTimeout(() => { failed = true; resolveDone(); }, timeoutMs); }),
      ]);
      clearTimeout(timer);
      onDone(failed ? 1 : code);
    })();
    return pending;
  };
}

/** The supervisor is launchd's process. It never connects to Slack and is the
 * sole file writer. Bridge stdout/stderr (including pre-start failures) are pipes,
 * so renaming logs cannot strand an open launchd fd on an unbounded old inode.
 */
export async function superviseBridge(ctx = serviceContext()): Promise<void> {
  gate(ctx);
  process.umask(0o077);
  const writeLog = rotatingLog(join(ctx.configDir, "logs", "bridge.log"));
  let child: ChildProcess | undefined;
  let done: Promise<number> | undefined;
  let stopping = false;
  let failed = false;
  let force: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child?.kill("SIGTERM");
    force = setTimeout(() => { child?.kill("SIGKILL"); }, 10_000);
    force.unref();
  };
  const append = (data: Buffer | string) => {
    try { writeLog(data); }
    catch {
      // Disk errors from a pipe callback must follow the same bounded cleanup
      // path as other failures, rather than escaping while a child keeps running.
      failed = true;
      stop();
    }
  };
  const stamp = (line: string) => append(`${new Date().toISOString()} [service] ${line}\n`);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    assertNoBridge(ctx, ctx.configDir);
    const env = serviceEnvironment(ctx.env, ctx.cwd, ctx.node, ctx.home);
    env.SLACKOC_SERVICE = "bridge";
    env.SLACKOC_SERVICE_KEEP_AWAKE = ctx.env.SLACKOC_SERVICE_KEEP_AWAKE ?? "false";
    child = spawn(ctx.node, [ctx.cli, "start"], { cwd: ctx.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    done = new Promise<number>((resolveDone) => {
      let drain: NodeJS.Timeout | undefined;
      child!.once("error", err => {
        failed = true;
        stamp(`child error: ${err.message}`);
        if (!child!.pid) resolveDone(1);
        else stop();
      });
      child!.once("exit", (code, signal) => {
        stamp(`bridge exited: code=${code} signal=${signal ?? "none"}`);
        // A descendant holding a pipe open must not strand the supervisor.
        drain = setTimeout(() => {
          child!.stdout?.destroy(); child!.stderr?.destroy();
          resolveDone(stopping ? 0 : code || 1);
        }, 1_000);
      });
      child!.once("close", (code) => {
        clearTimeout(drain);
        resolveDone(stopping ? 0 : code || 1);
      });
    });
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    if (child.pid) {
      writeFileSync(runtimePath(ctx.configDir), JSON.stringify({ supervisorPid: process.pid, bridgePid: child.pid }), { mode: 0o600 });
      stamp(`bridge started: pid=${child.pid} cwd=${ctx.cwd}`);
    }
    const code = await done;
    process.exitCode = failed ? 1 : code;
  } catch (err) {
    failed = true;
    stamp(`startup failed: ${String(err)}`);
    stop();
    process.exitCode = 1;
  } finally {
    // Includes failures after spawn but before the normal await (e.g. metadata
    // write failure). Keep signal handlers and the SIGKILL deadline until reaped.
    if (done) await done;
    clearTimeout(force);
    try {
      const owned = runtime(ctx.configDir);
      if (owned?.supervisorPid === process.pid) rmSync(runtimePath(ctx.configDir), { force: true });
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
}
