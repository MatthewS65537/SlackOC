/** Manual isolated lifecycle check: npx tsx test/integration/service-launchd.ts
 * Uses a unique label and repo-local fixtures. Never launches the Slack bridge.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "tsup";
import { renderServicePlist, SERVICE_LABEL } from "../../src/service.js";

if (process.platform !== "darwin") throw new Error("This probe requires macOS and an active GUI login.");
const label = `com.slackoc.test.service.${process.pid}`;
const domain = `gui/${process.getuid!()}`;
const target = `${domain}/${label}`;
const root = resolve(`test/.fixtures/service-launchd-${process.pid}`);
const configDir = join(root, "config parent", "slackoc");
const plist = join(root, "probe.plist");
const launchctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
const starts = (): number[] => existsSync(join(configDir, "probe-starts.log")) ? readFileSync(join(configDir, "probe-starts.log"), "utf8").trim().split("\n").map(Number) : [];
const jobPid = (): number | null => {
  const row = launchctl("list").split("\n").map(l => l.trim().split(/\s+/)).find(p => p[2] === label);
  return row && /^\d+$/.test(row[0]!) ? Number(row[0]) : null;
};
async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert(Date.now() < deadline, `Timed out: ${description}`);
    await delay(100);
  }
}

launchctl("print", domain); // Permission/session preflight, before creating any job.
mkdirSync(configDir, { recursive: true, mode: 0o700 });
try {
  await build({ entry: { probe: "test/integration/service-probe-entry.ts" }, outDir: root, format: ["esm"], outExtension: () => ({ js: ".mjs" }), target: "node20", bundle: true, splitting: false, clean: false, dts: false, sourcemap: false, silent: true });
  const xml = renderServicePlist({ node: process.execPath, cli: join(root, "probe.mjs"), cwd: root, configDir, keepAwake: true,
    env: { HOME: process.env.HOME!, PATH: "/usr/bin:/bin", SLACKOC_HOME: join(root, "config parent") },
  }).replaceAll(SERVICE_LABEL, label);
  writeFileSync(plist, xml, { mode: 0o600 });
  assert.equal(jobPid(), null, "writing the plist must not start a job");
  launchctl("enable", target);
  launchctl("bootstrap", domain, plist);
  await until(() => starts().length >= 1, "first harmless bridge start");
  const firstBridge = starts()[0]!;
  const firstSupervisor = jobPid();
  assert(firstSupervisor && firstSupervisor !== firstBridge, "supervisor and bridge are separate processes");
  const children = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n");
  const caffeine = children.map(l => l.trim().split(/\s+/)).find(p => Number(p[1]) === firstBridge && p[2]?.endsWith("caffeinate"));
  assert(caffeine, "optional caffeinate child is running");
  // Only the unique fixture job is signaled. SIGKILL proves crash cleanup.
  process.kill(firstBridge, "SIGKILL");
  await until(() => starts().length >= 2, "launchd crash restart");
  assert.notEqual(starts().at(-1), firstBridge);
  await until(() => {
    try { process.kill(Number(caffeine[0]), 0); return false; } catch { return true; }
  }, "caffeinate follows bridge death");
  const secondBridge = starts().at(-1)!;
  launchctl("kill", "SIGKILL", target);
  await until(() => starts().length >= 3, "supervisor crash restart");
  await until(() => {
    try { process.kill(secondBridge, 0); return false; } catch { return true; }
  }, "launchd cleans up the old supervisor's process group");
  const log = readFileSync(join(configDir, "logs", "bridge.log"), "utf8");
  assert(log.includes("probe stdout") && log.includes("probe stderr"), "both streams are persistent");
  launchctl("disable", target);
  launchctl("bootout", target);
  const count = starts().length;
  await delay(11_000); // longer than the configured 10-second throttle
  assert.equal(jobPid(), null);
  assert.equal(starts().length, count, "intentional stop must not restart");
  launchctl("enable", target);
  launchctl("bootstrap", domain, plist);
  await until(() => starts().length > count, "explicit start after disable");
  console.log(`PASS ${label}: write-only install, activation, child/supervisor crash restart, process-group cleanup, stdout/stderr, caffeinate crash cleanup, persistent stop, explicit restart.`);
} finally {
  // No installed LaunchAgent path is used; no unrelated process is touched.
  try { launchctl("disable", target); } catch { /* domain may have ended */ }
  try { launchctl("bootout", target); } catch { /* already unloaded */ }
  // Clear the test-only disabled override after removing its only definition.
  rmSync(plist, { force: true });
  try { launchctl("enable", target); } catch { /* domain may have ended */ }
  rmSync(root, { recursive: true, force: true });
}
