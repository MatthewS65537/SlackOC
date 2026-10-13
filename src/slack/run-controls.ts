import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import type { ServerPool } from "../opencode/server.js";
import { inboxCancel, inboxUpdate, revertClear, revertCommit, sessionGet } from "../opencode/client.js";
import { INBOX_CANCEL_ACTION, INBOX_STEER_ACTION, REVERT_CLEAR_ACTION, REVERT_KEEP_ACTION, type QueuedCardValue, type RevertCardValue } from "./blocks.js";
import { getView } from "./render.js";
import { enqueue } from "./queue.js";
import { sourceThreadTs } from "./source-thread.js";
import { logErr } from "../log.js";

const turnsWord = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

/**
 * Buttons that act on a thread's live session: the \undo card (Keep / Put it
 * back) and a queued prompt's card (Steer now / Cancel). Owner-only; each card
 * is edited in place and loses its buttons.
 */
export function registerRunControls(app: App, deps: {
  ownerSlackUserId: string; state: StateStore; pool: ServerPool; isStopping: () => boolean;
}): void {
  const { state, pool } = deps;
  /** Owner gate + the card being clicked; null when the click must be ignored. */
  const card = async (body: { user: { id: string } }, respond: (r: object) => Promise<unknown>) => {
    if (deps.isStopping()) return null;
    if (body.user.id !== deps.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can use these controls.", response_type: "ephemeral", replace_original: false }).catch(() => {});
      return null;
    }
    const msg = (body as { container?: { channel_id?: string; message_ts?: string } }).container;
    const root = sourceThreadTs(body);
    if (!msg?.channel_id || !msg.message_ts || !root) return null;
    const channel = msg.channel_id, cardTs = msg.message_ts;
    const edit = (text: string) => enqueue(() => app.client.chat.update({ channel, ts: cardTs, text, blocks: [] }),
      { channel, method: "chat.update", lane: "interactive", thread: root })
      .catch(err => logErr(`run control card update failed: ${String(err)}`));
    return { channel, root, edit };
  };
  const failed = async (respond: (r: object) => Promise<unknown>, what: string, err: unknown) => {
    const busy = (err as { _tag?: string })?._tag === "SessionBusyError";
    if (!busy) logErr(`${what} failed: ${String((err as Error)?.message ?? err)}`);
    await respond({ text: busy ? "A run is in progress. Use `\\stop` first." : `That didn't work: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      response_type: "ephemeral", replace_original: false }).catch(() => {});
  };

  app.action(new RegExp(`^(?:${REVERT_KEEP_ACTION}|${REVERT_CLEAR_ACTION})$`), async ({ ack, body, action, respond }) => {
    await ack();
    const c = await card(body, respond);
    const a = action as { action_id?: string; value?: string };
    let v: RevertCardValue;
    try { v = JSON.parse(a.value ?? ""); } catch { return; }
    if (!c || !v?.s || !v.m) return;
    const { channel, root, edit } = c;
    try {
      const thread = state.getThread(state.threadKey(channel, root));
      const client = thread?.sessionId === v.s ? (await pool.ensure(thread.projectDir)).client! : null;
      // A newer \undo moves the boundary, and a new prompt commits it: an old card must not act on either.
      if (!client || (await sessionGet(client, v.s)).revert?.messageID !== v.m) {
        await edit("Superseded. Nothing staged at this point anymore.");
        return;
      }
      if (a.action_id === REVERT_KEEP_ACTION) {
        await revertCommit(client, v.s);
        await edit(`↩ Undone ${turnsWord(v.n)}, kept.`);
      } else {
        await revertClear(client, v.s);
        await edit(`↪ Put back ${turnsWord(v.n)} and their file edits.`);
      }
    } catch (err) {
      await failed(respond, `undo card (${v.s})`, err);
    }
  });

  app.action(new RegExp(`^(?:${INBOX_STEER_ACTION}|${INBOX_CANCEL_ACTION})$`), async ({ ack, body, action, respond }) => {
    await ack();
    const c = await card(body, respond);
    const a = action as { action_id?: string; value?: string };
    let v: QueuedCardValue;
    try { v = JSON.parse(a.value ?? ""); } catch { return; }
    if (!c || !v?.c || !v.t || !v.u) return;
    const key = state.threadKey(v.c, v.t);
    const thread = state.getThread(key);
    const sub = state.getReceipt(key, v.u)?.submission;
    // The inbox ID is the prompt's message ID, recorded before submission (router.ts sendPrompt).
    if (!thread || !sub || sub.sessionId !== thread.sessionId) {
      await c.edit("No longer queued in this thread's session.");
      return;
    }
    const steer = a.action_id === INBOX_STEER_ACTION;
    const view = getView(thread.sessionId);
    view?.noteQueuedAction(v.u, steer);
    try {
      const client = (await pool.ensure(thread.projectDir)).client!;
      if (steer) await inboxUpdate(client, thread.sessionId, sub.messageId, "steer");
      else await inboxCancel(client, thread.sessionId, sub.messageId);
      await c.edit(steer ? "➡️ Steered into the current run." : "✖ Cancelled, won't run.");
    } catch (err) {
      view?.noteQueuedAction(v.u, false);
      if ((err as { _tag?: string })?._tag === "ConflictError") await c.edit("Already running.");
      else await failed(respond, `queued ${steer ? "steer" : "cancel"} (${thread.sessionId})`, err);
    }
  });
}
