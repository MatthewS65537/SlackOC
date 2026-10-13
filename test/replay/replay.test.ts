import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { mdToMrkdwn } from "../../src/util.js";
import { unicodeEmoji } from "../../src/slack/emoji.js";
import { loadFixture, replay, type ReplayResult } from "./run.js";
import type { SlackOp } from "./fake-slack.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const fixture = (name: string) => `${FIXTURES}/${name}.jsonl`;
const NAMES = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length)).sort();

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const DIVIDER = /^⎯⎯⎯ response ⎯⎯⎯\n\n/;
/** The live-status line: render.ts posts it bare (no blocks) with previews off. The queued ack has blocks. */
const statusTs = (r: ReplayResult) => new Set(r.timeline
  .filter((op) => op.op === "post" && op.ts && !op.blocks && op.unfurl === false && /^[⏳⌛] /.test(op.text ?? ""))
  .map((op) => op.ts));
/** Answer text is the only thread post render.ts sends with link previews on. 429'd attempts are retried, so skip them. */
const responses = (r: ReplayResult) => r.timeline.filter((op) => op.op === "post" && op.channel === r.channel
  && op.thread === r.threadTs && op.unfurl !== false && op.fault !== "rate_limited");
const body = (op: SlackOp) => (op.text ?? "").replace(DIVIDER, "");
/** What Slack should show for these transcript texts (render.ts converts md, the adapter maps emoji). */
const slackText = (texts: string[]) => texts.map((t) => unicodeEmoji(mdToMrkdwn(t))).join("\n\n");
const paragraphs = (s: string) => s.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);

function expectInvariants(r: ReplayResult, opts: { dropped?: number } = {}): void {
  const ops = r.timeline;
  const answer = responses(r);
  const delivered = answer.filter((op) => !op.fault);
  expect(r.errors.filter((e) => e.startsWith("replay dispatch"))).toEqual([]);

  // Response text equals the transcript, in order. A dropped post is the only allowed loss.
  expect(answer.filter((op) => op.fault)).toHaveLength(opts.dropped ?? 0);
  expect(collapse(answer.map(body).join("\n\n"))).toBe(collapse(slackText(r.transcript)));

  // No paragraph shows up more often than the transcript has it.
  const budget = new Map<string, number>();
  for (const p of paragraphs(slackText(r.transcript))) budget.set(p, (budget.get(p) ?? 0) + 1);
  for (const p of delivered.flatMap((op) => paragraphs(body(op)))) {
    const left = (budget.get(p) ?? 0) - 1;
    expect(left, `paragraph posted twice: ${JSON.stringify(p)}`).toBeGreaterThanOrEqual(0);
    budget.set(p, left);
  }

  // Every status line posted was deleted by the end.
  const statuses = statusTs(r);
  expect(statuses.size).toBeGreaterThan(0);
  expect([...statuses].filter((ts) => !ops.some((op) => op.op === "delete" && op.ts === ts))).toEqual([]);

  // Each prompt: 👀 on arrival, then 👀 comes off and the outcome goes on.
  for (const ts of r.prompts) {
    expect(ops.filter((op) => op.ts === ts && (op.op === "react" || op.op === "unreact")).map((op) => `${op.op} ${op.name}`))
      .toEqual(["react eyes", "unreact eyes", `react ${r.outcome}`]);
  }

  // settle(): an interaction card lands after all the text the view had received before the ask.
  for (const card of r.cards) {
    const at = ops.findIndex((op) => op.op === "post" && op.ts === card.ts);
    const before = answer.filter((op) => ops.indexOf(op) < at);
    expect(collapse(before.map(body).join("\n\n"))).toBe(collapse(slackText(card.textBefore)));
  }
}

/** One line per Slack op, status-line traffic left out, ts replaced by U<n> (prompts) / M<n> (bot posts). */
function golden(r: ReplayResult): string {
  const statuses = statusTs(r);
  const refs = new Map(r.prompts.map((ts, i) => [ts, `U${i + 1}`]));
  let n = 0;
  const lines = r.timeline.filter((op) => !statuses.has(op.ts)).map((op) => {
    if (op.op === "post" && op.ts) refs.set(op.ts, `M${++n}`);
    const ref = refs.get(op.ts) ?? "-";
    switch (op.op) {
      case "react": case "unreact": return `${op.op} ${ref} :${op.name}:`;
      case "delete": return `delete ${ref}`;
      case "upload": return `upload ${op.name}: ${op.text ?? ""}`;
      default: return `${op.op}${op.fault ? `!${op.fault}` : ""} ${ref}${op.blocks ? " +blocks" : ""}: ${op.text ?? ""}`;
    }
  });
  return `${JSON.stringify(lines, null, 2)}\n`;
}

describe.each(NAMES)("replay %s", (name) => {
  it("keeps the thread invariants and matches its golden timeline", async () => {
    const r = await replay(fixture(name));
    if (process.env.REPLAY_DEBUG) console.log(name, JSON.stringify(r.timeline.map((o) => [o.at, o.op, o.ts, o.fault, o.name, o.text]), null, 1), r.errors);
    expectInvariants(r);
    await expect(golden(r)).toMatchFileSnapshot(`./fixtures/${name}.golden.json`);
  });
});

describe("fault injection", () => {
  const summary = (r: ReplayResult) => r.timeline.filter((op) => op.op === "post" && op.text?.startsWith("*project*")).at(-1)?.text ?? "";
  /** 1-based chat.postMessage call number of the nth answer post in a fault-free run (calls are deterministic up to the fault). */
  const nthAnswerCall = (r: ReplayResult, n: number) => r.timeline.filter((op) => op.op === "post").indexOf(responses(r)[n - 1]!) + 1;

  it("a resubscribe mid-paragraph posts every paragraph once and loses no text (#27)", async () => {
    const r = await replay(fixture("long-answer"), { faults: { resubscribe: { at: 10 } } }); // inside the code fence
    expectInvariants(r);
  });

  it("steps after a resubscribe keep their parent prompt, and the thread is unchanged (0.2c)", async () => {
    const at = loadFixture(fixture("steer-queued")).findIndex((e) => e.type === "session.step.started" && e.data.assistantMessageID === "msg_st_a2");
    const clean = await replay(fixture("steer-queued"));
    const r = await replay(fixture("steer-queued"), { faults: { resubscribe: { at } } });
    expectInvariants(r);
    const parents = r.delivered.flatMap((ev) => {
      const info = ev.properties?.info as { role?: string; id?: string; parentID?: string; finish?: string } | undefined;
      return ev.type === "message.updated" && info?.role === "assistant" && !info.finish ? [[info.id, info.parentID]] : [];
    });
    expect(parents).toEqual([["msg_st_a1", "msg_st_u1"], ["msg_st_a2", "msg_st_u2"], ["msg_st_a3", "msg_st_u3"]]);
    expect(golden(r)).toBe(golden(clean));
  });

  it("losing the final events to a reconnect still finalizes through the resume reconcile", async () => {
    const events = loadFixture(fixture("long-answer"));
    const at = events.findIndex((e) => e.type === "session.text.ended");
    const r = await replay(events, { faults: { resubscribe: { at, lost: events.length - at } } });
    expectInvariants(r); // the backstop posts the unfinished paragraph; ✅ and status cleanup still happen
  });

  // Found by this harness: step.started info was per subscription, so a step.ended after a
  // resubscribe carried no model and render.ts overwrote the known one (now shared in v2.ts).
  it("a resubscribe mid-step keeps the model in the run summary", async () => {
    const r = await replay(fixture("long-answer"), { faults: { resubscribe: { at: 10 } } });
    expect(summary(r)).toContain("`anthropic/claude-sonnet-4-5`");
  });

  it("a dropped answer post loses only that post; the run still completes (#29)", async () => {
    const dropNth = nthAnswerCall(await replay(fixture("long-answer")), 2);
    const r = await replay(fixture("long-answer"), { faults: { dropNth } });
    expectInvariants(r, { dropped: 1 });
    expect(r.timeline.find((op) => op.fault === "dropped")?.text).toBe("Here is the core loop:");
    expect(summary(r)).toContain("Verbose Tools");
  });

  it("a 429 on an answer post delays it without loss or duplication", async () => {
    const rateLimitNth = nthAnswerCall(await replay(fixture("long-answer")), 3);
    const r = await replay(fixture("long-answer"), { faults: { rateLimitNth } });
    expect(r.timeline.filter((op) => op.fault === "rate_limited")).toHaveLength(1);
    expectInvariants(r);
  });

  it("slow edits keep order and every lane card still lands on its final state", async () => {
    const r = await replay(fixture("subagents"), { faults: { latencyMs: { update: 2_500 } } });
    expectInvariants(r);
    const lanes = [...new Set(r.timeline.filter((op) => op.text?.startsWith("🤖 *")).map((op) => op.ts))];
    const last = (ts: string) => r.timeline.filter((op) => op.ts === ts && op.text).at(-1)!.text!;
    expect(lanes.map(last).map((t) => t.replace(/ · \d+s · /, " · ")))
      .toEqual(["🤖 *Audit docs* · 2 tools · done\n> Docs are current except the stream flag.",
        "🤖 *Audit CLI flags* · 2 tools · done\n> Two flags lack help text: dir and json."]);
  });
});
