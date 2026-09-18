/**
 * `slackoc daemon install|uninstall|status` — run the bridge as a
 * user-level service (launchd on macOS, systemd user units on Linux) so it
 * survives logout and restarts. No sudo: per-user services only.
 *
 * The generated unit runs `node <this cli> start` from the install-time cwd
 * (the project the bridge should bind). App logs go to the rotated
 * bridge.log (D8); stdout/stderr go to daemon-*.log in the config dir for
 * boot failures that happen before logging starts.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR, CONFIG_PATH } from "./config.js";

export const SERVICE_NAME = "slackoc";
const LAUNCHD_LABEL = "com.slackoc.bridge";

export type Platform = "darwin" | "linux" | "unsupported";

export function detectPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return "unsupported";
}

/** launchd target for the current user's GUI session. */
function guiTarget(): string {
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}`;
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

/** The node invocation that runs the bridge, resolved from the running CLI. */
export function bridgeInvocation(): { node: string; cli: string } {
  // argv[1] is the built cli.js (the bin shim execs node on it).
  const cli = process.argv[1] ?? join(import.meta.dirname ?? ".", "cli.js");
  return { node: process.execPath, cli };
}

/** Render the launchd plist. Pure — tested directly. */
export function renderLaunchdPlist(opts: { node: string; cli: string; workdir: string; path: string }): string {
  const { node, cli, workdir, path: envPath } = opts;
  const out = join(CONFIG_DIR, "daemon-stdout.log");
  const err = join(CONFIG_DIR, "daemon-stderr.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${envPath}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${err}</string>
</dict>
</plist>
`;
}

/** Render the systemd user unit. Pure — tested directly. */
export function renderSystemdUnit(opts: { node: string; cli: string; workdir: string; path: string }): string {
  const { node, cli, workdir, path: envPath } = opts;
  const err = join(CONFIG_DIR, "daemon-stderr.log");
  return `[Unit]
Description=SlackOC bridge (Slack <-> OpenCode)
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${cli} start
WorkingDirectory=${workdir}
Environment=PATH=${envPath}
Restart=always
RestartSec=3
StandardOutput=append:${join(CONFIG_DIR, "daemon-stdout.log")}
StandardError=append:${err}

[Install]
WantedBy=default.target
`;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "" } }).trim();
}

export async function daemonInstall(workdir: string): Promise<number> {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    console.error("daemon support is macOS (launchd) or Linux (systemd user units) only.");
    return 1;
  }
  if (!existsSync(CONFIG_PATH)) {
    console.error(`no config at ${CONFIG_PATH} — run \`slackoc init\` first.`);
    return 1;
  }
  const { node, cli } = bridgeInvocation();
  const opts = { node, cli, workdir, path: process.env.PATH ?? "/usr/bin:/bin" };
  mkdirSync(CONFIG_DIR, { recursive: true });

  if (platform === "darwin") {
    const plistPath = launchdPlistPath();
    mkdirSync(dirname(plistPath), { recursive: true });
    try {
      run("launchctl", ["bootout", `${guiTarget()}/${LAUNCHD_LABEL}`]);
    } catch {
      /* not loaded — fine */
    }
    writeFileSync(plistPath, renderLaunchdPlist(opts));
    run("launchctl", ["bootstrap", guiTarget(), plistPath]);
    console.log(`installed: ${plistPath}`);
    console.log(`logs: ${join(CONFIG_DIR, "daemon-stderr.log")} (boot) / bridge.log (app)`);
  } else {
    const unitPath = systemdUnitPath();
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, renderSystemdUnit(opts));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
    console.log(`installed: ${unitPath}`);
    console.log(`logs: ${join(CONFIG_DIR, "daemon-stderr.log")} (boot) / bridge.log (app)`);
  }
  console.log(`workdir: ${workdir} (re-run \`slackoc daemon install --dir <path>\` to change)`);
  return 0;
}

export async function daemonUninstall(): Promise<number> {
  const platform = detectPlatform();
  if (platform === "darwin") {
    try {
      run("launchctl", ["bootout", `${guiTarget()}/${LAUNCHD_LABEL}`]);
    } catch {
      /* not loaded */
    }
    const p = launchdPlistPath();
    if (existsSync(p)) rmSync(p);
  } else if (platform === "linux") {
    try {
      run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
    } catch {
      /* not enabled */
    }
    const u = systemdUnitPath();
    if (existsSync(u)) rmSync(u);
    try {
      run("systemctl", ["--user", "daemon-reload"]);
    } catch {
      /* fine */
    }
  } else {
    console.error("daemon support is macOS (launchd) or Linux (systemd user units) only.");
    return 1;
  }
  console.log("uninstalled.");
  return 0;
}

export async function daemonStatus(): Promise<number> {
  const platform = detectPlatform();
  if (platform === "darwin") {
    try {
      // Capture stderr — launchctl prints "Could not find service…" to it.
      const out = execFileSync("launchctl", ["list", LAUNCHD_LABEL], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      console.log(`loaded: yes\n${out}`);
    } catch {
      console.log("loaded: no (run `slackoc daemon install`)");
      return 1;
    }
    return 0;
  }
  if (platform === "linux") {
    // is-active / is-enabled exit non-zero for inactive/disabled but still
    // print the state to stdout — read it off the thrown error.
    const state = (args: string[]): string => {
      try {
        return run("systemctl", ["--user", ...args]);
      } catch (err) {
        const out = (err as { stdout?: Buffer | string }).stdout;
        const text = out ? (Buffer.isBuffer(out) ? out.toString() : out).trim() : "";
        if (text) return text;
        throw err;
      }
    };
    try {
      const active = state(["is-active", SERVICE_NAME]);
      const enabled = state(["is-enabled", SERVICE_NAME]);
      console.log(`active: ${active}\nenabled: ${enabled}`);
      return active === "active" ? 0 : 1;
    } catch {
      console.log("not installed (run `slackoc daemon install`)");
      return 1;
    }
  }
  console.error("daemon support is macOS (launchd) or Linux (systemd user units) only.");
  return 1;
}

/** Read back the installed unit's WorkingDirectory, if any (for status display). */
export function installedWorkdir(): string | null {
  const platform = detectPlatform();
  const p = platform === "darwin" ? launchdPlistPath() : platform === "linux" ? systemdUnitPath() : null;
  if (!p || !existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const m = text.match(/(?:WorkingDirectory<\/key><string>|^WorkingDirectory=)(.*)$/m);
  return m?.[1]?.trim() ?? null;
}
