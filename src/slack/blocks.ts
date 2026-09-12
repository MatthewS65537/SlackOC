import type { OcPermission, OcQuestionRequest } from "../opencode/api.js";
import { esc, truncate } from "../util.js";

/** Action id for the completion-DM "View diff" button (handled in start.ts). Value = sessionId. */
export const VIEW_DIFF_ACTION = "view_diff";

/** Completion-DM blocks: the summary section plus a one-tap diff buttons row. The plain-text arg carries the same content for notifications/fallback. */
export function viewDiffBlocks(text: string, sessionId: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: `vdiff_${sessionId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📄 View diff" },
          action_id: VIEW_DIFF_ACTION,
          value: sessionId,
        },
      ],
    },
  ];
}

export interface PermButtonValue {
  s: string; // sessionId
  p: string; // permissionId
  r: "once" | "always" | "reject";
}

export function permissionBlocks(perm: OcPermission): unknown[] {
  const lines = [":rotating_light: *OpenCode wants permission*", `*${esc(perm.type)}*: ${esc(perm.title)}`];
  if (perm.pattern) {
    const p = Array.isArray(perm.pattern) ? perm.pattern.join(", ") : perm.pattern;
    lines.push(`pattern: \`${esc(truncate(p, 180))}\``);
  }
  const meta = perm.metadata ?? {};
  if (typeof meta.command === "string") lines.push(`command: \`${esc(truncate(meta.command, 250))}\``);
  if (typeof meta.filePath === "string") lines.push(`file: \`${esc(meta.filePath)}\``);

  const mk = (label: string, style: string | undefined, r: PermButtonValue["r"]) => ({
    type: "button",
    text: { type: "plain_text", text: label },
    ...(style ? { style } : {}),
    action_id: "perm",
    value: JSON.stringify({ s: perm.sessionID, p: perm.id, r } satisfies PermButtonValue),
  });

  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      block_id: `perm_${perm.id}`,
      elements: [mk("Approve once", "primary", "once"), mk("Always allow", undefined, "always"), mk("Deny", "danger", "reject")],
    },
  ];
}

export function permissionResultText(r: PermButtonValue["r"], actor: string): string {
  const map: Record<PermButtonValue["r"], string> = {
    once: `:white_check_mark: Approved (once) by <@${actor}>`,
    always: `:white_check_mark: Always allowed by <@${actor}>`,
    reject: `:no_entry: Denied by <@${actor}>`,
  };
  return `${map[r]} — OpenCode continuing.`;
}

/**
 * Button payload for a question option. Labels are resolved server-side from
 * the stored ask (quesAsks), so the value stays tiny (≪ Slack's 2000-char cap)
 * regardless of how long the option text is. `a` = -1 is the Skip (reject) row.
 */
export interface QuestionButtonValue {
  s: string; // sessionId
  q: string; // requestId
  i: number; // question index
  a: number; // option index, or -1 for Skip (reject)
}

/**
 * Block Kit for a parked question. `answers` is the current matrix (one
 * label-array per question, in order) so already-answered questions collapse
 * to a ✅ line while the rest keep their buttons — regenerated in place on
 * every tap, the same technique the permission result update uses.
 */
export function questionBlocks(req: OcQuestionRequest, answers: string[][]): unknown[] {
  const n = req.questions.length;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: "❓ *OpenCode has a question*" } },
  ];
  req.questions.forEach((q, qi) => {
    const picked = answers[qi];
    if (picked && picked.length) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `✅ *Q${qi + 1}/${n} — ${esc(q.header)}*: ${esc(picked.join(", "))}` },
      });
      return;
    }
    const lines = [`*Q${qi + 1}/${n} — ${esc(q.header)}*`, esc(q.question)];
    q.options.forEach((o, oi) => {
      lines.push(`${oi + 1}. ${esc(o.label)}${o.description ? ` — ${esc(o.description)}` : ""}`);
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } });
    // One button per option; Slack caps an actions row at 5, so pathological
    // >5-option questions spill into additional rows.
    const buttons = q.options.map((o, oi) => ({
      type: "button",
      text: { type: "plain_text", text: o.label },
      action_id: "question",
      value: JSON.stringify({ s: req.sessionID, q: req.id, i: qi, a: oi } satisfies QuestionButtonValue),
    }));
    for (let start = 0; start < buttons.length; start += 5) {
      blocks.push({
        type: "actions",
        block_id: `ques_${req.id}_${qi}_${Math.floor(start / 5)}`,
        elements: buttons.slice(start, start + 5),
      });
    }
  });
  // Skip (reject) row — only while something is still open.
  if (req.questions.some((q, qi) => !(answers[qi]?.length))) {
    blocks.push({
      type: "actions",
      block_id: `ques_skip_${req.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Skip (reject)" },
          style: "danger",
          action_id: "question",
          value: JSON.stringify({ s: req.sessionID, q: req.id, i: 0, a: -1 } satisfies QuestionButtonValue),
        },
      ],
    });
  }
  return blocks;
}
