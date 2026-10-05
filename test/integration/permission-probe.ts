/** Isolated real OpenCode permission probe, with a local deterministic model (no provider credentials). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { makeClient, pendingPermissions, permRespond, promptAsync, sessionCreate, sessionDelete, sessionMessages } from "../../src/opencode/client.js";

const root = mkdtempSync(resolve("test/.fixtures/permission-probe-"));
const model = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const afterTool = body.messages?.some((m: { role: string }) => m.role === "tool");
    const delta = afterTool ? { content: "Fixture complete." } : {
      tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "bash",
        arguments: JSON.stringify({ command: "pwd", description: "Read the isolated fixture directory" }) } }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (content: object) => res.write(`data: ${JSON.stringify(content)}\n\n`);
    send({ id: "chatcmpl_probe", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "probe",
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
    send({ id: "chatcmpl_probe", object: "chat.completion.chunk", model: "probe",
      choices: [{ index: 0, delta: {}, finish_reason: afterTool ? "stop" : "tool_calls" }] });
    res.end("data: [DONE]\n\n");
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const address = model.address() as { port: number };
const project = resolve(root, "project");
mkdirSync(project);
const env = { ...process.env };
for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]) delete env[name];
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
  env[name] = resolve(root, name.toLowerCase()); mkdirSync(env[name]!);
}
env.OPENCODE_DISABLE_AUTOUPDATE = "true";
env.OPENCODE_DISABLE_MODELS_FETCH = "true";
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "probe/probe", permission: { bash: "ask" }, provider: {
    probe: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" },
      models: { probe: { name: "probe" } } },
  },
});
const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", chunk => { output += String(chunk); });
child.stderr.on("data", chunk => { output += String(chunk); });
const sessionIDs: string[] = [];
let client: ReturnType<typeof makeClient> | undefined;
try {
  let url: string | undefined;
  const deadline = Date.now() + 45_000;
  while (!url) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`server startup failed: ${output}`);
    url = output.match(/https?:\/\/127\.0\.0\.1:\d+(?=\s)/)?.[0];
    if (!url) await sleep(50);
  }
  client = makeClient(url, { timeoutMs: 5_000 });
  const doc = await (await fetch(`${url}/doc`, { signal: AbortSignal.timeout(5_000) })).json() as { paths: Record<string, unknown> };
  console.log("Real server permission routes:", Object.keys(doc.paths).filter(p => p.includes("permission")));
  for (const choice of ["once", "reject"] as const) {
    const session = await sessionCreate(client, `SlackOC permission ${choice} fixture`);
    sessionIDs.push(session.id);
    await promptAsync(client, session.id, "Use bash to run pwd in this isolated fixture.");
    let ask: Awaited<ReturnType<typeof pendingPermissions>>[number] | undefined;
    const until = Date.now() + 45_000;
    while (!ask && Date.now() < until) {
      ask = (await pendingPermissions(url)).find(p => p.sessionID === session.id);
      if (!ask) await sleep(100);
    }
    if (!ask) throw new Error(`No permission ask: ${JSON.stringify(await sessionMessages(client, session.id))}\n${output}`);
    assert.equal(ask.type, "bash");
    await permRespond(client, session.id, ask.id, choice);
    assert.equal((await pendingPermissions(url)).some(p => p.id === ask!.id), false);
    let tool: { state?: { status: string; output?: string; error?: string } } | undefined;
    const doneBy = Date.now() + 10_000;
    while (Date.now() < doneBy) {
      const messages = await sessionMessages(client, session.id);
      tool = messages.flatMap(m => m.parts).find(p => p.type === "tool" && p.tool === "bash") as typeof tool;
      if (["completed", "error"].includes(tool?.state?.status ?? "")) break;
      await sleep(100);
    }
    assert.equal(tool?.state?.status, choice === "once" ? "completed" : "error");
    if (choice === "once") assert.ok(tool?.state?.output?.includes(project));
    console.log(JSON.stringify({ choice, pendingCleared: true, toolStatus: tool!.state!.status }));
  }
} finally {
  if (client) for (const id of sessionIDs) await sessionDelete(client, id).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  model.closeAllConnections();
  await new Promise<void>(resolve => model.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
