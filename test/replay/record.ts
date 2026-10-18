/**
 * Dev-only fixture recorder for the replay tests. Not part of the suite; it
 * reads the live local OpenCode service (read-only, never starts one):
 *
 *   npx tsx test/replay/record.ts <name> <sessionID> [childSessionID...]
 *
 * Writes test/replay/fixtures/<name>.jsonl from session.log({ sessionID, after: 0 }),
 * one raw event per line. Subagent child sessions have their own logs; list
 * them after the parent and they are merged in by `created` time. Every
 * free-text string is scrubbed to placeholder words of the same length
 * (deterministic, so repeated words stay repeated); ids and enum fields are kept.
 *
 * What session.log returns, judging from the SDK types: only DURABLE events
 * (SessionLogItem = SessionEventDurable | EventLogSynced). There are no
 * session.text/reasoning deltas, tool progress, session.status/idle,
 * permission.* or form.* events in it. So run.ts synthesizes text/reasoning
 * deltas from each *.ended text, and a run that asked for a permission or a
 * question needs those events added by hand (shapes: permission.jsonl, question.jsonl).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

/** Ids and enums the replay depends on. Every other string value is scrubbed. */
const KEEP = new Set(["id", "type", "sessionID", "parentID", "assistantMessageID", "messageID", "inboxID", "requestID",
  "callID", "aggregateID", "projectID", "workspaceID", "providerID", "variant", "name", "agent", "action", "key",
  "finish", "rawFinish", "status", "reply", "delivery", "reason", "mime", "version"]);

const placeholders = new Map<string, string>();

/** Same-length stand-in for one word: letters stay letters (first-letter case kept), digits stay digits. */
function placeholder(word: string): string {
  let out = placeholders.get(word);
  if (out !== undefined) return out;
  let h = 2166136261;
  for (const c of word) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  out = [...word].map((c, i) => {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    if (/\p{N}/u.test(c)) return String(h % 10);
    const letter = "abcdefghijklmnopqrstuvwxyz"[h % 26]!;
    return i === 0 && c !== c.toLowerCase() ? letter.toUpperCase() : letter;
  }).join("");
  placeholders.set(word, out);
  return out;
}

function scrub(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key && KEEP.has(key) ? value : value.replace(/[\p{L}\p{N}]+/gu, placeholder);
  if (Array.isArray(value)) return value.map((v) => scrub(v, key)); // e.g. resources: string[]
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  return value;
}

const [name, ...sessions] = process.argv.slice(2);
if (!name || !/^[\w-]+$/.test(name) || !sessions.length) {
  console.error("usage: npx tsx test/replay/record.ts <name> <sessionID> [childSessionID...]");
  process.exit(2);
}
const endpoint = await Service.discover({ version: () => true });
if (!endpoint) {
  console.error("No running OpenCode service found.");
  process.exit(1);
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const events: Array<{ created: number }> = [];
for (const sessionID of sessions) {
  for await (const item of client.session.log({ sessionID, after: 0 })) {
    if (item.type === "log.synced") break; // end of history; a follow stream would go live after it
    events.push(item);
  }
}
events.sort((a, b) => a.created - b.created); // stable: each session's own order survives ties
const out = resolve(import.meta.dirname, "fixtures", `${name}.jsonl`);
writeFileSync(out, events.map((e) => JSON.stringify(scrub(e))).join("\n") + "\n");
console.log(`${events.length} events -> ${out}\nNext: add any permission/form events by hand, run`
  + " `npx vitest run test/replay/replay.test.ts` to write its golden, and review that file.");
