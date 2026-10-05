/** Real V2 service contracts, followed by two tiny model turns. No Slack credentials. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ServerPool } from "../../src/opencode/server.js";
import { pendingPermissions, pendingQuestions, permRespond, promptAsync, questionReply, sessionCreate, sessionDelete, sessionMessages } from "../../src/opencode/client.js";
import type { PoolEntry } from "../../src/opencode/server.js";

const dir = resolve("scratch/integration");
mkdirSync(dir, { recursive: true });
const events: Array<{ type: string; props: Record<string, unknown> }> = [];
const pool = new ServerPool((_dir, type, props) => { events.push({ type, props }); });
let entry: PoolEntry | undefined;
let sessionID: string | undefined;
const rawTypes = new Set<string>();
const observation = new AbortController();
async function waitFor(predicate: () => boolean, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for V2 event");
    await new Promise(r => setTimeout(r, 25));
  }
}
try {
  entry = await pool.ensure(dir);
  const c = entry.client!;
  sessionID = (await sessionCreate(c, "SlackOC V2 smoke (temporary)")).id;
  void (async () => {
    for await (const e of c.v2!.event.subscribe({ signal: observation.signal })) {
      if ((e.data as { sessionID?: string }).sessionID === sessionID) rawTypes.add(e.type);
    }
  })().catch(() => {});
  const form = await c.v2!.session.form.create({ sessionID, title: "SlackOC form contract", fields: [
    { key: "choice", type: "string", required: true, options: [{ label: "First option", value: "first" }] },
    { key: "notes", type: "string", required: true },
    { key: "features", type: "multiselect", options: [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }] },
  ] });
  await waitFor(() => events.some(e => e.type === "question.asked" && e.props.id === form.id), 10_000);
  const request = (await pendingQuestions(c)).find(q => q.id === form.id)!;
  assert(request);
  await questionReply(c, form.id, [["first"], ["free text"], ["a", "b"]], { request });
  assert.equal((await c.v2!.session.form.get({ sessionID, formID: form.id })).state.status, "answered");
  await waitFor(() => events.some(e => e.type === "question.replied" && e.props.id === form.id), 10_000);
  console.log("✓ V2 forms: event, pending list, values, multi-select, custom text, reply");

  // Create an explicit ask in this temporary session; no tool or shell command executes.
  await c.v2!.session.update({ sessionID, permissions: [{ action: "slackoc-smoke", resource: "*", effect: "ask" }] });
  const permission = await c.v2!.permission.create({ sessionID, action: "slackoc-smoke", resources: ["fixture"] });
  const pending = (await pendingPermissions(c)).find(p => p.id === permission.id)!;
  assert(pending);
  await permRespond(c, sessionID, pending.id, "reject");
  assert(!(await pendingPermissions(c)).some(p => p.id === pending.id));
  console.log("✓ V2 permissions: explicit ask, pending list, deny");

  if (!process.argv.includes("--no-model")) {
    const times: number[] = [];
    for (let turn = 0; turn < 2; turn++) {
      events.length = 0;
      const start = performance.now();
      const messageID = `msg_${(BigInt(Date.now()) * 0x1000n).toString(16)}${randomBytes(7).toString("hex")}`;
      await promptAsync(c, sessionID, "Reply with exactly the single word: ok", { messageID });
      times.push(Math.round(performance.now() - start));
      await waitFor(() => events.some(e => e.props.sessionID === sessionID && ["session.idle", "session.error"].includes(e.type)));
      assert(!events.some(e => e.type === "session.error"), "OpenCode reported a run error");
      assert(events.some(e => e.type === "message.part.updated" && /\bok\b/i.test(String((e.props.part as { text?: string })?.text))), "Missing streamed answer");
      const messages = await sessionMessages(c, sessionID);
      assert(messages.some(m => m.info.id === messageID && m.info.role === "user"), "Durable prompt correlation ID missing");
      assert(messages.some(m => m.info.role === "assistant" && m.parts.some(p => /\bok\b/i.test(p.text ?? ""))));
    }
    console.log(`✓ Two model turns complete; prompt admission: ${times.join("ms, ")}ms`);
  }
  console.log("✓ V2 SMOKE PASSED");
} catch (err) {
  console.error("Native event types:", [...rawTypes]);
  console.error("Bridge event types:", [...new Set(events.map(e => e.type))]);
  if (entry?.client && sessionID) {
    const rows = await sessionMessages(entry.client, sessionID).catch(() => []);
    console.error("Transcript evidence:", rows.map(r => ({ role: r.info.role, finish: r.info.finish, completed: r.info.time?.completed, error: r.info.error })));
  }
  console.error("✗ V2 SMOKE FAILED", err);
  process.exitCode = 1;
} finally {
  observation.abort();
  if (entry?.client && sessionID) await sessionDelete(entry.client, sessionID).catch(() => {});
  await pool.close();
}
