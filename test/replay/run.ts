/**
 * Transcript replay runner. Pushes a raw OpenCode V2 event log through the real
 * V2Events translator and the real SessionView into the fake Slack, on vitest
 * fake timers aligned to each event's `created` time, and returns the ordered
 * Slack timeline.
 *
 * It stands in for the pieces between the two (all simplified, see README):
 *  - the pool + start.ts onPoolEvent: one V2Events per subscription, child
 *    sessions (session.created with a parentID) routed to handleChild;
 *  - the router: each user inbox item becomes a Slack prompt (👀, receipt,
 *    beginPrompt), a "steer" delivery change plays the Steer button;
 *  - interactions.ts: permission/question asks settle() the view, post a card
 *    and mark it waiting; replies clear the wait and edit the card;
 *  - the OpenCode service: messages()/status() answer from the durable events
 *    applied so far, including events the bridge never received.
 */
import { vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { V2Event } from "@opencode/client";
import type { OCClient, OcEvent } from "../../src/opencode/api.js";
import { V2Events, normalizeMessages } from "../../src/opencode/v2.js";
import {
  SessionView, deleteView, getView, hasActiveViewForProject, reconcileStaleViews, setProjectConnectionState,
} from "../../src/slack/render.js";
import { _resetQueueForTests, laneDepth } from "../../src/slack/queue.js";
import { timestampFromMs } from "../../src/slack/recovery-policy.js";
import { StateStore } from "../../src/state.js";
import * as logModule from "../../src/log.js";
import { createFakeSlack, type FakeSlackKnobs, type SlackOp } from "./fake-slack.js";

export interface ReplayFaults extends FakeSlackKnobs {
  /**
   * The event stream drops before event `at` (index into the replayed stream,
   * see loadFixture). The next `lost` events still happen server-side but never
   * arrive. Then a fresh V2Events resumes, as client.ts creates one per
   * subscription, and the pool's resume reconcile runs.
   */
  resubscribe?: { at: number; lost?: number };
}

export interface ReplayResult {
  timeline: SlackOp[];
  channel: string;
  threadTs: string;
  /** Prompt (user message) ts in order, and the reaction each should end with. */
  prompts: string[];
  outcome: "white_check_mark" | "x";
  /** Final text of every parent-session assistant text part, in transcript order. */
  transcript: string[];
  /** Interaction cards, with the parent text the view had received when the ask arrived. */
  cards: Array<{ id: string; ts: string; textBefore: string[] }>;
  /** Translated events the bridge received, in order (what V2Events emitted). */
  delivered: OcEvent[];
  /** logErr lines (muted during the replay). */
  errors: string[];
}

/** A raw V2 event as fixtures store it (server.connected aside, every event has `created`). */
type Raw = V2Event & { created: number; data: Record<string, any> };
const CHANNEL = "C-replay";
const CHILD_EVENTS = new Set(["message.part.updated", "session.status", "session.idle", "session.error"]);

/**
 * Parse a JSONL fixture. session.log only has durable events, so a text or
 * reasoning part without deltas gets synthetic ones (~60-char pieces spread
 * between its started and ended times) to exercise paragraph streaming.
 */
export function loadFixture(path: string): Raw[] {
  const events = readFileSync(path, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Raw).filter((e) => (e.type as string) !== "log.synced");
  const key = (e: Raw, kind: string) => `${kind}:${e.data.assistantMessageID}:${e.data.ordinal}`;
  const streamed = new Set(events.filter((e) => e.type.endsWith(".delta")).map((e) => key(e, e.type.split(".")[1]!)));
  const started = new Map<string, number>();
  const out: Raw[] = [];
  for (const e of events) {
    const m = /^session\.(text|reasoning)\.(started|ended)$/.exec(e.type);
    if (m?.[2] === "started") started.set(key(e, m[1]!), e.created);
    if (m?.[2] === "ended" && !streamed.has(key(e, m[1]!))) {
      const pieces = split(String(e.data.text ?? ""));
      const from = Math.max(started.get(key(e, m[1]!)) ?? e.created, out.at(-1)?.created ?? 0);
      pieces.forEach((delta, i) => out.push({ id: `${e.id}~${i}`, created: Math.round(from + ((e.created - from) * (i + 1)) / (pieces.length + 1)),
        type: `session.${m[1]}.delta`, location: e.location,
        data: { sessionID: e.data.sessionID, assistantMessageID: e.data.assistantMessageID, ordinal: e.data.ordinal, delta } } as Raw));
    }
    out.push(e);
  }
  return out;
}

function split(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length;) {
    let j = Math.min(text.length, i + 60);
    while (j < text.length && !/\s/.test(text[j]!)) j++;
    pieces.push(text.slice(i, j));
    i = j;
  }
  return pieces;
}

/** The service's side: transcript and busy state from the durable events applied so far. */
class Server {
  private sessions = new Map<string, any[]>();
  private inbox = new Map<string, Map<string, { id: string; text: string; created: number }>>();
  private blocks = new Map<string, any>();
  private busy = new Set<string>();

  private list(sid: string): any[] {
    let l = this.sessions.get(sid);
    if (!l) this.sessions.set(sid, l = []);
    return l;
  }
  private queue(sid: string) {
    let q = this.inbox.get(sid);
    if (!q) this.inbox.set(sid, q = new Map());
    return q;
  }

  apply(e: Raw): void {
    const d = e.data;
    const msg = () => this.list(d.sessionID).find((m) => m.id === d.assistantMessageID);
    const tool = () => msg()?.content.find((c: any) => c.type === "tool" && c.id === d.id);
    switch (e.type) {
      case "session.inbox.enqueued":
        if (d.item.type === "user") this.queue(d.sessionID).set(d.inboxID, { id: d.inboxID, text: d.item.payload.text, created: e.created });
        break;
      case "session.inbox.delivered": {
        const item = this.queue(d.sessionID).get(d.inboxID);
        this.queue(d.sessionID).delete(d.inboxID);
        if (item) this.list(d.sessionID).push({ id: d.inboxID, type: "user", text: item.text, time: { created: e.created } });
        break;
      }
      case "session.inbox.cancelled": this.queue(d.sessionID).delete(d.inboxID); break;
      case "session.execution.started": this.busy.add(d.sessionID); break;
      case "session.execution.succeeded": case "session.execution.failed": case "session.execution.interrupted":
        this.busy.delete(d.sessionID); break;
      case "session.step.started":
        this.list(d.sessionID).push({ id: d.assistantMessageID, type: "assistant", agent: d.agent, model: d.model,
          time: { created: d.started }, content: [] });
        break;
      case "session.step.ended": case "session.step.failed": {
        const m = msg();
        if (!m) break;
        Object.assign(m, { finish: d.finish ?? "error", cost: d.cost, tokens: d.tokens, ...(d.error ? { error: d.error } : {}) });
        m.time.completed = e.created;
        break;
      }
      case "session.text.started": case "session.reasoning.started": {
        const block = { type: e.type.split(".")[1], text: "" };
        msg()?.content.push(block);
        this.blocks.set(`${e.type.split(".")[1]}:${d.assistantMessageID}:${d.ordinal}`, block);
        break;
      }
      case "session.text.ended": case "session.reasoning.ended": {
        const block = this.blocks.get(`${e.type.split(".")[1]}:${d.assistantMessageID}:${d.ordinal}`);
        if (block) block.text = d.text;
        break;
      }
      case "session.tool.input.started":
        msg()?.content.push({ type: "tool", id: d.id, name: d.name, state: { status: "streaming", input: "" }, time: { created: e.created } });
        break;
      case "session.tool.called": {
        const t = tool();
        if (t) { t.state = { status: "running", input: d.input, metadata: {} }; t.time.ran = e.created; }
        break;
      }
      case "session.tool.success": case "session.tool.failed": {
        const t = tool();
        if (!t) break;
        t.state = e.type === "session.tool.success"
          ? { status: "completed", input: t.state.input, content: d.content, metadata: d.metadata }
          : { status: "error", input: t.state.input, error: d.error, content: d.content, metadata: d.metadata };
        t.time.completed = e.created;
        break;
      }
    }
  }

  /** Same shape as client.ts session.messages: normalized rows, then still-queued inbox items. */
  messages(sid: string) {
    const rows = normalizeMessages(structuredClone(this.list(sid)), sid);
    for (const item of this.queue(sid).values()) {
      rows.push({ info: { id: item.id, sessionID: sid, role: "user", time: { created: item.created } }, parts: [] });
    }
    return rows;
  }

  status(): Record<string, { type: "busy" }> {
    return Object.fromEntries([...this.busy].map((id) => [id, { type: "busy" as const }]));
  }

  texts(sid: string): string[] {
    return this.messages(sid).filter((m) => m.info.role === "assistant")
      .flatMap((m) => m.parts.filter((p) => p.type === "text" && p.text?.trim()).map((p) => p.text!));
  }
}

let runs = 0;

export async function replay(fixture: string | Raw[], opts: { faults?: ReplayFaults } = {}): Promise<ReplayResult> {
  const events = typeof fixture === "string" ? loadFixture(fixture) : fixture;
  const faults = opts.faults ?? {};
  const first = events.find((e) => e.type === "session.inbox.enqueued");
  if (!first) throw new Error("fixture has no session.inbox.enqueued (no prompt to replay)");
  const sessionId: string = first.data.sessionID;
  const projectDir = events.find((e) => e.location?.directory)?.location?.directory ?? "/replay/project";
  const threadTs = timestampFromMs(first.created);
  const threadKey = `${CHANNEL}:${threadTs}`;
  // Subagent lanes: start.ts finds a child's nearest ancestor with a view via session.get.
  const children = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "session.created" || !e.data.parentID) continue;
    if (e.data.parentID === sessionId || children.has(e.data.parentID)) children.set(e.data.sessionID, e.data.title ?? "subagent");
  }
  const outcome = events.some((e) => e.data.sessionID === sessionId && /^session\.execution\.(failed|interrupted)$/.test(e.type))
    ? "x" as const : "white_check_mark" as const;

  vi.useFakeTimers();
  vi.setSystemTime(events[0]!.created - 1_000);
  _resetQueueForTests();
  const errors: string[] = [];
  const logSpy = vi.spyOn(logModule, "logErr").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const stateDir = resolve(import.meta.dirname, "../.fixtures/replay", `run-${process.pid}-${++runs}`);
  rmSync(stateDir, { recursive: true, force: true });

  const server = new Server();
  const slack = createFakeSlack(faults);
  const { deps } = slack;
  const client = { session: {
    get: async ({ path }: { path: { id: string } }) => ({ id: path.id, title: "replay", directory: projectDir }),
    messages: async ({ path }: { path: { id: string } }) => server.messages(path.id),
    status: async () => server.status(),
    diff: async () => [],
  } } as unknown as OCClient;
  const state = new StateStore(`${stateDir}/state.json`);
  const threadState = { sessionId, projectDir, verbose: "on" as const, createdAt: Date.now(), lastUsedAt: Date.now() };
  state.setThread(threadKey, threadState);
  setProjectConnectionState(projectDir, "connected");

  const prompts: string[] = [];
  const promptByInbox = new Map<string, string>();
  const cards: ReplayResult["cards"] = [];
  const cardTs = new Map<string, string>();
  const received = new Map<string, string>(); // parent text part id → latest text the view got
  const delivered: OcEvent[] = [];
  const fail = (err: unknown) => errors.push(`replay dispatch: ${String((err as Error)?.stack ?? err)}`);

  async function prompt(e: Raw): Promise<void> {
    const ts = timestampFromMs(e.created);
    slack.addUserMessage(CHANNEL, ts, threadTs);
    prompts.push(ts);
    promptByInbox.set(e.data.inboxID, ts);
    state.claimMessage(threadKey, ts);
    state.associatePrompt(threadKey, ts, { projectDir, sessionId, messageId: e.data.inboxID });
    state.settleMessage(threadKey, ts, "accepted");
    void deps.react(CHANNEL, ts, "eyes").catch(fail); // the router's liveness ack
    // Like the router: a finalized view leaves the registry, so a later prompt gets a fresh one.
    const view = getView(sessionId) ?? new SessionView({ sessionId, projectDir, channel: CHANNEL, threadTs, threadKey, client, deps, state, threadState });
    await view.beginPrompt(ts);
  }

  function steer(e: Raw): void {
    const ts = promptByInbox.get(e.data.inboxID);
    if (!ts) return;
    getView(sessionId)?.noteQueuedAction(ts, true);
    const card = [...slack.messages.values()].find((m) => (m.blocks as Array<{ elements?: Array<{ value?: string }> }> | undefined)
      ?.some((b) => b.elements?.some((el) => el.value?.includes(`"u":"${ts}"`))));
    if (card) void deps.update(CHANNEL, card.ts, "➡️ Steered into the current run.", threadTs).catch(fail);
  }

  async function ask(kind: "permission" | "question", id: string, text: string): Promise<void> {
    const textBefore = [...received.values()];
    await getView(sessionId)?.settle();
    getView(sessionId)?.setWaiting(id, kind, true);
    const blocks = [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", elements: [] }];
    const { ts } = await deps.post(CHANNEL, threadTs, text, blocks, { unfurl: false, lane: "interactive" });
    cardTs.set(id, ts);
    cards.push({ id, ts, textBefore });
    getView(sessionId)?.contentPosted();
  }

  async function answered(kind: "permission" | "question", id: string, text: string): Promise<void> {
    getView(sessionId)?.setWaiting(id, kind, false);
    const ts = cardTs.get(id);
    if (ts) await deps.update(CHANNEL, ts, text, threadTs);
  }

  async function route(ev: OcEvent): Promise<void> {
    const p = (ev.properties ?? {}) as Record<string, any>;
    const sid: string | undefined = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
    switch (ev.type) {
      case "permission.asked": if (sid === sessionId) await ask("permission", p.id, `🔐 *Permission needed* — ${p.title}`); return;
      case "permission.replied":
        await answered("permission", p.requestID, p.reply === "reject" ? "🚫 Denied." : p.reply === "always" ? "✅ Always allowed." : "✅ Allowed once.");
        return;
      case "question.asked": if (sid === sessionId) await ask("question", p.id, `❓ *OpenCode has a question* — ${p.questions.length} to answer`); return;
      case "question.replied": case "question.rejected":
        await answered("question", p.id ?? p.requestID, ev.type === "question.replied" ? "✅ Answer confirmed." : "▶️ Skip confirmed.");
        return;
    }
    if (sid === sessionId) {
      if (ev.type === "message.part.updated" && p.part?.type === "text") received.set(p.part.id, p.part.text ?? "");
      await getView(sessionId)?.handle(ev);
    } else if (sid && children.has(sid) && CHILD_EVENTS.has(ev.type)) await getView(sessionId)?.handleChild(sid, children.get(sid)!, ev);
  }

  let adapter = new V2Events();
  const reconnect = () => {
    adapter = new V2Events();
    setProjectConnectionState(projectDir, "connected");
    void reconcileStaleViews(0, projectDir).catch(fail);
  };
  const gap = faults.resubscribe ? { from: faults.resubscribe.at, to: faults.resubscribe.at + (faults.resubscribe.lost ?? 0) } : undefined;

  try {
    for (const [i, e] of events.entries()) {
      await vi.advanceTimersByTimeAsync(Math.max(0, e.created - Date.now()));
      if (gap && i === gap.from) setProjectConnectionState(projectDir, "reconnecting");
      if (gap && i === gap.to) reconnect();
      server.apply(e);
      if (gap && i >= gap.from && i < gap.to) continue; // happened while the stream was down
      if (e.data.sessionID === sessionId && e.type === "session.inbox.enqueued" && e.data.item?.type === "user") await prompt(e);
      if (e.data.sessionID === sessionId && e.type === "session.inbox.delivery.changed" && e.data.delivery === "steer") steer(e);
      // Like the pool: translate synchronously, dispatch without awaiting Slack.
      for (const ev of adapter.translate(e)) {
        delivered.push(ev);
        void route(ev).catch(fail);
      }
    }
    if (gap && gap.to >= events.length) {
      await vi.advanceTimersByTimeAsync(1_000);
      reconnect();
    }
    // Drain: until the view has finalized and left the registry, and the lane is empty.
    for (let s = 0; s < 300 && (hasActiveViewForProject(projectDir) || laneDepth(CHANNEL) > 0); s++) await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000); // stragglers: orphaned sink deletes, late reactions
    return { timeline: [...slack.timeline], channel: CHANNEL, threadTs, prompts, outcome, transcript: server.texts(sessionId), cards, delivered, errors };
  } finally {
    deleteView(sessionId);
    logSpy.mockRestore();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
