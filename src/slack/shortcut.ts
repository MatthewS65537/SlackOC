/**
 * C3: the "Send to OpenCode" message shortcut. Any message the owner can see
 * becomes a prompt: pick a project, add instructions, choose where the run
 * lives (the message's own thread, or the owner DM when the bot can't post there).
 */
import { randomUUID } from "node:crypto";
import type { App } from "@slack/bolt";
import type { StateStore } from "../state.js";
import { handleIncomingMessage, type BridgeDeps, type SlackMsg } from "./router.js";
import type { IncomingContext } from "./recovery-policy.js";
import { enqueue } from "./queue.js";
import { canonicalDir } from "../paths.js";
import { logErr } from "../log.js";
import { truncate } from "../util.js";

export const SEND_TO_OC = "send_to_oc";
const SUBMIT = "send_to_oc_submit";

interface Source { channel: string; ts: string; threadTs?: string; text: string; files?: SlackMsg["files"] }

/**
 * Post a bot "carrier" message (top-level when `root` is undefined) that stands in
 * for the owner's message, then route `msg` as if the owner sent it there: the run
 * threads under it. Shared by this shortcut and the saved-prompt ▶ buttons (D1).
 */
export async function runViaCarrier(bridge: BridgeDeps, channel: string, root: string | undefined, carrierText: string,
  msg: Pick<SlackMsg, "text" | "files">, context: IncomingContext = { source: "live" }): Promise<void> {
  const carrier = await bridge.render.post(channel, root ?? "", carrierText, undefined, { unfurl: false, lane: "interactive" });
  await handleIncomingMessage({ channel, ts: carrier.ts, thread_ts: root ?? carrier.ts, user: bridge.config.ownerSlackUserId, ...msg },
    bridge, context);
}

/** The source channel's pin (else the current project) first, then every other known project (max 100 for a static_select). */
export function shortcutProjects(state: StateStore, cwd: string, channel: string): string[] {
  const current = canonicalDir(state.defaultDir(channel, cwd));
  return [...new Set([current, ...state.listProjects().map(p => canonicalDir(p.dir))])].slice(0, 100);
}

/** The prompt sent to OpenCode: instructions first, then the quoted message and its link. */
export function shortcutPrompt(instructions: string, text: string, permalink?: string): string {
  const quoted = text.trim() ? text.trim().split("\n").map(l => `> ${l}`).join("\n") : "> (no text; see attachments)";
  return [instructions.trim(), `Slack message${permalink ? ` (${permalink})` : ""}:`, quoted].filter(Boolean).join("\n\n");
}

export function shortcutModal(projects: string[], pendingId: string): Record<string, unknown> {
  const option = (d: string) => ({ text: { type: "plain_text", text: truncate(`${d.split("/").filter(Boolean).pop() ?? d} — ${d}`, 75) }, value: d });
  const thread = { text: { type: "plain_text", text: "This message's thread" }, value: "thread" };
  return {
    type: "modal", callback_id: SUBMIT, private_metadata: pendingId,
    title: { type: "plain_text", text: "Send to OpenCode" }, submit: { type: "plain_text", text: "Start" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "project", label: { type: "plain_text", text: "Project" },
        element: { type: "static_select", action_id: "v", options: projects.map(option), ...(projects[0] ? { initial_option: option(projects[0]) } : {}) } },
      { type: "input", block_id: "instructions", optional: true, label: { type: "plain_text", text: "Instructions" },
        element: { type: "plain_text_input", action_id: "v", multiline: true, placeholder: { type: "plain_text", text: "e.g. Find the cause and propose a fix" } } },
      { type: "input", block_id: "dest", label: { type: "plain_text", text: "Run in" },
        element: { type: "radio_buttons", action_id: "v", initial_option: thread,
          options: [thread, { text: { type: "plain_text", text: "My DM" }, value: "dm" }] } },
    ],
  };
}

export function registerShortcut(app: App, deps: { bridge: BridgeDeps; ownerSlackUserId: string; dmChannel: () => string | null; isStopping: () => boolean }): void {
  const { bridge } = deps;
  const pending = new Map<string, Source>(); // modal id → source message, until submitted

  app.shortcut(SEND_TO_OC, async ({ ack, shortcut, respond }) => {
    await ack();
    if (deps.isStopping() || shortcut.type !== "message_action") return;
    if (shortcut.user.id !== deps.ownerSlackUserId) {
      await respond({ text: "Only the paired owner can send messages to this SlackOC.", response_type: "ephemeral" }).catch(() => {});
      return;
    }
    const m = shortcut.message as { ts: string; thread_ts?: string; text?: string; files?: SlackMsg["files"] };
    const id = randomUUID();
    if (pending.size > 50) pending.delete(pending.keys().next().value!);
    pending.set(id, { channel: shortcut.channel.id, ts: m.ts, threadTs: m.thread_ts, text: m.text ?? "", files: m.files });
    await app.client.views.open({ trigger_id: shortcut.trigger_id, view: shortcutModal(shortcutProjects(bridge.state, bridge.cwd, shortcut.channel.id), id) as never })
      .catch(err => logErr(`shortcut modal failed: ${String((err as Error)?.message ?? err)}`));
  });

  app.view(SUBMIT, async ({ ack, body, view }) => {
    const source = pending.get(view.private_metadata);
    // The source lives only in this process: a restart (or >50 newer shortcuts) loses it.
    // Keep the modal open with a visible error instead of closing it as if it ran (#44).
    if (!source) {
      await ack({ response_action: "errors",
        errors: { instructions: "This form expired (SlackOC restarted). Close it and run Send to OpenCode again." } });
      return;
    }
    const values = view.state.values as Record<string, { v?: { selected_option?: { value?: string } | null; value?: string | null } }>;
    const projectDir = values.project?.v?.selected_option?.value ?? undefined;
    const instructions = values.instructions?.v?.value ?? "";
    const wantThread = values.dest?.v?.selected_option?.value !== "dm";
    // The chosen project only places a new session: a source thread already bound
    // elsewhere keeps the modal open with the conflict (the router rechecks later).
    const bound = wantThread && body.user.id === deps.ownerSlackUserId
      ? bridge.state.getThread(bridge.state.threadKey(source.channel, source.threadTs ?? source.ts)) : null;
    if (bound && projectDir && canonicalDir(bound.projectDir) !== canonicalDir(projectDir)) {
      await ack({ response_action: "errors",
        errors: { project: `This thread already runs in ${bound.projectDir}. Pick that project, or Run in: My DM for a fresh session.` } });
      return;
    }
    const pin = wantThread ? bridge.state.channelProject(source.channel) : undefined;
    if (pin && projectDir && canonicalDir(projectDir) !== pin) {
      await ack({ response_action: "errors", errors: { project: `📌 This channel is pinned to ${pin}. Pick it, or Run in: My DM.` } });
      return;
    }
    await ack();
    pending.delete(view.private_metadata);
    if (deps.isStopping() || body.user.id !== deps.ownerSlackUserId) return;
    try {
      const permalink = await app.client.chat.getPermalink({ channel: source.channel, message_ts: source.ts })
        .then(r => r.permalink, () => undefined);
      // The bot can post where it can read: one history call proves membership.
      const member = wantThread && await enqueue(() => app.client.conversations.history({ channel: source.channel, limit: 1 }),
        { channel: source.channel, method: "conversations.history", lane: "interactive" }).then(() => true, () => false);
      const dm = deps.dmChannel();
      const channel = member ? source.channel : dm;
      if (!channel) return;
      const root = member ? source.threadTs ?? source.ts : undefined;
      const note = wantThread && !member ? " (the bot isn't in that conversation, so the run lives here)" : "";
      await runViaCarrier(bridge, channel, root, `📨 Sent to OpenCode${permalink ? `: <${permalink}|message>` : ""}${note}`,
        { text: shortcutPrompt(instructions, source.text, permalink), files: source.files }, { source: "live", projectDir });
    } catch (err) {
      logErr(`send to OpenCode failed: ${String((err as Error)?.message ?? err)}`);
    }
  });
}
