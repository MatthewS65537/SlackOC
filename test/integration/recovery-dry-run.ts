/** Read-only production-state inspection; all migration writes target a temporary local copy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StateStore } from "../../src/state.js";
import { classifyRecovery, replayAge, timestampFromMs } from "../../src/slack/recovery-policy.js";

const source = process.argv[2];
if (!source) throw new Error("Usage: tsx test/integration/recovery-dry-run.ts /path/to/state.json");
const original = readFileSync(source);
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const root = mkdtempSync(resolve("test/.fixtures/recovery-dry-run-"));
const copy = resolve(root, "state.json");
try {
  writeFileSync(copy, original, { mode: 0o600 });
  const now = Date.now();
  const state = new StateStore(copy, () => now);
  state.migrateRecovery();
  const first = readFileSync(copy);
  state.migrateRecovery();
  assert.equal(readFileSync(copy).toString(), first.toString(), "migration must be idempotent");
  let expired = 0, recent = 0, invalid = 0, maintenanceFreshened = 0;
  for (const { thread } of state.threadsForCatchup()) {
    const ts = thread.lastSeenTs;
    const age = replayAge(ts, now);
    if (age.decision === "expired") {
      expired++;
      if (now - thread.lastUsedAt <= 72 * 60 * 60_000) maintenanceFreshened++;
      assert.equal(classifyRecovery({ ts: ts!, thread, now, context: { source: "history" } }).decision, "expired");
      assert.equal(classifyRecovery({ ts: ts!, thread, now, context: { source: "live" } }).decision, "expired");
    } else if (age.decision === "recover") recent++;
    else invalid++;
    // No original prompt is executed: only pure policy calls against the copied state.
    if (!thread.hushed && !thread.watchOnly) assert.equal(classifyRecovery({
      ts: timestampFromMs(now + 1), thread, now, context: { source: "live" },
    }).decision, "recover", "fresh owner input must remain possible");
  }
  assert.equal(digest(readFileSync(source)), digest(original), "source state changed during dry run");
  console.log(JSON.stringify({ threads: expired + recent + invalid, expired, recent, invalid, maintenanceFreshened,
    migrationIdempotent: true, sourceUnchanged: true, submittedPrompts: 0 }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
