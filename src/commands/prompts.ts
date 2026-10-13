/**
 * D1: saved prompts — `\save`, `\run`, `\saved`, `\unsave`. A known `\run`
 * never reaches its CmdDef: the router expands it (expandSavedPrompt) and
 * takes the normal prompt path, so binding, pins and queueing apply. Catch-up
 * still treats it as a command: a `\run` missed live is held (historical_command),
 * never replayed.
 */
import type { CmdCtx, CmdDef } from "./registry.js";
import { PROMPT_NAME, type PromptStore } from "../prompts.js";
import { boundedSection } from "../slack/blocks.js";
import { esc, truncate } from "../util.js";

/** ▶ buttons (Home and `\saved`). Ids carry an index: action_ids must be unique within a block. */
export const QUICK_RUN_PATTERN = /^quick_run_\d+$/;
/** Slack's element limit for one actions block. */
export const MAX_QUICK_RUN = 25;

export function quickRunBlock(names: string[]): unknown {
  return { type: "actions", elements: names.slice(0, MAX_QUICK_RUN).map((name, i) => ({
    type: "button", action_id: `quick_run_${i}`, value: name, text: { type: "plain_text", text: truncate(`▶ ${name}`, 75) },
  })) };
}

/** `\run`'s prompt: the saved text, plus a blank line and the extra text when given. Undefined for an unknown name. */
export function expandSavedPrompt(store: PromptStore, args: string): string | undefined {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(args.trim());
  const saved = m ? store.get(m[1]!) : undefined;
  if (!saved) return;
  const extra = m![2]!.trim();
  return extra ? `${saved.text}\n\n${extra}` : saved.text;
}

function store(ctx: CmdCtx): PromptStore {
  if (!ctx.prompts) throw new Error("saved prompts are unavailable here");
  return ctx.prompts;
}

const NAME_RULE = "Prompt names use a–z, 0–9, `-` and `_` (up to 32 characters).";

export const saveCommand: CmdDef = {
  name: "save",
  usage: "\\save <name> <prompt…>",
  summary: "Save a prompt under a short name",
  detail: "Saving an existing name updates it. Run it with `\\run <name>`, a ▶ button under `\\saved`, or the Home tab.",
  async run(ctx, args) {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(args);
    const name = m?.[1]?.toLowerCase() ?? "";
    const text = m?.[2]?.trim() ?? "";
    if (!PROMPT_NAME.test(name)) { await ctx.postToThread(m ? NAME_RULE : "Usage: `\\save <name> <prompt…>`"); return; }
    if (!text) { await ctx.postToThread(`Add the prompt after the name: \`\\save ${name} <prompt…>\``); return; }
    // \run sends the text as a prompt; a saved command would reach the model as plain text.
    if (text.startsWith("\\")) { await ctx.postToThread("Saved prompts are sent to OpenCode as prompts, so they can't start with `\\`."); return; }
    const verb = store(ctx).set(name, text) === "updated" ? "Updated" : "Saved";
    await ctx.postToThread(`💾 ${verb} \`${name}\`. Run it with \`\\run ${name}\`.`);
  },
};

export const runCommand: CmdDef = {
  name: "run",
  aliases: ["play"],
  usage: "\\run <name> [extra text]",
  summary: "Send a saved prompt here; extra text is appended",
  detail: "Works like typing the prompt: in a DM or a new message it starts a new session.",
  // Reached only when the router didn't expand the name: missing or unknown.
  async run(ctx, args) {
    const name = args.split(/\s/)[0]!.toLowerCase();
    if (!name) { await ctx.postToThread("Usage: `\\run <name> [extra text]`. `\\saved` lists your prompts."); return; }
    if (!PROMPT_NAME.test(name)) { await ctx.postToThread(NAME_RULE); return; }
    if (!store(ctx).get(name)) {
      await ctx.postToThread(`No saved prompt named \`${name}\`. \`\\saved\` lists them; \`\\save ${name} <prompt…>\` creates it.`);
      return;
    }
    throw new Error("`\\run` sends a prompt, so it only works from a Slack message");
  },
};

export const savedCommand: CmdDef = {
  name: "saved",
  aliases: ["prompts", "macro"],
  duringReport: true,
  usage: "\\saved",
  summary: "List saved prompts with ▶ run buttons",
  detail: "A ▶ button runs the prompt in the thread it's in. The Home tab has the same buttons; those start a new DM thread.",
  async run(ctx) {
    const list = store(ctx).list();
    if (!list.length) { await ctx.postToThread("No saved prompts yet. Save one with `\\save <name> <prompt…>`."); return; }
    // One-line previews; backticks dropped so a saved code span can't unbalance the row's mrkdwn.
    const rows = list.map(p => `• \`${p.name}\` — ${esc(truncate(p.text.replace(/\s+/g, " ").replace(/`/g, ""), 80))}`);
    const more = list.length > MAX_QUICK_RUN ? `\n_Buttons show the first ${MAX_QUICK_RUN}; run the rest with \`\\run <name>\`._` : "";
    const text = `*Saved prompts* · tap ▶ to run one in this thread\n${rows.join("\n")}${more}`;
    await ctx.postToThread(text, [
      { type: "section", text: { type: "mrkdwn", text: boundedSection(text) } },
      quickRunBlock(list.map(p => p.name)),
    ]);
  },
};

export const unsaveCommand: CmdDef = {
  name: "unsave",
  usage: "\\unsave <name>",
  summary: "Delete a saved prompt",
  async run(ctx, args) {
    const name = args.trim().toLowerCase();
    if (!PROMPT_NAME.test(name)) { await ctx.postToThread(name ? NAME_RULE : "Usage: `\\unsave <name>`"); return; }
    await ctx.postToThread(store(ctx).delete(name) ? `🗑 Deleted \`${name}\`.` : `No saved prompt named \`${name}\`. \`\\saved\` lists them.`);
  },
};
