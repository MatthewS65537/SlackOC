import type { App } from "@slack/bolt";
import { retryPrompt, type BridgeDeps, type IncomingOutcome } from "./router.js";
import { getView } from "./render.js";
import { modelSearchBlocks, PICK_MODEL_RETRY_ACTION, RUN_RETRY_ACTION } from "./blocks.js";
import { enqueue } from "./queue.js";
import { sourceThreadTs } from "./source-thread.js";
import { logErr } from "../log.js";
import { isPreparingWorktree, STILL_PREPARING } from "../commands/worktrees.js";

type Respond = (r: object) => Promise<unknown>;
const ephemeral = (respond: Respond, text: string) =>
  respond({ text, response_type: "ephemeral", replace_original: false }).catch(() => {});

/** Outcomes where the prompt went out, or the router already told the owner why not. */
const HANDLED = new Set<IncomingOutcome>(["accepted", "processing", "uncertain", "retry"]);

/** Why the failed prompt `promptTs` can't be resent in this thread now; null when it can. */
export function retryBlocker(d: BridgeDeps, threadKey: string, promptTs: string): string | null {
  const thread = d.state.getThread(threadKey);
  // \new/\cd rebind with fresh thread state (no lastPrompt); \resume keeps lastPrompt but switches
  // sessions, so the stored sessionId must match too: never resend into a different session.
  if (thread?.lastPrompt?.ts !== promptTs || thread.lastPrompt.sessionId !== thread.sessionId) {
    return "A newer prompt ran or the thread moved to another session since, so there's nothing to retry here.";
  }
  if (isPreparingWorktree(threadKey)) return STILL_PREPARING;
  if (getView(thread.sessionId)?.isActive || d.schedules?.busy(threadKey)) return "A run is in progress. Wait for it, or `\\stop` it first.";
  return null;
}

/** Resend the stored prompt, `cardTs` standing in for the owner's message. Returns why not, or null. */
async function resend(d: BridgeDeps, channel: string, root: string, cardTs: string, promptTs: string): Promise<string | null> {
  const key = d.state.threadKey(channel, root);
  const why = retryBlocker(d, key, promptTs);
  if (why) return why;
  const outcome = await retryPrompt(d, channel, root, cardTs, d.state.getThread(key)!.lastPrompt!.text);
  return HANDLED.has(outcome) ? null : `Couldn't retry (${outcome}). Send the prompt again instead.`;
}

/**
 * A Switch-model card's pick, after its `\model <id>` ran (pickers.ts): resend the
 * failed prompt once the thread really uses that model. Returns why not, or null.
 */
export async function retryAfterModelPick(d: BridgeDeps, channel: string, root: string, cardTs: string, promptTs: string, picked: string): Promise<string | null> {
  const model = /^\\model (\S+)$/.exec(picked)?.[1];
  if (!model || d.state.getThread(d.state.threadKey(channel, root))?.model !== model) return "The model didn't change, so the prompt wasn't retried.";
  return resend(d, channel, root, cardTs, promptTs);
}

/**
 * D3: ↻ Retry and Switch model… under a failed run's `:x:` line (render.ts). Owner-only;
 * both refuse while the thread has a run in flight and when a newer prompt superseded the
 * card. Retry resends the stored text through the router's normal prompt path; Switch
 * model posts the `\model` search card, whose pick then retries (retryAfterModelPick).
 */
export function registerRetryActions(app: App, deps: { bridge: BridgeDeps; ownerSlackUserId: string; isStopping: () => boolean }): void {
  const d = deps.bridge;
  /** Owner gate + the clicked card, checked against retryBlocker; null when the click does nothing. */
  const clicked = async (body: { user: { id: string } }, action: unknown, respond: Respond) => {
    if (deps.isStopping()) return null;
    if (body.user.id !== deps.ownerSlackUserId) {
      await ephemeral(respond, "Only the paired owner can use these controls.");
      return null;
    }
    const card = (body as { container?: { channel_id?: string; message_ts?: string } }).container;
    const root = sourceThreadTs(body);
    const promptTs = (action as { value?: string }).value;
    if (!card?.channel_id || !card.message_ts || !root || !promptTs) return null;
    const why = retryBlocker(d, d.state.threadKey(card.channel_id, root), promptTs);
    if (why) {
      await ephemeral(respond, why);
      return null;
    }
    return { channel: card.channel_id, cardTs: card.message_ts, root, promptTs, text: (body as { message?: { text?: string } }).message?.text ?? "" };
  };

  app.action(RUN_RETRY_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    const c = await clicked(body, action, respond);
    if (!c) return;
    const why = await resend(d, c.channel, c.root, c.cardTs, c.promptTs)
      .catch((err) => `Retry failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    if (why) {
      await ephemeral(respond, why);
      return;
    }
    // Buttons go only once the resend went out, so a refused retry leaves them for another try.
    // A second tap racing the resend is deduped by the card's receipt (cardTs stands in for the message).
    await enqueue(() => app.client.chat.update({ channel: c.channel, ts: c.cardTs, text: `${c.text} · ↻ retried`, blocks: [] }),
      { channel: c.channel, method: "chat.update", lane: "interactive", thread: c.root })
      .catch((err) => logErr(`retry card update failed: ${String(err)}`));
  });

  app.action(PICK_MODEL_RETRY_ACTION, async ({ ack, body, action, respond }) => {
    await ack();
    const c = await clicked(body, action, respond);
    if (!c) return;
    const blocks = modelSearchBlocks("*Switch model* — the failed prompt reruns on your pick.")
      .map((b) => ({ ...(b as object), block_id: `model_retry:${c.promptTs}` }));
    await d.render.post(c.channel, c.root, "Choose a model to retry with", blocks, { unfurl: false, lane: "interactive" })
      .catch(async (err) => {
        logErr(`switch-model card failed: ${String(err)}`);
        await ephemeral(respond, "Couldn't post the model picker. Try `\\model`, then ↻ Retry.");
      });
  });
}
