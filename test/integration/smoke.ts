/**
 * Manual integration smoke test for the OpenCode side (no Slack).
 * Run: npm run smoke
 * Costs one tiny prompt against your configured OpenCode providers.
 */

import { mkdirSync } from "node:fs";
import { ServerPool } from "../../src/opencode/server.js";
import { promptAsync, sessionCreate, sessionGet } from "../../src/opencode/client.js";

const SCRATCH = "scratch/integration";

async function main(): Promise<void> {
  mkdirSync(SCRATCH, { recursive: true });
  const events: string[] = [];
  const assistantTexts: string[] = [];
  const roles = new Map<string, string>(); // messageID -> role

  const pool = new ServerPool((_dir, type, props) => {
    events.push(type);
    const info = props.info as { id?: string; role?: string; sessionID?: string } | undefined;
    if (type === "message.updated" && info?.role) {
      if (info.id && !roles.has(info.id)) roles.set(info.id, info.role);
      return;
    }
    if (type === "message.part.updated") {
      const part = props.part as { messageID?: string; type?: string; text?: string; time?: { end?: number } } | undefined;
      if (part?.type === "text" && part.text?.trim()) {
        const role = roles.get(part.messageID ?? "") ?? "?";
        if (part.time?.end) console.error(`TEXT[${role}${part.time?.end !== undefined ? ":end" : ""}] ${JSON.stringify(part.text.slice(0, 60))}`);
        if (role !== "user" && part.time?.end) assistantTexts.push(part.text);
      }
    }
  }, (msg) => console.error("  [pool]", msg));

  try {
    const entry = await pool.ensure(SCRATCH);
    console.error("✓ server up:", entry.baseUrl);

    const sess = await sessionCreate(entry.client!, "slackoc-smoke");
    console.error("✓ session created:", sess.id);

    await promptAsync(entry.client!, sess.id, "Reply with exactly the single word: ok");

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !events.includes("session.idle") && !events.includes("session.error")) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const full = assistantTexts.join("");
    const seenIdle = events.includes("session.idle");
    const hasOk = /\bok\b/i.test(full);
    const sessionOk = await sessionGet(entry.client!, sess.id).then(() => true).catch(() => false);

    console.error(`events seen: ${[...new Set(events)].join(", ")}`);
    console.error(`roles map: ${JSON.stringify([...roles])}`);
    console.error(`assistant text contains "ok": ${hasOk} — ${JSON.stringify(full.slice(0, 120))}`);

    if (!seenIdle || !hasOk || !sessionOk) {
      console.error("✗ SMOKE FAILED");
      process.exitCode = 1;
    } else {
      console.error("✓ SMOKE PASSED");
    }
  } finally {
    await pool.killAll();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ SMOKE FAILED:", err);
  process.exit(1);
});
