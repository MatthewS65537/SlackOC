import type { App, RespondFn } from "@slack/bolt";
import type { SlackocConfig } from "../config.js";
import type { StateStore } from "../state.js";
import type { ServerPool, PoolEntry } from "../opencode/server.js";
import { permRespond, pendingQuestions, pendingPermissions, questionReply, questionReject } from "../opencode/client.js";
import { appendSectionSuffix, PERMISSION_ACTIONS, QUESTION_ACTION_PATTERN, questionBlocks } from "./blocks.js";
import { PermissionDeliveryStore, PermissionResponder, parsePermissionButton, type PermissionRecord } from "./permissions.js";
import { PermissionDeliveryManager } from "./permission-delivery.js";
import { QuestionsStore, questionBindingToken, sameQuestionBinding, type QuestionSnapshot } from "./questions-store.js";
import { QuestionUiReconciler, questionPresentationMarker } from "./question-ui.js";
import { unicodeEmoji } from "./emoji.js";
import { formAnswer, visibleQuestions } from "../opencode/v2.js";
import { compareTs, isRecentRecoveryEligibleThread, replayAge } from "./recovery-policy.js";
import type { BridgeDeps } from "./router.js";
import { getView, type RenderDeps } from "./render.js";
import { enqueue } from "./queue.js";
import { isRateLimited } from "./transport.js";
import { logErr, pushLog } from "../log.js";
import type { OcPermission, OcQuestionRequest } from "../opencode/api.js";
import type { ScheduledReports } from "../schedules/slack.js";

/**
 * OpenCode permission and question asks: durable thread + owner-DM cards,
 * button/modal handlers, nudges, and periodic reconciliation against the
 * server. Owns all interaction state; startBridge wires events into it.
 */
export interface InteractionDeps {
  app: App;
  config: SlackocConfig;
  state: StateStore;
  pool: ServerPool;
  render: RenderDeps;
  permissionStore: PermissionDeliveryStore;
  questionStore: QuestionsStore;
  isStopping: () => boolean;
  /** False until boot recovery finishes; asks seen earlier are left for the first sweep. */
  enabled: () => boolean;
  dmChannel: () => string | null;
  setDmChannel: (id: string | null) => void;
  botUserId: () => string;
  scheduledReports: () => ScheduledReports | undefined;
  viewThread: (channel: string, threadTs: string) => string;
}

export function createInteractions(deps: InteractionDeps) {
  const { app, config, state, pool, render, permissionStore, questionStore, isStopping, viewThread, setDmChannel } = deps;
  const dmChannelId = deps.dmChannel;
  const botUserId = deps.botUserId;
  const scheduledReports = deps.scheduledReports;
  const interactionsEnabled = deps.enabled;
  // Resolved IDs are tombstones for this bridge lifetime, not delivery dedup.
  // Keep them even after removing the live ask so old polls/replays cannot revive it.
  const resolvedPerms = new Set<string>();
  const resolvedQuestions = new Set<string>();
  const permNudges = new Map<string, NodeJS.Timeout>();
  const quesNudges = new Map<string, NodeJS.Timeout>();
  const interactionVersions = new Map<string, number>();
  const interactionSweeps = new Map<string, { flight: Promise<void>; requested: boolean }>();
  const interactionChanged = (dir: string): void => {
    interactionVersions.set(dir, (interactionVersions.get(dir) ?? 0) + 1);
  };

  type Delivery = { status: "new" | "in-flight" | "delivered" | "rejected" | "uncertain"; attempts: number };
  type InteractionAsk = {
    id: string;
    sessionId: string;
    projectDir: string;
    channel: string;
    threadTs: string;
    askTs: string | null;
    dmTs: string | null;
    threadDelivery: Delivery;
    dmDelivery: Delivery;
    deliveryFlight?: Promise<void>;
    resolvedText?: string;
    nudgeStarted: boolean;
  };
  type PermissionAsk = InteractionAsk & { perm: OcPermission; record: PermissionRecord };
  const permAsks = new Map<string, PermissionAsk>();
  const close = (): void => {
    for (const t of permNudges.values()) clearTimeout(t);
    for (const t of quesNudges.values()) clearTimeout(t);
  };

  /**
   * Live question asks. `req` is the full stored ask (options resolved from
   * here, not from the button value); `answers` accumulates one label-array
   * per question; `finalized` marks which questions are locked in (a
   * multi-select's toggles don't count until submitted). `cursor` is the
   * question the owner navigated to with Back/Next (undefined = the first
   * unfinished one; see shownQuestion). When every visible question is
   * finalized, single-question asks reply at once; longer forms show a review
   * step and reply on "Submit answers".
   */
  type QuestionAsk = InteractionAsk & {
    req: OcQuestionRequest;
    answers: string[][];
    finalized: boolean[];
    generation: number;
    response: "pending" | "answering" | "uncertain" | "resolved";
    page?: number;
    cursor?: number;
    ui: NonNullable<QuestionSnapshot["ui"]>;
    draftRevision: number;
    resumeOwnerTs?: string;
    presentation: number;
  };
  const quesAsks = new Map<string, QuestionAsk>();
  const questionLocks = new Set<string>();
  function saveQuestion(ask: QuestionAsk, replace = false): void {
    const current = quesAsks.get(ask.id);
    const saved = questionStore.get(ask.id);
    const samePlacement = !!saved && sameQuestionBinding(saved, ask);
    if ((current && current !== ask) || (!replace && saved && !sameQuestionBinding(saved, ask))) {
      questionStore.update(ask.id, record => {
        const copies = [...record.retiredCopies ?? []];
        if (ask.askTs && (ask.askTs !== record.askTs || ask.channel !== record.channel)) copies.push({ channel: ask.channel, ts: ask.askTs });
        if (ask.dmTs && ask.dmTs !== record.dmTs && dmChannelId()) copies.push({ channel: dmChannelId()!, ts: ask.dmTs });
        const retired = copies.filter((c, i) => copies.findIndex(o => o.channel === c.channel && o.ts === c.ts) === i);
        if (retired.length > 32) throw new Error("Question cleanup capacity reached; unresolved copies retained");
        record.retiredCopies = retired;
      });
      return;
    }
    if (!replace && saved && sameQuestionBinding(saved, ask)) {
      // The UI writer owns copy identities. A delayed answer/save must never
      // restore the old timestamps after a successful placement handoff.
      ask.askTs = saved.askTs ?? ask.askTs;
      ask.dmTs = saved.dmTs ?? ask.dmTs;
      ask.presentation = Math.max(ask.presentation, saved.presentation ?? 0);
      ask.ui.threadApplied = Math.max(ask.ui.threadApplied, saved.ui?.threadApplied ?? 0);
      ask.ui.dmApplied = Math.max(ask.ui.dmApplied, saved.ui?.dmApplied ?? 0);
    }
    questionStore.put({ id: ask.id, sessionId: ask.sessionId, projectDir: ask.projectDir, generation: ask.generation,
      channel: ask.channel, threadTs: ask.threadTs, req: ask.req, answers: ask.answers, finalized: ask.finalized,
      askTs: ask.askTs, dmTs: ask.dmTs, response: ask.response, updatedAt: Date.now(),
      threadDelivery: ask.threadDelivery, dmDelivery: ask.dmDelivery, ui: ask.ui, page: ask.page, cursor: ask.cursor,
      draftRevision: ask.draftRevision, resumeOwnerTs: ask.resumeOwnerTs, resolvedText: ask.resolvedText,
      retiredCopies: saved?.retiredCopies, presentation: ask.presentation,
      threadPresentation: samePlacement ? saved.threadPresentation ?? 0 : ask.presentation,
      dmPresentation: samePlacement ? saved.dmPresentation ?? 0 : ask.presentation,
      relocation: samePlacement ? saved.relocation : undefined });
  }
  function activeQuestion(ask: Pick<QuestionSnapshot, "req" | "answers" | "finalized">): number {
    const visible = visibleQuestions(ask.req, ask.answers);
    return ask.req.questions.findIndex((_, i) => visible[i] && !ask.finalized[i]);
  }
  /** The question on screen: the Back/Next cursor when it is still visible, else the first unfinished one (-1 = review step). */
  function shownQuestion(ask: Pick<QuestionSnapshot, "req" | "answers" | "finalized" | "cursor">): number {
    const c = ask.cursor;
    return c !== undefined && visibleQuestions(ask.req, ask.answers)[c] ? c : activeQuestion(ask);
  }
  /** Single-question asks submit on the answering tap; longer forms wait for the review step's "Submit answers". */
  const oneTap = (ask: QuestionAsk): boolean => visibleQuestions(ask.req, ask.answers).filter(Boolean).length === 1;
  /** Persist a draft/UI change. Moving to another question posts a fresh bottom card (presentation++) unless `inPlace` (Back/Next). */
  function changedQuestion(ask: QuestionAsk, draft = true, inPlace = false): void {
    const previous = questionStore.get(ask.id);
    try {
      if (!inPlace && previous && sameQuestionBinding(previous, ask) && ask.response === "pending" &&
        shownQuestion(ask) >= 0 && shownQuestion(previous) !== shownQuestion(ask)) ask.presentation++;
      ask.ui.revision++;
      if (draft) ask.draftRevision++;
      saveQuestion(ask);
    } catch (err) {
      if (previous?.generation === ask.generation) Object.assign(ask, {
        answers: previous.answers, finalized: previous.finalized, response: previous.response, page: previous.page, cursor: previous.cursor,
        draftRevision: previous.draftRevision ?? 0, ui: previous.ui ?? { revision: 1, threadApplied: 0, dmApplied: 0 },
        resolvedText: previous.resolvedText,
        presentation: previous.presentation ?? 0,
      });
      throw err;
    }
  }
  const questionCard = (ask: Pick<QuestionAsk, "req" | "answers" | "finalized" | "page" | "cursor" | "generation" | "response" | "id" | "sessionId" | "projectDir" | "channel" | "threadTs"> & { presentation?: number }) => {
    const visible = visibleQuestions(ask.req, ask.answers);
    return questionBlocks(ask.req, ask.answers, ask.finalized.map((done, i) => done || !visible[i]), ask.page,
      { generation: ask.generation, binding: questionBindingToken(ask), presentation: ask.presentation ?? 0, response: ask.response,
        shown: shownQuestion(ask) });
  };
  /** Thread of a known question-card copy, for queue ordering; undefined (a queue barrier) when unknown. */
  const questionCopyThread = (channel: string, ts: string): string | undefined => {
    if (channel === dmChannelId()) return "";
    return questionStore.list().find(r => r.channel === channel && (r.askTs === ts ||
      r.relocation?.thread?.oldTs === ts || r.relocation?.thread?.postedTs === ts ||
      r.retiredCopies?.some(c => c.channel === channel && c.ts === ts)))?.threadTs;
  };
  const questionUi = new QuestionUiReconciler({ store: questionStore, dmChannel: () => dmChannelId(),
    stopping: () => isStopping(), onError: logErr,
    eligible: snapshot => snapshot.response === "resolved" ||
      (quesAsks.get(snapshot.id)?.generation === snapshot.generation && isPending(quesAsks.get(snapshot.id)!, "question")),
    render: (snapshot, destination) => {
      const text = snapshot.resolvedText ?? "OpenCode question";
      const blocks = snapshot.response === "resolved"
        ? [{ type: "section", text: { type: "mrkdwn", text: unicodeEmoji(text) } }]
        : questionCard(snapshot);
      const link = destination === "dm" ? viewThread(snapshot.channel, snapshot.threadTs) : "";
      return { text: `${unicodeEmoji(text)}\n${questionPresentationMarker(snapshot, destination)}`,
        blocks: link ? appendSectionSuffix(blocks, link) : blocks };
    },
    send: async (channel, ts, build) => {
      await enqueue(async () => {
        const card = build();
        if (card) await app.client.chat.update({ channel, ts, text: card.text, blocks: card.blocks as never });
      }, { channel, method: "chat.update", lane: "interactive", thread: questionCopyThread(channel, ts) });
    },
    remove: async (channel, ts, allowed) => {
      await enqueue(async () => {
        if (!allowed()) return;
        try { await app.client.chat.delete({ channel, ts }); }
        catch (err) {
          const e = err as { code?: string; data?: { error?: string } };
          if (e?.code !== "slack_webapi_platform_error" || e.data?.error !== "message_not_found") throw err;
        }
      }, { channel, method: "chat.delete", lane: "interactive", thread: questionCopyThread(channel, ts) });
    },
    post: (channel, threadTs, build) => enqueue(async () => {
      const card = build();
      if (!card) return;
      const result = await app.client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}),
        text: card.text, blocks: card.blocks as never, unfurl_links: false, unfurl_media: false });
      if (!result.ts) throw new Error("Slack did not confirm the question card timestamp");
      return { ts: result.ts };
    }, { channel, lane: "interactive", thread: threadTs ?? "" }),
    find: async (channel, threadTs, marker, oldest) => {
      if (isStopping()) return;
      const { ts } = await findBotMarker(channel, threadTs, hasLine([marker]), { oldest, lane: "interactive" });
      return ts ? { ts } : undefined;
    },
    rejectedPost,
    onAdopt: record => {
      const ask = quesAsks.get(record.id);
      if (!ask || !sameQuestionBinding(record, ask)) return;
      ask.askTs = record.askTs; ask.dmTs = record.dmTs;
      ask.ui.threadApplied = record.ui?.threadApplied ?? 0;
      ask.ui.dmApplied = record.ui?.dmApplied ?? 0;
      getView(ask.sessionId)?.contentPosted();
    },
  });

  type InteractionKind = "permission" | "question";
  function newAsk(id: string, sessionId: string): InteractionAsk | undefined {
    const bound = state.findThreadBySession(sessionId);
    // Do not dedupe an unbound boot ask: a later binding/poll may recover it.
    if (!bound) return;
    const [channel, threadTs] = bound.key.split(":") as [string, string];
    return { id, sessionId, projectDir: bound.thread.projectDir, channel, threadTs,
      askTs: null, dmTs: null, nudgeStarted: false,
      threadDelivery: { status: "new", attempts: 0 }, dmDelivery: { status: "new", attempts: 0 } };
  }

  function isPending(ask: InteractionAsk, kind: InteractionKind): boolean {
    if (kind === "question") {
      const q = ask as QuestionAsk;
      const key = `${q.channel}:${q.threadTs}`;
      const bound = state.getThread(key);
      if (!bound || bound.sessionId !== q.sessionId || bound.projectDir !== q.projectDir || state.bindingGeneration(key) !== q.generation) return false;
      if (bound.scheduledRunId && !scheduledReports()?.eligible(key, q.sessionId)) return false;
      if (q.resumeOwnerTs && !resumedQuestionEligible(q)) return false;
      if (!bound.scheduledRunId && (bound.hushed || bound.watchOnly ||
        (bound.recovery?.lastRun?.outcome === "stopped" && !resumedQuestionEligible(q)))) return false;
    }
    return !isStopping() && !ask.resolvedText &&
      (kind === "question" ? quesAsks.get(ask.id) : permAsks.get(ask.id)) === ask;
  }

  // Only explicit rejection proves a post had no effect. Transport timeouts,
  // connection errors, HTTP 5xx, and internal Slack errors retain uncertainty.
  function rejectedPost(err: unknown): boolean {
    if (isRateLimited(err)) return true;
    const e = err as { code?: string; data?: { error?: string } };
    return e?.code === "slack_webapi_platform_error" && new Set([
      "missing_scope", "invalid_auth", "token_revoked", "token_expired", "account_inactive",
      "channel_not_found", "not_in_channel", "is_archived", "no_permission", "restricted_action",
      "msg_too_long", "invalid_blocks", "invalid_arguments", "no_text",
    ]).has(e.data?.error ?? "");
  }

  /** One page (100) of a thread, or of a channel when `threadTs` is unset; callers enqueue it. */
  function historyPage(channel: string, threadTs: string | undefined, oldest?: string, cursor?: string) {
    const range = { ...(oldest ? { oldest, inclusive: true } : {}), ...(cursor ? { cursor } : {}) };
    return threadTs
      ? app.client.conversations.replies({ channel, ts: threadTs, ...range, limit: 100 })
      : app.client.conversations.history({ channel, ...range, limit: 100 });
  }

  /** Pages read per marker search; past this, absence stays unproven. */
  const MARKER_PAGES = 5;
  /**
   * First bot-authored post whose text matches, following next_cursor for up to
   * MARKER_PAGES pages (one queued request each). `complete` means every page in
   * the range was read, so absence is proven; a missing cursor, has_more, or an
   * exhausted budget leaves it unproven. Read-only: never posts or replies.
   */
  async function findBotMarker(channel: string, threadTs: string | undefined, match: (text: string) => boolean,
    opts: { oldest?: string; lane?: "interactive" } = {}): Promise<{ ts?: string; complete: boolean }> {
    let cursor: string | undefined;
    for (let pages = 0; pages < MARKER_PAGES && !isStopping(); pages++) {
      const page = await enqueue(() => historyPage(channel, threadTs, opts.oldest, cursor),
        { channel, method: threadTs ? "conversations.replies" : "conversations.history", ...(opts.lane ? { lane: opts.lane } : {}) });
      const copy = page.messages?.find(m => m.user === botUserId() && !!m.text && match(m.text) && m.ts);
      if (copy?.ts) return { ts: copy.ts, complete: true };
      cursor = page.response_metadata?.next_cursor || undefined;
      if (!cursor) return { complete: !page.has_more };
    }
    return { complete: false };
  }

  const hasLine = (markers: string[]) => (text: string) => text.split("\n").some(line => markers.includes(line));

  async function collapseCopy(channel: string, ts: string, text: string): Promise<boolean> {
    if (isStopping()) return false;
    return enqueue(async () => {
      if (isStopping()) return false;
      await app.client.chat.update({ channel, ts, text: unicodeEmoji(text),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: unicodeEmoji(text) } }] });
      return true;
    }, { channel, method: "chat.update", lane: "interactive" }).catch(err => { pushLog(`interaction update failed: ${String(err)}`); return false; });
  }

  function armInteractionNudge(ask: InteractionAsk, kind: InteractionKind): void {
    if (!isPending(ask, kind) || ask.nudgeStarted || (!ask.askTs && !ask.dmTs)) return;
    ask.nudgeStarted = true;
    const nudges = kind === "question" ? quesNudges : permNudges;
    const nudge = (remaining: number): void => {
      if (!isPending(ask, kind)) return;
      const timer = setTimeout(() => {
        nudges.delete(ask.id);
        if (!isPending(ask, kind)) return;
        const where = ask.askTs ? "above" : "in your DM";
        const action = kind === "question" ? `pick an option or Skip ${where}` : `reply \`\\permission ${ask.id} once\` or \`\\permission ${ask.id} deny\``;
        void enqueue(async () => {
          if (!isPending(ask, kind)) return; // It may resolve/stop while queued.
          await app.client.chat.postMessage({ channel: ask.channel, thread_ts: ask.threadTs,
            text: `⏰ Still waiting on this ${kind} — ${action}.`,
            mrkdwn: true, unfurl_links: false, unfurl_media: false });
        }, { channel: ask.channel, thread: ask.threadTs }).catch(() => {});
        if (remaining > 0) nudge(remaining - 1);
      }, 180_000);
      timer.unref();
      nudges.set(ask.id, timer);
    };
    nudge(1);
  }

  function deliverAsk(ask: InteractionAsk, kind: InteractionKind, header: string,
    blocks: () => unknown[], retry: boolean): Promise<void> {
    if (ask.deliveryFlight) return ask.deliveryFlight;
    ask.deliveryFlight = Promise.resolve().then(async () => {
      await Promise.all((["thread", "dm"] as const).map(async destination => {
        if (!isPending(ask, kind)) return;
        // A boot ask can precede DM availability; this is known not to have sent.
        if (destination === "dm" && !dmChannelId()) return;
        const delivery = destination === "thread" ? ask.threadDelivery : ask.dmDelivery;
        const channel = destination === "thread" ? ask.channel : dmChannelId()!;
        // Initial delivery has one stable marker even if an answer advances the
        // wizard before Slack returns this first post's timestamp.
        const marker = `slackoc-question:${ask.id}:${(ask as QuestionAsk).generation}`;
        if (retry && delivery.status === "uncertain") {
          try {
            const copy = await findBotMarker(channel, destination === "thread" ? ask.threadTs : undefined, hasLine([marker]));
            if (!isPending(ask, kind)) return;
            if (copy.ts) {
              if (destination === "thread") ask.askTs = copy.ts; else ask.dmTs = copy.ts;
              delivery.status = "delivered"; saveQuestion(ask as QuestionAsk);
              await questionUi.refresh(ask.id); return;
            }
            if (copy.complete && delivery.attempts < 3) delivery.status = "new";
          } catch (err) { pushLog(`question delivery reconciliation: ${String(err)}`); }
        }
        if (delivery.status !== "new" && !(retry && delivery.status === "rejected" && delivery.attempts < 3)) return;
        delivery.status = "in-flight";
        delivery.attempts++;
        saveQuestion(ask as QuestionAsk);
        let postedBlocks: unknown[];
        const postedPresentation = (ask as QuestionAsk).presentation;
        let built = false;
        let ts: string;
        try {
          try { postedBlocks = blocks(); }
          catch (err) { delivery.status = "rejected"; saveQuestion(ask as QuestionAsk); throw err; }
          built = true;
          const text = `${header}\n${marker}`;
          const result = destination === "thread"
            ? await render.post(ask.channel, ask.threadTs, text, postedBlocks, { unfurl: false, lane: "interactive" })
            : await render.dm!(ask.channel, ask.threadTs, text, postedBlocks, { lane: "interactive" });
          ts = result.ts;
          delivery.status = "delivered";
          if (destination === "thread") ask.askTs = ts; else ask.dmTs = ts;
          const question = ask as QuestionAsk;
          if (!ask.resolvedText && JSON.stringify(postedBlocks) === JSON.stringify(blocks())) {
            question.ui[destination === "thread" ? "threadApplied" : "dmApplied"] = question.ui.revision;
          }
          if (kind === "question") {
            saveQuestion(ask as QuestionAsk);
            questionStore.update(ask.id, record => {
              if (!sameQuestionBinding(record, ask as QuestionAsk)) return;
              record[destination === "thread" ? "threadPresentation" : "dmPresentation"] = postedPresentation;
            });
          }
        } catch (err) {
          delivery.status = !built || rejectedPost(err) ? "rejected" : "uncertain";
          saveQuestion(ask as QuestionAsk);
          pushLog(`${kind} ${destination} delivery ${delivery.status} (${ask.id}): ${String(err)}`);
          return;
        }
        if (isStopping()) return;
        // Resolution can precede a post response. Collapse that late copy too,
        // without re-registering the ask or recreating its nudge.
        if (ask.resolvedText) await questionUi.refresh(ask.id, true);
        else if (isPending(ask, kind)) {
          if (destination === "thread") getView(ask.sessionId)?.contentPosted();
          // Partial multi-select/custom answers may change while the DM posts.
          await questionUi.refresh(ask.id);
        }
      }));
      armInteractionNudge(ask, kind);
    }).finally(() => { ask.deliveryFlight = undefined; });
    return ask.deliveryFlight;
  }

  async function onPermission(perm: OcPermission, retry = false, expectedDir?: string): Promise<void> {
    if (isStopping() || !perm?.id || resolvedPerms.has(perm.id)) return;
    const bound = state.findThreadBySession(perm.sessionID);
    if (!bound || (expectedDir && bound.thread.projectDir !== expectedDir)) return;
    if (bound.thread.scheduledRunId) {
      if (!scheduledReports()?.eligible(bound.key, perm.sessionID)) return;
    } else if (retry && !isRecentRecoveryEligibleThread(bound.thread, state.now())) return;
    // First sight: let the run's earlier output land before the card (queue.ts keeps it ordered).
    if (!retry && !permAsks.has(perm.id)) {
      await getView(perm.sessionID)?.settle();
      if (isStopping() || resolvedPerms.has(perm.id)) return;
    }
    let ask = permAsks.get(perm.id);
    if (!ask) {
      const base = newAsk(perm.id, perm.sessionID);
      if (!base) return;
      const identity = { projectDir: bound.thread.projectDir, sessionId: perm.sessionID, requestId: perm.id,
        generation: state.bindingGeneration(bound.key) };
      const run = bound.thread.recovery?.lastRun;
      const runMessages = bound.thread.pendingRun?.userMsgTs ??
        (run && ["active", "interrupted"].includes(run.outcome) ? run.userMsgTs : []);
      // A recent \status or other administrative command cannot freshen an old ask.
      const originalOwnerTs = [...runMessages].sort(compareTs).at(-1) ??
        (retry ? undefined : bound.thread.recovery?.ownerActivityTs);
      const record = permissionStore.get(identity) ?? {
        ...identity, threadKey: bound.key, permission: perm, ownerActivityTs: originalOwnerTs,
        firstObservedAt: state.now(), updatedAt: state.now(),
        thread: { status: "new" as const, format: "card" as const, attempts: 0 },
        dm: { status: "new" as const, format: "card" as const, attempts: 0 }, response: { status: "pending" as const },
      };
      if (record.response.status === "resolved") { resolvedPerms.add(perm.id); return; }
      if (!permissionEligible(record)) return;
      permissionStore.put(record);
      ask = { ...base, perm, record, askTs: record.thread.ts ?? null, dmTs: record.dm.ts ?? null };
      permAsks.set(perm.id, ask);
      interactionChanged(ask.projectDir);
    }
    getView(ask.sessionId)?.setWaiting(perm.id, "permission", true);
    await permissionDelivery.deliver(ask.record);
    armInteractionNudge(ask, "permission");
  }

  function resumedQuestionEligible(ask: Pick<QuestionSnapshot, "resumeOwnerTs" | "channel" | "threadTs" | "generation" | "sessionId" | "projectDir">): boolean {
    const key = `${ask.channel}:${ask.threadTs}`;
    const bound = state.getThread(key);
    return !!bound && bound.sessionId === ask.sessionId && bound.projectDir === ask.projectDir &&
      state.bindingGeneration(key) === ask.generation && !bound.hushed && !bound.watchOnly &&
      replayAge(ask.resumeOwnerTs, state.now()).decision === "recover" &&
      (!bound.recovery?.canceledThroughTs || compareTs(ask.resumeOwnerTs!, bound.recovery.canceledThroughTs) >= 0);
  }

  async function onQuestion(req: OcQuestionRequest, retry = false, resumeOwnerTs?: string): Promise<void> {
    if (isStopping() || !req?.id || resolvedQuestions.has(req.id)) return;
    const context = state.findThreadBySession(req.sessionID);
    if (!context || context.thread.hushed || context.thread.watchOnly) return;
    if (resumeOwnerTs) {
      const [channel, threadTs] = context.key.split(":") as [string, string];
      if (!resumedQuestionEligible({ channel, threadTs, generation: state.bindingGeneration(context.key),
        sessionId: req.sessionID, projectDir: context.thread.projectDir, resumeOwnerTs })) return;
    }
    if (context?.thread.scheduledRunId && !scheduledReports()?.eligible(context.key, req.sessionID)) return;
    if (retry) {
      const bound = state.findThreadBySession(req.sessionID);
      const saved = questionStore.get(req.id);
      if (!bound || (!bound.thread.scheduledRunId && !isRecentRecoveryEligibleThread(bound.thread, state.now()) &&
        !(saved && resumedQuestionEligible(saved)) && !resumeOwnerTs)) return;
    }
    // First sight: let the run's earlier output land before the card (queue.ts keeps it ordered).
    if (!retry && !quesAsks.has(req.id) && !questionStore.get(req.id)) {
      await getView(req.sessionID)?.settle();
      if (isStopping() || resolvedQuestions.has(req.id)) return;
    }
    const prior = questionStore.get(req.id);
    const [targetChannel, targetThread] = context.key.split(":") as [string, string];
    if (prior && !sameQuestionBinding(prior, { id: req.id, sessionId: req.sessionID, projectDir: context.thread.projectDir,
      generation: state.bindingGeneration(context.key), channel: targetChannel, threadTs: targetThread }) && prior.relocation) {
      await questionUi.refresh(req.id, true);
      const remaining = questionStore.get(req.id)?.relocation;
      if ([remaining?.thread, remaining?.dm].some(move => move && ["in-flight", "uncertain"].includes(move.status))) {
        pushLog(`question ${req.id} resume deferred: previous card delivery remains uncertain`);
        return;
      }
    }
    let ask = quesAsks.get(req.id);
    if (ask && (ask.sessionId !== req.sessionID || ask.projectDir !== context.thread.projectDir ||
      `${ask.channel}:${ask.threadTs}` !== context.key || ask.generation !== state.bindingGeneration(context.key))) {
      if (!resumeOwnerTs) return;
      const timer = quesNudges.get(ask.id);
      if (timer) clearTimeout(timer);
      quesNudges.delete(ask.id);
      quesAsks.delete(ask.id);
      ask = undefined;
    }
    if (!ask) {
      const base = newAsk(req.id, req.sessionID);
      if (!base) return;
      const generation = state.bindingGeneration(`${base.channel}:${base.threadTs}`);
      const saved = questionStore.get(req.id);
      if (saved && !resumeOwnerTs && !sameQuestionBinding(saved, { id: req.id, sessionId: req.sessionID,
        projectDir: base.projectDir, generation, channel: base.channel, threadTs: base.threadTs })) return;
      const sameForm = saved && saved.sessionId === req.sessionID && saved.projectDir === base.projectDir &&
        JSON.stringify(saved.req) === JSON.stringify(req);
      const restore = sameForm && saved.generation === generation && saved.channel === base.channel && saved.threadTs === base.threadTs;
      if (restore && saved.response === "resolved") return;
      const carry = sameForm && !!resumeOwnerTs;
      const sameDestination = sameForm && saved.channel === base.channel && saved.threadTs === base.threadTs;
      ask = { ...base, req, generation, response: restore ? saved.response : carry && ["answering", "uncertain"].includes(saved.response) ? "uncertain" : "pending",
        answers: restore || carry ? saved.answers : req.questions.map(() => []),
        finalized: restore ? saved.finalized : req.questions.map(() => false),
        askTs: restore || sameDestination ? saved.askTs : null, dmTs: restore || carry ? saved.dmTs : null,
        ui: restore ? saved.ui ?? { revision: 1, threadApplied: 0, dmApplied: 0 } : { revision: (saved?.ui?.revision ?? 0) + 1, threadApplied: 0, dmApplied: 0 },
        page: restore ? saved.page : 0, cursor: restore ? saved.cursor : undefined, draftRevision: restore ? saved.draftRevision ?? 0 : (saved?.draftRevision ?? 0) + 1,
        presentation: restore ? saved.presentation ?? 0 : 0,
        resumeOwnerTs: resumeOwnerTs ?? (restore ? saved.resumeOwnerTs : undefined) };
      if (isStopping() || state.bindingGeneration(context.key) !== generation || state.findThreadBySession(req.sessionID)?.key !== context.key) return;
      if (ask.askTs) ask.threadDelivery.status = "delivered";
      if (ask.dmTs) ask.dmDelivery.status = "delivered";
      if (restore && saved.threadDelivery) ask.threadDelivery = saved.threadDelivery;
      if (restore && saved.dmDelivery) ask.dmDelivery = saved.dmDelivery;
      saveQuestion(ask, true);
      if (!restore && saved?.askTs && !sameDestination) questionStore.update(req.id, record => {
        record.retiredCopies = [...record.retiredCopies ?? [], { channel: saved.channel, ts: saved.askTs! }];
      });
      quesAsks.set(req.id, ask); // Buttons are usable BEFORE either post awaits.
      interactionChanged(ask.projectDir);
    }
    if (resumeOwnerTs && ask.resumeOwnerTs !== resumeOwnerTs) {
      ask.resumeOwnerTs = resumeOwnerTs;
      ask.finalized.fill(false);
      changedQuestion(ask);
    }
    const pending = ask;
    getView(ask.sessionId)?.setWaiting(req.id, "question", true);
    await deliverAsk(ask, "question", `❓ *OpenCode has a question* — ${req.questions.length} to answer`,
      () => questionCard(pending), retry);
    await questionUi.refresh(ask.id);
  }

  async function resolveInteraction(kind: InteractionKind, id: string, text: string,
    sessionId?: string, knownAsk?: InteractionAsk): Promise<void> {
    const asks = kind === "question" ? quesAsks : permAsks;
    const resolved = kind === "question" ? resolvedQuestions : resolvedPerms;
    const nudges = kind === "question" ? quesNudges : permNudges;
    const ask = asks.get(id) ?? knownAsk;
    const saved = kind === "question" ? questionStore.get(id) : undefined;
    if (sessionId && (ask?.sessionId ?? saved?.sessionId) && sessionId !== (ask?.sessionId ?? saved?.sessionId)) return;
    if (kind === "question" && ask) {
      const question = ask as QuestionAsk;
      question.response = "resolved";
      question.resolvedText = text;
      changedQuestion(question, false);
    }
    if (kind === "question" && !ask && saved) questionStore.update(id, record => {
      record.response = "resolved"; record.resolvedText = text;
      record.ui ??= { revision: 1, threadApplied: 0, dmApplied: 0 };
      record.ui.revision++; record.updatedAt = Date.now();
    });
    resolved.add(id);
    if (ask) ask.resolvedText = text;
    asks.delete(id);
    const timer = nudges.get(id);
    if (timer) clearTimeout(timer);
    nudges.delete(id);
    const sid = ask?.sessionId ?? saved?.sessionId ?? sessionId;
    if (sid) getView(sid)?.setWaiting(id, kind, false);
    const dir = ask?.projectDir ?? (sid ? state.findThreadBySession(sid)?.thread.projectDir : undefined);
    if (dir) interactionChanged(dir);
    // Permission copies are collapsed by collapsePermissionCopies (durable registry).
    if (kind === "question") await questionUi.refresh(id, true);
  }

  function onQuestionResolved(id: string, kind: "replied" | "rejected", sessionId?: string): Promise<void> {
    return resolveInteraction("question", id, kind === "rejected"
      ? ":arrow_forward: Skip confirmed."
      : ":white_check_mark: Answer confirmed.", sessionId);
  }

  async function onPermissionResolved(id: string, sessionId?: string): Promise<void> {
    const ask = permAsks.get(id);
    const record = ask?.record ?? permissionStore.list().find(r => r.requestId === id && (!sessionId || r.sessionId === sessionId));
    if (record) { await permissionResponder.observeResolved(record); return; }
    await resolveInteraction("permission", id, "Permission resolved or expired.", sessionId);
  }

  // Keep the onReady hook's signature; boot, resume, and periodic recovery all
  // share the same identity-checked, per-directory flight (including permissions).
  async function sweepQuestions(dir: string, baseUrl: string): Promise<void> {
    if (pool.get(dir)?.baseUrl === baseUrl) await sweepInteractions(dir);
  }

  function sweepInteractions(dir: string): Promise<void> {
    const entry = pool.get(dir);
    if (!interactionsEnabled() || !entry?.baseUrl || isStopping()) return Promise.resolve();
    const key = entry.dir;
    const existing = interactionSweeps.get(key);
    if (existing) { existing.requested = true; return existing.flight; }
    const sweep = { requested: false, flight: null as unknown as Promise<void> };
    sweep.flight = Promise.resolve().then(async () => {
      do {
        sweep.requested = false;
        const current = pool.get(key);
        if (!current?.baseUrl || isStopping()) return;
        const version = interactionVersions.get(key) ?? 0;
        const [questions, permissions] = await withExistingLease(current, async () => Promise.allSettled([
          pendingQuestions(current.client!), pendingPermissions(current.client!),
        ]));
        if (isStopping() || pool.get(key) !== current || (interactionVersions.get(key) ?? 0) !== version) continue;
        // Apply all local changes without yielding; delivery promises finish
        // afterward and check ask identity/resolution before adopting late work.
        const work: Promise<void>[] = [];
        if (questions.status === "fulfilled") {
          const ids = new Set(questions.value.map(q => q.id));
          for (const saved of questionStore.list()) if (saved.projectDir === key && saved.response !== "resolved" && !ids.has(saved.id) && !quesAsks.has(saved.id)) {
            work.push(resolveInteraction("question", saved.id, "Question resolved or expired; the previous answer was not confirmed.", saved.sessionId));
          }
          for (const [id, ask] of quesAsks) if (ask.projectDir === key && !ids.has(id)) work.push(resolveInteraction("question", id, "Question resolved or expired; the previous answer was not confirmed."));
          for (const q of questions.value) work.push(onQuestion(q, true));
        } else pushLog(`question sweep failed for ${key}: ${String(questions.reason)}`);
        if (permissions.status === "fulfilled") {
          const ids = new Set(permissions.value.map(p => p.id));
          for (const [id, ask] of permAsks) if (ask.projectDir === key && !ids.has(id)) work.push(onPermissionResolved(id));
          // Saved requests never hydrated (e.g. resolved while the bridge was down): the
          // responder resolves current ones as unconfirmed without sending any reply.
          for (const saved of permissionStore.list()) if (saved.projectDir === key && saved.response.status !== "resolved" &&
            !ids.has(saved.requestId) && !permAsks.has(saved.requestId)) {
            work.push(permissionResponder.observeResolved(saved).then(() => {}));
          }
          for (const p of permissions.value) work.push(onPermission(p, true, key));
        } else pushLog(`permission sweep failed for ${key}: ${String(permissions.reason)}`);
        await Promise.all(work);
      } while (sweep.requested && !isStopping());
    }).catch(err => logErr(`interaction sweep failed for ${key}: ${String(err)}`))
      .finally(() => { if (interactionSweeps.get(key) === sweep) interactionSweeps.delete(key); });
    interactionSweeps.set(key, sweep);
    return sweep.flight;
  }

  async function withExistingLease<T>(entry: PoolEntry, work: () => Promise<T>): Promise<T> {
    const lease = pool.acquireExisting(entry.dir);
    if (isStopping() || pool.get(entry.dir) !== entry || lease?.entry !== entry) {
      lease?.release();
      throw new Error("OpenCode generation no longer running");
    }
    try { return await work(); } finally { lease?.release(); }
  }

  function permissionEligible(record: PermissionRecord): boolean {
    const bound = state.getThread(record.threadKey);
    if (bound?.scheduledRunId) return !isStopping() && bound.sessionId === record.sessionId &&
      bound.projectDir === record.projectDir && state.bindingGeneration(record.threadKey) === record.generation &&
      !!scheduledReports()?.eligible(record.threadKey, record.sessionId) &&
      ["read", "glob", "grep", "webfetch", "websearch", "question", "external_directory"].includes(record.permission.type);
    return !isStopping() && !!bound && bound.sessionId === record.sessionId && bound.projectDir === record.projectDir &&
      state.bindingGeneration(record.threadKey) === record.generation && !bound.hushed && !bound.watchOnly &&
      replayAge(record.ownerActivityTs, state.now()).decision === "recover" &&
      (!bound.recovery?.canceledThroughTs || compareTs(record.ownerActivityTs!, bound.recovery.canceledThroughTs) > 0);
  }

  async function collapsePermissionCopies(record: PermissionRecord, text: string): Promise<void> {
    await Promise.all((["thread", "dm"] as const).map(async destination => {
      const copy = permissionStore.get(record)?.[destination];
      if (!copy?.channel || !copy.ts || copy.collapsed) return;
      if (await collapseCopy(copy.channel, copy.ts, text)) permissionStore.update(record, r => {
        if (r[destination].ts === copy.ts) r[destination].collapsed = true;
      });
    }));
  }

  const permissionResponder = new PermissionResponder<PoolEntry>({
    ownerSlackUserId: config.ownerSlackUserId, store: permissionStore,
    getBinding: key => {
      const t = state.getThread(key);
      return t ? { projectDir: t.projectDir, sessionId: t.sessionId, generation: state.bindingGeneration(key) } : undefined;
    },
    getRunning: dir => { const e = pool.get(dir); return !isStopping() && e?.status === "ready" ? e : undefined; },
    findPending: entry => withExistingLease(entry, () => pendingPermissions(entry.client!)),
    respond: (entry, perm, choice) => withExistingLease(entry, async () => { await permRespond(entry.client!, perm.sessionID, perm.id, choice); }),
    eligible: permissionEligible,
    resolved: async (record, text) => {
      const ask = permAsks.get(record.requestId);
      // The durable copy registry owns result updates, including retry after a restart.
      if (ask) { ask.askTs = null; ask.dmTs = null; }
      await resolveInteraction("permission", record.requestId, text, record.sessionId, ask);
      await collapsePermissionCopies(record, text);
    },
  });

  const permissionDelivery = new PermissionDeliveryManager({
    store: permissionStore, isCurrent: permissionEligible, now: state.now,
    post: async (record, destination, text, blocks) => {
      const channel = destination === "thread" ? record.threadKey.split(":")[0]! : dmChannelId();
      if (!channel) throw Object.assign(new Error("owner DM channel unavailable"), { code: "channel_not_found" });
      const rootTs = record.threadKey.split(":")[1]!;
      const link = destination === "dm" ? viewThread(record.threadKey.split(":")[0]!, rootTs) : "";
      const result = await enqueue(async () => {
        const current = permissionStore.get(record);
        if (!current || current.response.status === "resolved" || !permissionEligible(current)) throw new Error("permission no longer pending");
        return app.client.chat.postMessage({ channel, ...(destination === "thread" ? { thread_ts: rootTs } : {}),
          text: text + link, ...(blocks ? { blocks: appendSectionSuffix(blocks, link) as never } : {}),
          mrkdwn: true, unfurl_links: false, unfurl_media: false });
      }, { channel, lane: "interactive", thread: destination === "thread" ? rootTs : "" });
      if (!result.ts) throw new Error("Slack did not confirm the permission message timestamp");
      return { channel, ts: result.ts };
    },
    findCopy: async (record, destination, marker) => {
      const channel = destination === "thread" ? record.threadKey.split(":")[0]! : dmChannelId();
      if (!channel || isStopping()) return "unknown";
      const oldest = String(Math.max(0, record.firstObservedAt - 60_000) / 1000);
      const copy = await findBotMarker(channel, destination === "thread" ? record.threadKey.split(":")[1]! : undefined,
        text => text.includes(marker), { oldest, lane: "interactive" });
      if (copy.ts) return { channel, ts: copy.ts };
      return copy.complete ? "absent" : "unknown";
    },
    onDelivered: async (record, destination) => {
      const d = record[destination];
      const ask = permAsks.get(record.requestId);
      if (ask) { if (destination === "thread") ask.askTs = d.ts ?? null; else ask.dmTs = d.ts ?? null; }
      if (record.response.status === "resolved" || !permissionEligible(record)) {
        await collapsePermissionCopies(record, record.response.text ?? "Permission expired or session changed.");
      } else {
        if (destination === "thread") getView(record.sessionId)?.contentPosted();
        if (ask) armInteractionNudge(ask, "permission");
      }
    },
    onState: record => {
      const failed = [record.thread, record.dm].some(d => d.error) && ![record.thread, record.dm].some(d => d.status === "delivered");
      getView(record.sessionId)?.setPermissionDeliveryFailed(record.requestId, failed);
    },
  });

  // Independent of history/acceptance scans: an approval can unblock the current run.
  let terminalQuestionOffset = 0;
  async function reconcileTerminalQuestionPosts(): Promise<void> {
    const records = questionStore.list().filter(r => r.response === "resolved" && state.now() - r.updatedAt <= 7 * 86400_000 &&
      ((!r.askTs && r.threadDelivery?.status === "uncertain") || (!r.dmTs && r.dmDelivery?.status === "uncertain")));
    const work = Array.from({ length: Math.min(4, records.length) }, (_, i) => records[(terminalQuestionOffset + i) % records.length]!);
    terminalQuestionOffset += work.length;
    await Promise.all(work.map(async record => {
      for (const destination of ["thread", "dm"] as const) {
        const channel = destination === "thread" ? record.channel : dmChannelId();
        const tsKey = destination === "thread" ? "askTs" : "dmTs";
        const deliveryKey = destination === "thread" ? "threadDelivery" : "dmDelivery";
        if (!channel || record[tsKey] || record[deliveryKey]?.status !== "uncertain" || isStopping()) continue;
        try {
          const copy = await findBotMarker(channel, destination === "thread" ? record.threadTs : undefined,
            hasLine([`slackoc-question:${record.id}:${record.generation}`]));
          if (isStopping()) return;
          questionStore.update(record.id, current => {
            if (!sameQuestionBinding(record, current) || current.response !== "resolved" || current[tsKey]) return;
            if (copy.ts) {
              current[tsKey] = copy.ts;
              current[deliveryKey] = { ...current[deliveryKey]!, status: "delivered" };
              current.ui![destination === "thread" ? "threadApplied" : "dmApplied"] = 0;
            } else if (copy.complete) {
              // Proved absent: there is no terminal card to replace, never repost it.
              current[deliveryKey] = { ...current[deliveryKey]!, status: "rejected" };
            }
          });
        } catch (err) { pushLog(`question terminal delivery reconciliation: ${String(err)}`); }
      }
    }));
  }

  // Accepted-but-response-lost copies of resolved permissions: marker-only, a few per refresh.
  let terminalPermissionOffset = 0;
  async function reconcileTerminalPermissionPosts(): Promise<void> {
    const records = permissionStore.list().filter(r => r.response.status === "resolved" && state.now() - r.updatedAt <= 7 * 86400_000 &&
      [r.thread, r.dm].some(d => d.status === "uncertain" || d.status === "in-flight"));
    const work = Array.from({ length: Math.min(4, records.length) }, (_, i) => records[(terminalPermissionOffset + i) % records.length]!);
    terminalPermissionOffset += work.length;
    await Promise.all(work.map(record => permissionDelivery.recoverTerminal(record)));
  }

  async function refreshPermissions(force = false): Promise<void> {
    if (!interactionsEnabled() || isStopping()) return;
    if (!dmChannelId() && force) {
      const opened = await app.client.conversations.open({ users: config!.ownerSlackUserId }).catch(() => null);
      setDmChannel(opened?.channel?.id ?? null);
    }
    for (const record of permissionStore.list()) {
      if (record.response.status === "resolved" && permissionEligible(record)) {
        await collapsePermissionCopies(record, record.response.text ?? "Permission resolved or expired.");
      }
      if (record.response.status !== "resolved" && !permissionEligible(record)) {
        permissionStore.update(record, r => { r.response = { ...r.response, status: "resolved", confirmed: false, text: "Permission retired: old or canceled conversation." }; });
        const ask = permAsks.get(record.requestId);
        if (ask) {
          ask.resolvedText = "Permission retired.";
          permAsks.delete(record.requestId);
          const timer = permNudges.get(record.requestId);
          if (timer) clearTimeout(timer);
          permNudges.delete(record.requestId);
          getView(record.sessionId)?.setWaiting(record.requestId, "permission", false);
        }
      }
    }
    await Promise.all(pool.list().filter(e => e.status === "ready").map(e => sweepInteractions(e.dir)));
    await reconcileTerminalQuestionPosts();
    await reconcileTerminalPermissionPosts();
    await questionUi.refreshAll(force);
    if (force) await Promise.all([...permAsks.values()].map(a => permissionDelivery.deliver(a.record, { force: true })));
  }

  for (const actionId of PERMISSION_ACTIONS) app.action(actionId, async ({ ack, body, action, respond }) => {
    await ack();
    if (isStopping()) return;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can approve OpenCode actions.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const v = parsePermissionButton(actionId, (action as { value?: string }).value);
    if (!v) { await respond({ text: "Invalid permission button. Use \\permissions.", response_type: "ephemeral" }); return; }
    const envelope = body as unknown as { channel?: { id: string }; container?: { thread_ts?: string }; message?: { thread_ts?: string } };
    const channel = envelope.channel?.id;
    const root = envelope.message?.thread_ts ?? envelope.container?.thread_ts;
    if (!channel || (channel !== dmChannelId() && !root)) {
      await respond({ text: "Cannot identify this permission's thread. Use \\permissions there or in your owner DM.", response_type: "ephemeral" });
      return;
    }
    try {
      const result = await permissions.respond({ actor: body.user.id, requestId: v.p, response: v.r,
        sessionId: v.s, generation: v.g, actionId, source: "live",
        context: channel === dmChannelId() ? { dm: true } : { threadKey: `${channel}:${root}` } });
      if (result.notificationError) logErr(`permission result delivery failed: ${result.notificationError}`);
      if (result.status !== "resolved") await respond({ text: result.text, response_type: "ephemeral" });
    } catch (err) {
      logErr(`permission respond failed: ${String((err as Error)?.message ?? err)}`);
      await respond({ text: `Failed to reply to OpenCode: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
    }
  });

  // Question tool (issue #2): owner taps an option (single-select, one tap per
  // question) or Skip. Labels are resolved from the stored ask, so the button
  // value stays tiny. When every question is answered we send the full matrix;
  // the SSE question.replied/rejected echo then collapses both copies too.
  // One recoverable writer per copy; callers never pass captured old blocks.
  const renderAskBoth = (ask: QuestionAsk): Promise<unknown>[] => [questionUi.refresh(ask.id, true)];

  // If every question is finalized and the owner `confirmed` (one-tap ask or
  // the review step's Submit answers), send the answer matrix and resolve the
  // ask; otherwise re-render both copies (a complete, unconfirmed form shows the
  // review step). "failed" = the reply errored (re-rendered so the owner can
  // retry or Skip) — the caller surfaces the ephemeral notice.
  const submitAskIfComplete = async (ask: QuestionAsk, client: NonNullable<PoolEntry["client"]>, confirmed: boolean): Promise<"replied" | "incomplete" | "failed"> => {
    if (!isPending(ask, "question")) return "incomplete";
    if (questionLocks.has(ask.id)) return "incomplete";
    changedQuestion(ask);
    if (ask.response === "uncertain") {
      questionLocks.add(ask.id);
      try {
        const pending = await pendingQuestions(client);
        if (!isPending(ask, "question")) return "incomplete";
        if (!pending.some(q => q.id === ask.id && q.sessionID === ask.sessionId)) {
          await resolveInteraction("question", ask.id, "Question resolved or expired; the previous answer was not confirmed.");
          return "replied";
        }
        ask.response = "pending"; changedQuestion(ask, false);
        await questionUi.refresh(ask.id, true);
        await render.post(ask.channel, ask.threadTs, "The form is still pending. Your previous submission was not confirmed; review your answers, then tap Submit answers to send them.", undefined, { lane: "interactive" });
        return "incomplete";
      } catch (err) {
        logErr(`question reconciliation failed: ${String(err)}`);
        return "failed";
      } finally { questionLocks.delete(ask.id); }
    }
    const visible = visibleQuestions(ask.req, ask.answers);
    if (!confirmed || !ask.req.questions.every((_, qi) => ask.finalized[qi] || !visible[qi])) {
      await Promise.all(renderAskBoth(ask));
      return "incomplete";
    }
    questionLocks.add(ask.id);
    try {
      ask.response = "answering"; changedQuestion(ask, false);
      void questionUi.refresh(ask.id).catch(err => logErr(`question sending update: ${String(err)}`));
      await questionReply(client, ask.req.id, ask.answers, { request: ask.req });
    } catch (err) {
      if (ask.resolvedText) return "replied";
      ask.response = (err as { _tag?: string })?._tag === "FormInvalidAnswerError" ? "pending" : "uncertain";
      changedQuestion(ask, false);
      logErr(`question reply failed: ${String((err as Error)?.message ?? err)}`);
      if (isPending(ask, "question")) await Promise.all(renderAskBoth(ask));
      return "failed";
    } finally {
      questionLocks.delete(ask.id);
    }
    await onQuestionResolved(ask.req.id, "replied");
    return "replied";
  };

  // Shared owner/bound/ask/entry guard for the question action handlers.
  const questionGuard = async (
    body: { user: { id: string } },
    raw: string | undefined,
    respond: RespondFn,
    allowUncertain = false,
  ): Promise<{ v: { s: string; q: string; i: number; a?: number; page?: number; g?: number; b?: string; c?: number; r?: number }; ask: QuestionAsk; client: NonNullable<PoolEntry["client"]> } | null> => {
    if (isStopping()) return null;
    if (body.user.id !== config.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can answer OpenCode questions.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    const invalid = async (text = "Invalid or outdated question control. Use \\questions to get the latest card.") => {
      await respond({ text, response_type: "ephemeral" }).catch(() => {}); return null;
    };
    if (!raw) return invalid();
    let parsed: { s: string; q: string; i: number; a?: number; g?: number; b?: string; c?: number };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
      if (!parsed || typeof parsed.s !== "string" || typeof parsed.q !== "string") return invalid();
    } catch {
      return invalid();
    }
    const bound = state.findThreadBySession(parsed.s);
    if (!bound) {
      await respond({ text: "That session is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    const ask = quesAsks.get(parsed.q);
    if (!ask || ask.sessionId !== parsed.s || !isPending(ask, "question")) {
      await respond({ text: "That question is no longer tracked here.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    if (!Number.isSafeInteger(parsed.g) || parsed.g !== ask.generation || parsed.b !== questionBindingToken(ask)) {
      await respond({ text: "This question belongs to an older binding. Use the latest card — refreshing it now.", response_type: "ephemeral" }).catch(() => {});
      changedQuestion(ask, false);
      await questionUi.refresh(ask.id, true);
      return null;
    }
    if (!Number.isSafeInteger(parsed.c ?? 0) || (parsed.c ?? 0) !== ask.presentation) {
      await respond({ text: "That answer is already saved or this card moved. Use the latest question below.", response_type: "ephemeral" }).catch(() => {});
      await questionUi.refresh(ask.id, true);
      return null;
    }
    const envelope = body as { channel?: { id: string }; message?: { thread_ts?: string }; container?: { thread_ts?: string } };
    if (envelope.channel && envelope.channel.id !== dmChannelId() &&
      (envelope.channel.id !== ask.channel || (envelope.message?.thread_ts ?? envelope.container?.thread_ts) !== ask.threadTs)) return invalid("Use this question's current thread or owner DM.");
    if (!envelope.channel) return invalid("Cannot identify this question's destination. Use \\questions.");
    if (!Number.isSafeInteger(parsed.i) || parsed.i < 0 || parsed.i >= ask.req.questions.length) return invalid();
    if (questionLocks.has(ask.id)) { await respond({ text: "An answer is already being submitted.", response_type: "ephemeral" }); return null; }
    if (ask.response === "uncertain" && !allowUncertain) return invalid("Submission unconfirmed. Use Retry submission to reconcile it before changing answers.");
    const entry = pool.get(bound.thread.projectDir);
    if (!entry?.client) {
      await respond({ text: "The OpenCode server isn't ready yet — try again in a moment.", response_type: "ephemeral" }).catch(() => {});
      return null;
    }
    return { v: parsed, ask, client: entry.client };
  };
  async function alreadySaved(ask: QuestionAsk, respond: RespondFn): Promise<void> {
    await respond({ text: "That answer is already saved. Refreshing the question — use the latest card.", response_type: "ephemeral" }).catch(() => {});
    changedQuestion(ask, false);
    await questionUi.refresh(ask.id, true);
  }
  /** A question can't take an answer when it's hidden, or finalized and not the one on screen (re-answering via Back is allowed). */
  const answerLocked = (ask: QuestionAsk, i: number): boolean =>
    (ask.finalized[i] && i !== shownQuestion(ask)) || !visibleQuestions(ask.req, ask.answers)[i];

  app.action(QUESTION_ACTION_PATTERN, async ({ ack, body, action, respond }) => {
    await ack();
    if (isStopping()) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id)) return;
    const { v, ask, client } = g;

    if (v.a === -1) {
      // Skip (reject): unblock the run, collapse both copies to a final line.
      try {
        questionLocks.add(ask.id);
        ask.response = "answering"; changedQuestion(ask, false);
        void questionUi.refresh(ask.id).catch(err => logErr(`question skip update: ${String(err)}`));
        await questionReject(client, v.q, { sessionId: ask.sessionId });
      } catch (err) {
        if (ask.resolvedText) return;
        ask.response = "uncertain"; changedQuestion(ask, false);
        await questionUi.refresh(ask.id, true);
        logErr(`question reject failed: ${String((err as Error)?.message ?? err)}`);
        await respond({ text: `Failed to skip the question: ${String(err)}`, response_type: "ephemeral" }).catch(() => {});
        return;
      } finally { questionLocks.delete(ask.id); }
      await onQuestionResolved(v.q, "rejected");
      return;
    }

    const q = ask.req.questions[v.i!];
    if (answerLocked(ask, v.i)) { await alreadySaved(ask, respond); return; }
    const label = q?.options[v.a!]?.value ?? q?.options[v.a!]?.label;
    if (!q || label == null) { await respond({ text: "That option is no longer available. Use the latest card.", response_type: "ephemeral" }); return; }

    if (q.multiple) {
      // Multi-select: toggle this option in/out; "Submit selection" finalizes.
      const cur = ask.answers[v.i!]!;
      const idx = cur.indexOf(label);
      if (idx >= 0) cur.splice(idx, 1);
      else cur.push(label);
      changedQuestion(ask);
      await Promise.all(renderAskBoth(ask));
      return;
    }

    // Single-select: one tap locks the answer, then advance (cursor cleared) / submit-if-complete.
    ask.answers[v.i!] = [label];
    ask.finalized[v.i!] = true;
    ask.page = 0; ask.cursor = undefined;
    const r = await submitAskIfComplete(ask, client, oneTap(ask));
    if (r === "failed") {
      await respond({ text: "Failed to send your answer — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
    }
  });

  app.action("qsubmit", async ({ ack, body, action, respond }) => {
    await ack();
    if (isStopping()) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const { v, ask, client } = g;
    if (answerLocked(ask, v.i)) { await alreadySaved(ask, respond); return; }
    const field = ask.req.questions[v.i]?.field;
    if (!ask.answers[v.i!]?.length && (!field || field.type === "external" || field.required)) {
      await respond({ text: "Pick at least one option before submitting.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    ask.finalized[v.i!] = true;
    ask.page = 0; ask.cursor = undefined;
    const r = await submitAskIfComplete(ask, client, oneTap(ask));
    if (r === "failed") {
      await respond({ text: "Failed to send your answer — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
    }
  });

  app.action("qomit", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id)) return;
    if (answerLocked(g.ask, g.v.i)) { await alreadySaved(g.ask, respond); return; }
    const field = g.ask.req.questions[g.v.i]?.field;
    if (!field || field.type === "external" || field.required) return;
    g.ask.answers[g.v.i] = []; g.ask.finalized[g.v.i] = true; g.ask.page = 0; g.ask.cursor = undefined;
    await submitAskIfComplete(g.ask, g.client, oneTap(g.ask));
  });

  app.action(/^qpage_(prev|next)$/, async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || !Number.isSafeInteger(g.v.page) || g.v.page! < 0) return;
    g.ask.page = g.v.page;
    changedQuestion(g.ask, false);
    await Promise.all(renderAskBoth(g.ask));
  });
  // Back/Next: move the cursor to the payload's question (`r` = leave the cursor
  // for the first unfinished question / review step). Edits the card in place.
  app.action(/^qnav_(prev|next)$/, async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id) || g.ask.response !== "pending") return;
    if (!g.v.r && !visibleQuestions(g.ask.req, g.ask.answers)[g.v.i]) { await alreadySaved(g.ask, respond); return; }
    g.ask.cursor = g.v.r ? undefined : g.v.i;
    g.ask.page = 0;
    changedQuestion(g.ask, false, true);
    await Promise.all(renderAskBoth(g.ask));
  });
  // Review step: the only path that submits a multi-question form.
  app.action("qsubmit_all", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const r = await submitAskIfComplete(g.ask, g.client, true);
    if (r === "failed") await respond({ text: "Failed to send your answers — try again or Skip.", response_type: "ephemeral" }).catch(() => {});
  });
  app.action("qretry", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond, true);
    if (!g) return;
    const result = await submitAskIfComplete(g.ask, g.client, true);
    if (result === "failed") await respond({ text: "Answer not confirmed. Retry submission reconciles it before sending again.", response_type: "ephemeral" });
  });
  app.action("qedit", async ({ ack, body, action, respond }) => {
    await ack();
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g || questionLocks.has(g.ask.id)) return;
    g.ask.finalized.fill(false); g.ask.page = 0; g.ask.cursor = undefined;
    changedQuestion(g.ask);
    await Promise.all(renderAskBoth(g.ask));
  });
  app.action("qexternal", async ({ ack }) => { await ack(); });

  app.action("qtext", async ({ ack, body, action, client, respond }) => {
    await ack();
    if (isStopping()) return;
    const g = await questionGuard(body, (action as { value?: string }).value, respond);
    if (!g) return;
    const { v, ask } = g;
    const q = ask.req.questions[v.i!];
    if (!q || !q.custom || answerLocked(ask, v.i)) { await alreadySaved(ask, respond); return; }
    // Open a modal; the answer comes back through the qtext_submit view.
    // (trigger_id lives on the BlockAction body, not the DialogSubmit variant.)
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;
    await client.views
      .open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "qtext_submit",
          title: { type: "plain_text", text: Array.from(q.header).slice(0, 24).join("") || "Your answer" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "qtext_input",
              label: { type: "plain_text", text: Array.from(q.question).slice(0, 2000).join("") || "Your answer" },
              optional: false,
              element: {
                type: "plain_text_input",
                action_id: "qtext_field",
                placeholder: { type: "plain_text", text: "Type your own answer…" },
                ...(ask.answers[v.i]?.length && !q.multiple ? { initial_value: ask.answers[v.i]![0] } : {}),
                multiline: true,
              },
            },
          ],
          private_metadata: JSON.stringify({ s: v.s, q: v.q, i: v.i, g: ask.generation, b: questionBindingToken(ask), c: ask.presentation, revision: ask.draftRevision }),
        },
      })
      .catch(async (err) => {
        logErr(`question modal failed: ${String((err as Error)?.message ?? err)}`);
        await respond({ text: "Couldn't open the answer form. Please tap Type your answer again.", response_type: "ephemeral" }).catch(() => {});
      });
  });

  app.view("qtext_submit", async ({ ack, body, view }) => {
    if (isStopping()) { await ack(); return; }
    if (body.user.id !== config.ownerSlackUserId) {
      await ack({ response_action: "errors", errors: { qtext_input: "Only the paired owner can answer." } });
      return;
    }
    let v: { s: string; q: string; i: number; g: number; b: string; c?: number; revision: number };
    try {
      v = JSON.parse(view.private_metadata ?? "") as typeof v;
      if (!v || typeof v.s !== "string" || typeof v.q !== "string") throw new Error("Invalid modal identity");
    } catch {
      await ack({ response_action: "errors", errors: { qtext_input: "This form is outdated. Close it and use the latest question card." } });
      return;
    }
    const text = String(view.state?.values?.qtext_input?.qtext_field?.value ?? "").trim();
    if (!text) {
      await ack({ response_action: "errors", errors: { qtext_input: "Answer can't be empty." } });
      return;
    }
    const bound = state.findThreadBySession(v.s);
    const ask = quesAsks.get(v.q);
    if (!bound || !ask || ask.sessionId !== v.s || !isPending(ask, "question") || !Number.isSafeInteger(v.i) ||
      v.g !== ask.generation || v.b !== questionBindingToken(ask) || (v.c ?? 0) !== ask.presentation || v.revision !== ask.draftRevision || !ask.req.questions[v.i]?.custom ||
      answerLocked(ask, v.i) || ask.response !== "pending") {
      await ack({ response_action: "errors", errors: { qtext_input: "This question changed or was already answered. Close this form and use the latest card." } }); return;
    }
    if (questionLocks.has(ask.id)) { await ack({ response_action: "errors", errors: { qtext_input: "An answer is already being submitted." } }); return; }
    const entry = pool.get(bound.thread.projectDir);
    if (!entry?.client) { await ack({ response_action: "errors", errors: { qtext_input: "OpenCode is reconnecting. Please retry shortly." } }); return; }
    const answers = structuredClone(ask.answers);
    answers[v.i] = ask.req.questions[v.i]?.multiple ? [...new Set([...answers[v.i]!, text])] : [text];
    try { if (ask.req.form) formAnswer(ask.req, answers); }
    catch (err) { await ack({ response_action: "errors", errors: { qtext_input: String((err as Error).message) } }); return; }
    ask.answers = answers;
    ask.finalized[v.i] = true;
    ask.page = 0; ask.cursor = undefined;
    try { changedQuestion(ask); }
    catch (err) {
      await ack({ response_action: "errors", errors: { qtext_input: "Couldn't save your answer. Please retry." } });
      logErr(`question save failed: ${String(err)}`); return;
    }
    await ack();
    const r = await submitAskIfComplete(ask, entry.client, oneTap(ask));
    if (r === "failed") {
      await render.post(ask.channel, ask.threadTs, "Answer not confirmed. Tap Retry submission to reconcile it before trying again.", undefined, { lane: "interactive" }).catch(() => {});
    }
  });

  const resumeQuestions: NonNullable<BridgeDeps["resumeQuestions"]> = async context => {
    const bound = state.getThread(context.threadKey);
    if (isStopping() || !bound || bound.sessionId !== context.sessionId || bound.hushed || bound.watchOnly ||
      state.bindingGeneration(context.threadKey) !== context.generation || replayAge(context.ownerTs, state.now()).decision !== "recover" ||
      (bound.recovery?.canceledThroughTs && compareTs(context.ownerTs, bound.recovery.canceledThroughTs) < 0)) return;
    const entry = pool.get(bound.projectDir);
    if (!entry?.client) return;
    const questions = await withExistingLease(entry, () => pendingQuestions(entry.client!));
    const latest = state.getThread(context.threadKey);
    if (isStopping() || state.bindingGeneration(context.threadKey) !== context.generation || !latest || latest.hushed || latest.watchOnly ||
      latest.sessionId !== context.sessionId || (latest.recovery?.canceledThroughTs && compareTs(context.ownerTs, latest.recovery.canceledThroughTs) < 0)) return;
    for (const req of questions.filter(q => q.sessionID === context.sessionId)) await onQuestion(req, true, context.ownerTs);
  };
  const questions: NonNullable<BridgeDeps["questions"]> = async (context, beforeRefresh) => {
    const known = new Map([...quesAsks.values()].filter(a => a.askTs || a.dmTs).map(a => [a.id, a.presentation]));
    await refreshPermissions();
    const asks = [...quesAsks.values()].filter(a => isPending(a, "question") &&
      ("dm" in context || context.threadKey === `${a.channel}:${a.threadTs}`));
    const status = asks.length ? ["*Pending questions:*", ...asks.map(a => {
      const record = questionStore.get(a.id);
      return `• \`${a.id}\` — ${a.finalized.filter(Boolean).length}/${a.req.questions.length} answered · thread ${record?.relocation?.thread?.status ?? a.threadDelivery.status} · DM ${record?.relocation?.dm?.status ?? a.dmDelivery.status}`;
    })].join("\n") : "No pending questions.";
    // Command feedback must land before the newly surfaced card, not after it.
    if (beforeRefresh) await beforeRefresh(status);
    for (const ask of asks) {
      for (const d of [ask.threadDelivery, ask.dmDelivery]) if (d.status === "rejected") { d.attempts = 0; d.status = "new"; }
      await onQuestion(ask.req, true);
      questionStore.update(ask.id, record => {
        for (const move of [record.relocation?.thread, record.relocation?.dm]) if (move?.status === "rejected") {
          move.status = "new"; move.attempts = 0; delete move.retryAt;
        }
      });
      const saved = questionStore.get(ask.id);
      const moving = !!saved?.relocation?.thread || !!saved?.relocation?.dm ||
        (saved?.askTs && (saved.threadPresentation ?? 0) < (saved.presentation ?? 0)) ||
        (saved?.dmTs && (saved.dmPresentation ?? 0) < (saved.presentation ?? 0));
      if (known.get(ask.id) === ask.presentation && !moving && ask.response === "pending" && activeQuestion(ask) >= 0) ask.presentation++;
      changedQuestion(ask, false);
      await Promise.all(renderAskBoth(ask));
    }
    return beforeRefresh ? undefined : status;
  };

  const permissions: NonNullable<BridgeDeps["permissions"]> = {
    list: async (context, refresh = false) => {
      if (refresh) await refreshPermissions(true);
      const records = permissionStore.list().filter(r => r.response.status !== "resolved" && permissionEligible(r) &&
        (!("threadKey" in context) || r.threadKey === context.threadKey));
      if (!records.length) return "*Permissions:* no pending requests tracked here.";
      return ["*Pending permissions:*", ...records.slice(0, 20).map(r =>
        `• \`${r.requestId}\` — ${r.permission.type} · thread ${r.thread.status}/${r.thread.format} · DM ${r.dm.status}/${r.dm.format}${r.response.status === "uncertain" ? " · reply unconfirmed" : ""}\n  \`\\permission ${r.requestId} once\` / \`\\permission ${r.requestId} deny\``),
        ...(records.length > 20 ? [`${records.length - 20} more — inspect the original threads.`] : [])].join("\n");
    },
    respond: async input => {
      // Hydrate current pending requests for pre-restart cards, never start a server.
      if (!permissionStore.list().some(r => r.requestId === input.requestId)) await refreshPermissions();
      return permissionResponder.respond(input);
    },
  };

  return {
    onPermission, onQuestion, onPermissionResolved, onQuestionResolved, interactionChanged,
    sweepQuestions, sweepInteractions, refreshPermissions, resumedQuestionEligible,
    resumeQuestions, questions, permissions, close,
  };
}
