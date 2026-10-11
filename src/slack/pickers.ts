import type { App } from "@slack/bolt";
import { PICK_ACTION_PATTERN } from "./blocks.js";
import { runPickedCommand, type BridgeDeps } from "./router.js";
import { enqueue } from "./queue.js";
import { logErr } from "../log.js";
import { configProviders, type ProvidersInfo } from "../opencode/client.js";
import { modelOptionGroups, orderedModels, readFavorites } from "../opencode/favorites.js";
import { sourceThreadTs } from "./source-thread.js";

/** Commands a picker card may run; option values are checked against this. */
const PICKED = /^\\(model|agent|cd|resume) \S/;

/**
 * C1: one handler for every dropdown card. The chosen option's value is the
 * command text; the card collapses to a one-line confirmation, then the
 * command runs through the same path as typing it in the card's parent thread.
 */
export function registerPickerActions(app: App, deps: { bridge: BridgeDeps; ownerSlackUserId: string; isStopping: () => boolean }): void {
  app.action(PICK_ACTION_PATTERN, async ({ ack, body, action, respond }) => {
    await ack();
    if (deps.isStopping()) return;
    if (body.user.id !== deps.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can use these controls.", response_type: "ephemeral", replace_original: false }).catch(() => {});
      return;
    }
    const value = (action as { selected_option?: { value?: string; text?: { text?: string } } }).selected_option;
    const msg = (body as { container?: { channel_id?: string; message_ts?: string } }).container;
    const root = sourceThreadTs(body);
    if (!value?.value || !PICKED.test(value.value) || !msg?.channel_id || !msg.message_ts || !root) return;
    const channel = msg.channel_id, cardTs = msg.message_ts;
    await enqueue(() => app.client.chat.update({ channel, ts: cardTs, text: `✓ ${value.text?.text ?? value.value}`, blocks: [] }),
      { channel, method: "chat.update", lane: "interactive", thread: root })
      .catch(err => logErr(`picker card update failed: ${String(err)}`));
    await runPickedCommand(deps.bridge, channel, root, cardTs, value.value)
      .catch(err => logErr(`picked command failed (${value.value}): ${String(err)}`));
  });
}

/** Per-project catalog cache: Slack drops an options response after 3s, and every keystroke asks again. */
const CATALOG_TTL_MS = 60_000;
const catalogs = new Map<string, { info: ProvidersInfo; at: number }>();
/** Card ts → thread root, for suggestion payloads that omit the source message. */
const cardRoots = new Map<string, string>();

/**
 * Options for the `\model` search card (external_select `pick_model`):
 * ★ favorites first, filtered by what the owner types. The project comes from
 * the card's parent thread, falling back like `\model` does when that thread
 * is unbound. A card whose parent can't be established gets no options rather
 * than another project's catalog.
 */
export function registerModelSearch(app: App, deps: { bridge: BridgeDeps; ownerSlackUserId: string }): void {
  app.options("pick_model", async ({ ack, body }) => {
    try {
      if (body.user.id !== deps.ownerSlackUserId) return await ack({ options: [] });
      const { state, pool, cwd } = deps.bridge;
      const c = (body as { container?: { channel_id?: string; message_ts?: string } }).container;
      if (!c?.channel_id || !c.message_ts) return await ack({ options: [] });
      const root = sourceThreadTs(body) ?? await cardRoot(app, c.channel_id, c.message_ts);
      if (!root) return await ack({ options: [] });
      const thread = state.getThread(state.threadKey(c.channel_id, root));
      const dir = thread?.projectDir ?? state.defaultDir(c.channel_id, cwd);
      let hit = catalogs.get(dir);
      if (!hit || Date.now() - hit.at > CATALOG_TTL_MS) {
        hit = { info: await configProviders((await pool.ensure(dir)).client!), at: Date.now() };
        catalogs.set(dir, hit);
      }
      await ack({ option_groups: modelOptionGroups(orderedModels(hit.info, readFavorites()), body.value ?? "") } as never);
    } catch (err) {
      logErr(`model search failed: ${String(err)}`);
      await ack({ options: [] }).catch(() => {});
    }
  });
}

/** The card's own history entry names its parent; cached since a card never moves. */
async function cardRoot(app: App, channel: string, cardTs: string): Promise<string | undefined> {
  const key = `${channel}:${cardTs}`;
  const known = cardRoots.get(key);
  if (known) return known;
  const page = await enqueue(() => app.client.conversations.replies({ channel, ts: cardTs, limit: 1 }),
    { channel, method: "conversations.replies", lane: "interactive" });
  const first = page.messages?.[0];
  const root = first?.thread_ts ?? (first?.ts === cardTs ? cardTs : undefined);
  if (!root) return;
  if (cardRoots.size >= 500) cardRoots.delete(cardRoots.keys().next().value!);
  cardRoots.set(key, root);
  return root;
}
