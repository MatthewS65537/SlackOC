import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { MIN_OPENCODE, VERSION } from "./version.js";

const execFileP = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Verdict for a live scope probe. The probe calls a scoped API with bogus
 * arguments: any non-scope error means the scope check PASSED before param
 * validation (granted); "missing_scope" means the installed app's manifest
 * drifted behind ours and needs a reinstall.
 */
export function scopeCheck(name: string, body: { ok: boolean; error?: string }): Check {
  return body.error === "missing_scope"
    ? { name, ok: false, detail: "missing — the installed app is behind the manifest; reinstall it (OAuth & Permissions → Reinstall)" }
    : { name, ok: true, detail: "granted" };
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
    const v = stdout.trim().match(/(\d+)\.(\d+)\.(\d+)/);
    if (!v) throw new Error(`unexpected version output: ${stdout.slice(0, 80).trim()}`);
    const [M, m, p] = [Number(v[1]), Number(v[2]), Number(v[3])] as const;
    const okV = M > MIN_OPENCODE[0] || (M === MIN_OPENCODE[0] && (m > MIN_OPENCODE[1] || (m === MIN_OPENCODE[1] && p >= MIN_OPENCODE[2])));
    checks.push({ name: `opencode ≥ ${MIN_OPENCODE.join(".")}`, ok: okV, detail: `${M}.${m}.${p}` });
  } catch (err) {
    checks.push({ name: "opencode on PATH", ok: false, detail: `not found or failed — ${String(err).slice(0, 120)}` });
  }

  const cfg = loadConfig();
  if (!cfg) {
    checks.push({ name: "config exists", ok: false, detail: "run `slackoc init`" });
  } else {
    checks.push({ name: "config exists", ok: true, detail: "config.json found" });
    checks.push({ name: "bot token shape", ok: cfg.slackBotToken.startsWith("xoxb-"), detail: "xoxb-…" });
    checks.push({ name: "app-level token shape", ok: cfg.slackAppToken.startsWith("xapp-"), detail: "xapp-…" });
    try {
      const auth = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.slackBotToken}` },
      }).then((r) => r.json() as Promise<{ ok: boolean; team?: string; user?: string; error?: string; url?: string }>);
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
        const body = await fetch("https://slack.com/api/apps.connections.open", {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.slackAppToken}` },
        }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
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
      const body: { ok: boolean; user?: { real_name?: string }; error?: string } = await fetch(
        `https://slack.com/api/users.info?user=${cfg.ownerSlackUserId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.slackBotToken}` },
        },
      )
        .then((r) => r.json() as Promise<{ ok: boolean; user?: { real_name?: string }; error?: string }>)
        .catch(() => ({ ok: false }));
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
        const b = await fetch(`https://slack.com/api/${probe.method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.slackBotToken}`, "content-type": "application/json" },
          body: JSON.stringify(probe.payload),
        }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
        checks.push(scopeCheck(probe.name, b));
      } catch (err) {
        checks.push({ name: probe.name, ok: false, detail: String(err).slice(0, 120) });
      }
    }
  }

  let fail = 0;
  console.log(`slackoc v${VERSION} doctor`);
  for (const c of checks) {
    console.log(` ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
    if (!c.ok) fail += 1;
  }
  if (fail) {
    console.log(`\n${fail} check(s) failed.`);
    return 1;
  }
  console.log("\nAll good — `slackoc start` when ready.");
  return 0;
}
