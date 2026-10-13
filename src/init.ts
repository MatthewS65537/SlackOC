import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, saveConfig, CONFIG_PATH, maskToken, OWNER_ID_RE } from "./config.js";
import { VERSION } from "./version.js";

export interface InitOptions {
  botToken?: string;
  appToken?: string;
  ownerId?: string;
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
// Slack API validation helpers (also used by doctor; unit-tested with a stubbed fetch)

/** POST a Web API method; `payload` is sent as a JSON body. Gives up after 10 s so init/doctor never hang. */
function slackPost(method: string, token: string, payload?: object): Promise<Response> {
  return fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

export async function slackApi<T>(method: string, token: string, payload?: object): Promise<T> {
  return (await slackPost(method, token, payload)).json() as Promise<T>;
}

/**
 * slackApi plus the calling token's granted scopes, which Slack lists in the
 * `x-oauth-scopes` response header. null when the header is absent (e.g. a proxy stripped it).
 */
export async function slackApiWithScopes<T>(method: string, token: string, payload?: object): Promise<{ body: T; scopes: string[] | null }> {
  const res = await slackPost(method, token, payload);
  const header = res.headers.get("x-oauth-scopes");
  return { body: await res.json() as T, scopes: header === null ? null : header.split(",").map((s) => s.trim()).filter(Boolean) };
}

export function assertBotTokenShape(t: string): void {
  if (!t.startsWith("xoxb-")) throw new Error("bot token must start with xoxb-");
}

export function assertAppTokenShape(t: string): void {
  if (!t.startsWith("xapp-")) throw new Error("app-level token must start with xapp-");
}

export function assertOwnerIdShape(id: string): void {
  if (!OWNER_ID_RE.test(id)) throw new Error("that doesn't look like a Slack user id (expected U…)");
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

  // Optional settings (e.g. `ship`) survive a re-init; tokens/owner are replaced.
  const prev = loadConfig();
  if (prev) {
    console.log(`Found existing config at ${CONFIG_PATH} (tokens will be replaced).`);
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

    saveConfig({
      ...prev,
      slackBotToken: botToken,
      slackAppToken: appToken,
      ownerSlackUserId: ownerId,
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
