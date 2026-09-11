import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadConfig, saveConfig, CONFIG_PATH, maskToken } from "./config.js";
import { VERSION } from "./version.js";

export interface InitOptions {
  botToken?: string;
  appToken?: string;
  ownerId?: string;
  defaultDir?: string;
}

function entryDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** manifest lives one level up from both src/ and dist/cli.js */
function manifestPath(): string | null {
  const p = join(entryDir(), "..", "manifest", "slack-app-manifest.json");
  return existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Slack API validation helpers (also unit-tested with a stubbed fetch)

async function slackApi<T>(method: string, token: string): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json() as Promise<T>;
}

export function assertBotTokenShape(t: string): void {
  if (!t.startsWith("xoxb-")) throw new Error("bot token must start with xoxb-");
}

export function assertAppTokenShape(t: string): void {
  if (!t.startsWith("xapp-")) throw new Error("app-level token must start with xapp-");
}

export function assertOwnerIdShape(id: string): void {
  if (!/^U[A-Z0-9]{8,}$/.test(id)) throw new Error("that doesn't look like a Slack user id (expected U…)");
}

/** Validates a bot token against slack.com and returns workspace/bot info. */
export async function testBotToken(token: string): Promise<{ team?: string; user?: string; url?: string }> {
  assertBotTokenShape(token);
  const body = await slackApi<{ ok: boolean; team?: string; user?: string; url?: string; error?: string }>("auth.test", token);
  if (!body.ok) throw new Error(`auth.test failed: ${body.error ?? "unknown"}`);
  return body;
}

/** Validates an app-level token by opening a Socket Mode connection probe. */
export async function testAppToken(token: string): Promise<void> {
  assertAppTokenShape(token);
  const body = await slackApi<{ ok: boolean; error?: string }>("apps.connections.open", token);
  if (!body.ok) throw new Error(`apps.connections.open failed: ${body.error ?? "unknown"}`);
}

/**
 * Verifies the owner member id exists in the workspace (needs users:read on
 * the app — included in the bundled manifest). Scope missing → null (warn);
 * user itself unknown → throws (typo guard).
 */
export async function verifyOwnerId(botToken: string, ownerId: string): Promise<{ name?: string } | null> {
  assertOwnerIdShape(ownerId);
  const body = await slackApi<{ ok: boolean; user?: { name?: string; real_name?: string }; error?: string }>(
    `users.info?user=${ownerId}`,
    botToken,
  );
  if (!body.ok) {
    if (body.error === "missing_scope") return null; // app lacks users:read — warn, don't block
    if (body.error === "user_not_found") throw new Error(`no member ${ownerId} in that workspace (copy your member ID again)`);
    throw new Error(`users.info failed: ${body.error ?? "unknown"}`);
  }
  return { name: body.user?.real_name ?? body.user?.name };
}

// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions = {}): Promise<void> {
  console.log(`slackoc v${VERSION} — first-time setup\n`);

  if (loadConfig()) {
    console.log(`Found existing config at ${CONFIG_PATH} (will be overwritten).`);
  }

  const interactive = !(opts.botToken && opts.appToken && opts.ownerId);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = (q: string) => rl!.question(q).then((s) => s.trim());

  if (interactive) {
    console.log("Step 1 — create the Slack app in YOUR workspace (tokens stay private):");
    console.log("  1. Go to https://api.slack.com/apps → Create New App → From a manifest");
    console.log("  2. Pick your workspace → paste the JSON between the markers below (you may");
    console.log("     rename the bot / change its avatar — it's your app).");
    console.log("");
    const mp = manifestPath();
    if (mp) {
      console.log("----- manifest JSON (also at manifest/slack-app-manifest.json) -----");
      console.log(readFileSync(mp, "utf8").trim());
      console.log("----- end manifest -----");
    }
    console.log("");
    console.log("  3. Install the app to your workspace in OAuth & Permissions.");
    console.log("  4. Copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions.");
    console.log("  5. Under Basic Information → App-Level Tokens, generate one with the");
    console.log("     `connections:write` scope (manifest enables this) and copy it (xapp-…).");
    console.log("");
  }

  try {
    const botToken = opts.botToken ?? (await ask("Bot token (xoxb-…): "));
    const auth = await testBotToken(botToken);
    console.log(`  ✓ bot authenticated: @${auth.user}${auth.team ? ` (workspace: ${auth.team})` : ""}${auth.url ? ` — ${auth.url}` : ""}`);

    const appToken = opts.appToken ?? (await ask("App-level token (xapp-…): "));
    await testAppToken(appToken);
    console.log(`  ✓ app-level token valid (Socket Mode reachable)`);

    if (interactive) {
      console.log("\nHow to find YOUR Slack user id (the one person this bot will obey):");
      console.log("  Slack → open your profile → “⋯” → Copy member ID (starts with U)");
    }
    const ownerId = opts.ownerId ?? (await ask("Your Slack user id (U…): "));
    const owner = await verifyOwnerId(botToken, ownerId);
    console.log(owner?.name ? `  ✓ paired owner: ${owner.name}` : `  ✓ paired owner: ${ownerId} (name check skipped — app lacks users:read)`);

    const defaultDirInput = opts.defaultDir ?? (interactive ? await ask("Default project dir (blank = use SlackOC start cwd): ") : "");
    let defaultDir: string | undefined;
    if (defaultDirInput) {
      const abs = resolve(defaultDirInput);
      if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${abs} is not a directory`);
      defaultDir = abs;
    }

    saveConfig({
      slackBotToken: botToken,
      slackAppToken: appToken,
      ownerSlackUserId: ownerId,
      ...(defaultDir ? { defaultProjectDir: defaultDir } : {}),
      createdAt: new Date().toISOString(),
    });

    console.log(`\n✓ wrote ${CONFIG_PATH} (0600)`);
    console.log(`  bot: ${maskToken(botToken)} · app-level: ${maskToken(appToken)} · owner: ${ownerId}`);
    console.log("\nNext:");
    console.log("  slackoc doctor   # sanity-check tokens + OpenCode");
    console.log("  slackoc start    # bring the bridge up");
  } finally {
    rl?.close();
  }
}
