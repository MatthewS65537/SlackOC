import { shipCardBlocks } from "../slack/blocks.js";
import { getView } from "../slack/render.js";
import type { CmdDef } from "./registry.js";

/**
 * `\ship`: posts a card with the 🚀 Ship… button. Modals need a click's
 * trigger_id, so a text command can't open the panel itself; the panel and
 * the git work live in slack/diff-view.ts and ship.ts.
 */
export const shipCommand: CmdDef = {
  name: "ship",
  aliases: ["commit", "pr"],
  usage: "\\ship",
  summary: "Commit this session's changes; push and draft PR are opt-in",
  detail: "Opens a panel: branch, files, commit message, and Push / Draft PR checkboxes (off by default). SlackOC runs git and `gh` itself, no model. Pushing to main/master needs `ship.allowMainPush` in the config.",
  async run(ctx) {
    const th = ctx.thread;
    if (!th) throw new Error("no session bound to this thread yet — send a prompt first");
    if (getView(th.sessionId)) throw new Error("a run is active in this thread — ship after it finishes");
    const text = "🚀 Ship this thread's changes: pick the branch, files and message. Push and draft PR stay off unless you tick them.";
    await ctx.postToThread(text, shipCardBlocks(text, th.sessionId));
  },
};
