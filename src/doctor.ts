import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR, loadConfig } from "./config.js";
import { ScheduleStore } from "./schedules/store.js";
import { slackApi } from "./init.js";
import { isSupportedOpencodeVersion, MIN_OPENCODE, VERSION } from "./version.js";

const execFileP = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional piece missing: shown with "!", never counted as a failure. */
  warn?: boolean;
}

/**
 * Verdict for a live scope probe. The probe calls a scoped API with bogus
 * arguments. Known resource-validation errors prove access; auth, rate-limit,
 * server and unknown failures do not. Missing scopes require a reinstall.
 */
export function scopeCheck(name: string, body: { ok: boolean; error?: string }): Check {
  if (body.error === "missing_scope") {
    return { name, ok: false, detail: "missing — the installed app is behind the manifest; reinstall it (OAuth & Permissions → Reinstall)" };
  }
  if (body.ok || ["file_not_found", "channel_not_found", "message_not_found", "no_reaction"].includes(body.error ?? "")) {
    return { name, ok: true, detail: "granted" };
  }
  return { name, ok: false, detail: `unverified — ${body.error ?? "unexpected response"}; resolve the probe failure and rerun doctor` };
}

const OPENCODE_CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

/**
 * Local install checks: the optional file-send plugin and skill (docs/SETUP.md,
 * "Agent file delivery") and, when present, that schedules.json still loads.
 * The store constructor only reads; a store it rejects keeps \schedule offline.
 */
export function localChecks(configDir = CONFIG_DIR, opencodeDir = OPENCODE_CONFIG_DIR): Check[] {
  const checks: Check[] = [];
  for (const [name, file] of [
    ["file-send plugin", join(opencodeDir, "plugins", "slackoc-files.js")],
    ["slackoc-send-file skill", join(opencodeDir, "skills", "slackoc-send-file", "SKILL.md")],
  ] as const) {
    checks.push(existsSync(file)
      ? { name, ok: true, detail: file }
      : { name, ok: true, warn: true, detail: `not installed at ${file} — optional; agents can't send files to Slack (see docs/SETUP.md)` });
  }
  const schedules = join(configDir, "schedules.json");
  if (existsSync(schedules)) {
    try {
      checks.push({ name: "schedules.json", ok: true, detail: `${new ScheduleStore(schedules).jobs().length} job(s)` });
    } catch (err) {
      checks.push({ name: "schedules.json", ok: false, detail: `unreadable, scheduled reports are off — ${String((err as Error)?.message ?? err).slice(0, 120)}` });
    }
  }
  return checks;
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  const node = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node ≥ 20",
    ok: node[0]! >= 20,
    detail: `v${process.versions.node}`,
  });

  try {
    const { stdout } = await execFileP("opencode", ["--version"], { timeout: 15_000 });
    const version = stdout.trim().replace(/^opencode\s+/, "");
    checks.push({ name: `opencode V${MIN_OPENCODE[0]} ≥ ${MIN_OPENCODE.join(".")}`, ok: isSupportedOpencodeVersion(version),
      detail: version.slice(0, 120) || "empty version output" });
  } catch (err) {
    checks.push({ name: "opencode on PATH", ok: false, detail: `not found or failed — ${String(err).slice(0, 120)}` });
  }

  checks.push(...localChecks());

  const cfg = loadConfig();
  if (!cfg) {
    checks.push({ name: "config exists", ok: false, detail: "run `slackoc init`" });
  } else {
    checks.push({ name: "config exists", ok: true, detail: "config.json found" });
    checks.push({ name: "bot token shape", ok: cfg.slackBotToken.startsWith("xoxb-"), detail: "xoxb-…" });
    checks.push({ name: "app-level token shape", ok: cfg.slackAppToken.startsWith("xapp-"), detail: "xapp-…" });
    try {
      const auth = await slackApi<{ ok: boolean; team?: string; user?: string; error?: string; url?: string }>("auth.test", cfg.slackBotToken);
      checks.push(
        auth.ok
          ? { name: "bot token auth.test", ok: true, detail: `@${auth.user}${auth.team ? ` in ${auth.team}` : ""}${auth.url ? ` — ${auth.url}` : ""}` }
          : { name: "bot token auth.test", ok: false, detail: auth.error ?? "failed" },
      );
    } catch (err) {
      checks.push({ name: "bot token auth.test", ok: false, detail: String(err).slice(0, 120) });
    }
    if (cfg.slackAppToken.startsWith("xapp-")) {
      try {
        const body = await slackApi<{ ok: boolean; error?: string }>("apps.connections.open", cfg.slackAppToken);
        checks.push(
          body.ok
            ? { name: "app-level token (Socket Mode)", ok: true, detail: "connects" }
            : { name: "app-level token (Socket Mode)", ok: false, detail: body.error ?? "failed" },
        );
      } catch (err) {
        checks.push({ name: "app-level token (Socket Mode)", ok: false, detail: String(err).slice(0, 120) });
      }
    }
    {
      const body = await slackApi<{ ok: boolean; user?: { real_name?: string }; error?: string }>(
        `users.info?user=${cfg.ownerSlackUserId}`, cfg.slackBotToken,
      ).catch((): { ok: boolean; user?: { real_name?: string }; error?: string } => ({ ok: false }));
      if (body.ok) {
        checks.push({ name: "paired owner found", ok: true, detail: (body.user?.real_name ?? cfg.ownerSlackUserId) as string });
      } else if (body.error === "missing_scope") {
        checks.push({ name: "paired owner found", ok: true, detail: `${cfg.ownerSlackUserId} (unverified — app lacks users:read; reinstall app with updated manifest to enable)` });
      } else {
        checks.push({ name: "paired owner found", ok: false, detail: `users.info: ${body.error ?? "unreachable"}` });
      }
    }
    // Live scope probes (RQ6): Slack checks scopes before args, so a bogus
    // call that gets "missing_scope" PROVES the installed app is behind the
    // current manifest (e.g. files:read added 2026-09-05 — drift otherwise
    // only surfaces as attachment 403s / silent reactions at runtime).
    for (const probe of [
      { name: "scope files:read (attachments)", method: "files.info", payload: { file: "F0000000000" } },
      { name: "scope reactions:write (✅/❌)", method: "reactions.add", payload: { channel: "C0000000000", name: "x", timestamp: "0" } },
    ] as const) {
      try {
        const b = await slackApi<{ ok: boolean; error?: string }>(probe.method, cfg.slackBotToken, probe.payload);
        checks.push(scopeCheck(probe.name, b));
      } catch (err) {
        checks.push({ name: probe.name, ok: false, detail: String(err).slice(0, 120) });
      }
    }
  }

  let fail = 0;
  console.log(`slackoc v${VERSION} doctor`);
  for (const c of checks) {
    console.log(` ${c.warn ? "!" : c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
    if (!c.ok) fail += 1;
  }
  if (fail) {
    console.log(`\n${fail} check(s) failed.`);
    return 1;
  }
  console.log("\nAll good — `slackoc start` when ready.");
  return 0;
}
