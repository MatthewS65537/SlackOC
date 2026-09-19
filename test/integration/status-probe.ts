/** Manual, no-provider probe: npx tsx test/integration/status-probe.ts */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  makeClient, pendingPermissions, pendingQuestions, sessionAbort, sessionCreate,
  sessionDelete, sessionGet, sessionIdle, sessionMessages, sessionStatus,
} from "../../src/opencode/client.js";

const root = mkdtempSync(resolve("test/.fixtures/status-probe-"));
const project = resolve(root, "project");
mkdirSync(project);
const env = { ...process.env };
for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]) delete env[name];
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
  env[name] = resolve(root, name.toLowerCase());
  mkdirSync(env[name]!);
}
env.OPENCODE_DISABLE_AUTOUPDATE = "true";
env.OPENCODE_DISABLE_MODELS_FETCH = "true";
const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
  cwd: project, env, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });
let client: ReturnType<typeof makeClient> | undefined;
let sessionID: string | undefined;
try {
  const deadline = Date.now() + 45_000;
  let url: string | undefined;
  while (!url) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated server exited: ${output}`);
    if (Date.now() >= deadline) throw new Error(`isolated server startup timed out: ${output}`);
    url = output.match(/https?:\/\/127\.0\.0\.1:\d+(?=\s)/)?.[0];
    if (!url) await sleep(50);
  }
  client = makeClient(url, { timeoutMs: 5_000 });
  const session = await sessionCreate(client, "slackoc-no-provider-status-probe");
  sessionID = session.id;
  const fetched = await sessionGet(client, sessionID);
  assert.equal(fetched.id, sessionID);
  const initial = await sessionStatus(client);
  const messages = await sessionMessages(client, sessionID);
  const questions = await pendingQuestions(url);
  const permissions = await pendingPermissions(url);
  // Idle abort uses SessionRunState.cancel -> SessionStatus.set({type:"idle"}), no model invocation.
  await sessionAbort(client, sessionID);
  const afterIdle = await sessionStatus(client);
  const idle = await sessionIdle(client, sessionID);
  assert.equal(idle, true);
  assert.equal(Object.hasOwn(initial, sessionID), false);
  assert.equal(Object.hasOwn(afterIdle, sessionID), false);
  assert.deepEqual(messages, []);
  assert.deepEqual(questions, []);
  assert.deepEqual(permissions, []);
  const docResponse = await fetch(`${url}/doc`, { signal: AbortSignal.timeout(5_000) });
  const doc = await docResponse.json() as { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };
  console.log(JSON.stringify({
    server: url, sessionGetMatches: fetched.id === sessionID,
    statusBefore: initial, statusAfterExplicitIdle: afterIdle, sessionIdle: idle,
    messages, questions, permissions,
    statusRoute: doc.paths?.["/session/status"],
    messageSchema: doc.components?.schemas?.["AssistantMessage"],
    permissionSchema: doc.components?.schemas?.["PermissionRequest"],
  }, null, 2));
  await sessionDelete(client, sessionID);
  await assert.rejects(sessionIdle(client, sessionID));
  sessionID = undefined;
} finally {
  if (client && sessionID) await sessionDelete(client, sessionID).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  rmSync(root, { recursive: true, force: true });
}
