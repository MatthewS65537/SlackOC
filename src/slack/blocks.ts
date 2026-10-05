import { createHash } from "node:crypto";
import type { OcPermission, OcQuestionRequest } from "../opencode/api.js";
import { esc, truncate } from "../util.js";
import { unicodeEmoji } from "./emoji.js";

export const SLACK_SECTION_LIMIT = 3000;
export const PERMISSION_ACTIONS = ["perm_once", "perm_always", "perm_reject"] as const;
export const QUESTION_ACTION_PATTERN = /^(?:question|question_skip|question_\d+_\d+)$/;

/** Bound after escaping, without leaving a split surrogate pair or Slack entity. */
export function boundedSection(text: string, limit = SLACK_SECTION_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, "").replace(/&[^;\s]*$/, "") + "…";
}

/** Use when render.dm adds its permalink; reserve the suffix BEFORE truncating. */
export function appendSectionSuffix(blocks: unknown[], suffix: string): unknown[] {
  const tail = boundedSection(suffix, 1000);
  let appended = false;
  return blocks.map((raw) => {
    const b = raw as { type?: string; text?: { type?: string; text?: string } };
    if (appended || b.type !== "section" || b.text?.type !== "mrkdwn" || typeof b.text.text !== "string") return raw;
    appended = true;
    return { ...b, text: { ...b.text, text: boundedSection(b.text.text, SLACK_SECTION_LIMIT - tail.length) + tail } };
  });
}

function blockId(id: string): string {
  return id.length <= 255 ? id : createHash("sha256").update(id).digest("hex");
}

function buttonValue(value: object): string {
  const json = JSON.stringify(value);
  if (json.length > 2000) throw new Error("Slack button value exceeds 2000 characters");
  return json;
}

/** Full IDs only. Never truncate an executable command or a button identity. */
export function validPermissionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(id);
}

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
  g?: number; // binding generation, omitted only on legacy cards
}

function permissionSummary(perm: OcPermission): string {
  const lines = [":rotating_light: *OpenCode wants permission*", `*${esc(perm.type)}*: ${esc(perm.title)}`];
  if (perm.pattern) {
    const p = Array.isArray(perm.pattern) ? perm.pattern.join(", ") : perm.pattern;
    lines.push(`pattern: \`${esc(truncate(p, 180))}\``);
  }
  const meta = perm.metadata ?? {};
  if (typeof meta.command === "string") lines.push(`command: \`${esc(truncate(meta.command, 250))}\``);
  if (typeof meta.filePath === "string") lines.push(`file: \`${esc(meta.filePath)}\``);

  return boundedSection(unicodeEmoji(lines.join("\n")));
}

export function permissionCommands(id: string): string {
  if (!validPermissionId(id)) return "Use `\\permissions` to inspect this request; its ID cannot be used in a reply command.";
  return `Reply \`\\permission ${id} once\` to approve once, \`\\permission ${id} deny\` to deny, or \`\\permission ${id} always\` for persistent approval.\nUse \`\\permissions\` to list pending requests.`;
}

/** Text-only post body, including usable exact commands even if the card failed. */
export function permissionFallbackText(perm: OcPermission, threadLink?: string): string {
  const suffix = `\nRequest: ${esc(boundedSection(perm.id, 255))}\n${permissionCommands(perm.id)}` +
    (threadLink ? `\n${boundedSection(threadLink, 500)}` : "");
  return boundedSection(permissionSummary(perm), SLACK_SECTION_LIMIT - suffix.length) + suffix;
}

export function permissionBlocks(perm: OcPermission, generation?: number): unknown[] {
  if (!validPermissionId(perm.id) || !validPermissionId(perm.sessionID)) throw new Error("Invalid permission identity");
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) throw new Error("Invalid permission generation");
  const mk = (label: string, style: string | undefined, r: PermButtonValue["r"]) => ({
    type: "button",
    text: { type: "plain_text", text: label },
    ...(style ? { style } : {}),
    action_id: `perm_${r}`,
    value: buttonValue({ s: perm.sessionID, p: perm.id, r, ...(generation === undefined ? {} : { g: generation }) } satisfies PermButtonValue),
  });

  return [
    { type: "section", text: { type: "mrkdwn", text: permissionSummary(perm) } },
    {
      type: "actions",
      block_id: blockId(`perm_${perm.id}`),
      elements: [mk("✓ Approve once", "primary", "once"), mk("Always allow", undefined, "always"), mk("✕ Deny", "danger", "reject")],
    },
    { type: "section", text: { type: "mrkdwn", text: `Request: ${esc(perm.id)}\nButtons not working? ${permissionCommands(perm.id)}` } },
  ];
}

export function permissionResultText(r: PermButtonValue["r"], actor: string): string {
  const map: Record<PermButtonValue["r"], string> = {
    once: `:white_check_mark: Approved (once) by <@${actor}>`,
    always: `:white_check_mark: Always allowed by <@${actor}>`,
    reject: `:no_entry: Denied by <@${actor}>`,
  };
  return unicodeEmoji(`${map[r]} — response confirmed.`);
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
  g?: number; // binding generation, omitted only on legacy cards
  b?: string; // full binding token; generations are thread-local
  c?: number; // question-card presentation, separate from binding generation
}

/** Payload for the multi-select "Submit selection" and free-text buttons. */
export interface QuestionActionValue {
  s: string; // sessionId
  q: string; // requestId
  i: number; // question index
  g?: number; // binding generation, omitted only on legacy cards
  b?: string;
  c?: number;
}

/**
 * Block Kit for a parked question. `answers` is the current matrix (one
 * label-array per question, in order); `finalized` marks which questions are
 * locked in (single-select tap, multi-select submit, or free-text entry) —
 * finalized questions collapse to a ✅ line while the rest keep their buttons.
 * Toggling/paging updates the current card; advancing may post a fresh card.
 * Defaults `finalized` to "has an answer" so single-select callers
 * (and tests) can omit it. Submission states lock answer-changing controls;
 * uncertain submissions offer reconciliation through the existing retry action.
 */
export function questionBlocks(req: OcQuestionRequest, answers: string[][], finalized?: boolean[], page = 0,
  context?: { generation?: number; binding?: string; presentation?: number; response?: "pending" | "answering" | "uncertain" | "resolved" }): unknown[] {
  const generation = context?.generation;
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) throw new Error("Invalid question generation");
  if (context?.presentation !== undefined && (!Number.isSafeInteger(context.presentation) || context.presentation < 0)) throw new Error("Invalid question presentation");
  const payload = (i: number): QuestionActionValue => ({ s: req.sessionID, q: req.id, i,
    ...(generation === undefined ? {} : { g: generation }), ...(context?.binding ? { b: context.binding } : {}),
    ...(context?.presentation === undefined ? {} : { c: context.presentation }) });
  const n = req.questions.length;
  const done = finalized ?? answers.map((a) => a.length > 0);
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: "❓ *OpenCode has a question*" } },
  ];
  if (context?.response === "answering") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "⏳ Sending your response… Waiting for confirmation." } });
    return blocks;
  }
  if (context?.response === "uncertain") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "⚠️ Submission unconfirmed. Your response may already have been received. Check its status before retrying." } });
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Check submission / retry" },
      action_id: "qretry", value: buttonValue(payload(0)) }] });
    return blocks;
  }
  if (context?.response === "resolved") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "This question is no longer pending." } });
    return blocks;
  }
  // A bounded wizard keeps arbitrarily long forms within Slack's 50-block cap.
  const current = req.questions.findIndex((q, i) => !done[i] && !(q.field && "hidden" in q.field && q.field.hidden));
  if (current > 0) blocks.push({ type: "section", text: { type: "mrkdwn",
    text: boundedSection(`✅ ${done.filter(Boolean).length}/${n} answered: ${esc(answers.slice(0, current).flat().join(", "))}`) } });
  req.questions.forEach((q, qi) => {
    if (qi !== current) return;
    const picked = answers[qi] ?? [];
    const lines = [`*Q${qi + 1}/${n} — ${esc(q.header)}*`, esc(q.question)];
    const offset = Math.max(0, Math.min(Math.floor(page), Math.ceil(q.options.length / 20) - 1)) * 20;
    const options = q.options.slice(offset, offset + 20);
    options.forEach((o, oi) => {
      lines.push(`${offset + oi + 1}. ${esc(o.label)}${o.description ? ` — ${esc(o.description)}` : ""}`);
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: boundedSection(lines.join("\n")) } });
    // One button per option; Slack caps an actions row at 5, so pathological
    // >5-option questions spill into additional rows. Multi-select highlights
    // already-toggled options (primary) and appends a "Submit selection" row;
    // Free-text appends a dedicated custom-answer button that opens a modal.
    const optionButtons = options.map((o, oi) => {
      const b: Record<string, unknown> = {
        type: "button",
        text: { type: "plain_text", text: boundedSection(o.label || `Option ${oi + 1}`, 75) },
        action_id: `question_${qi}_${offset + oi}`,
        value: buttonValue({ ...payload(qi), a: offset + oi } satisfies QuestionButtonValue),
      };
      if (q.multiple && picked.includes(o.value ?? o.label)) b.style = "primary";
      return b;
    });
    for (let start = 0; start < optionButtons.length; start += 5) {
      blocks.push({
        type: "actions",
        block_id: blockId(`ques_${req.id}_${qi}_${Math.floor(start / 5)}`),
        elements: optionButtons.slice(start, start + 5),
      });
    }
    if (q.multiple) {
      blocks.push({
        type: "actions",
        block_id: blockId(`ques_submit_${req.id}_${qi}`),
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Submit selection" },
            style: "primary",
            action_id: "qsubmit",
            value: buttonValue(payload(qi)),
          },
        ],
      });
    }
    if (q.options.length > 20) {
      blocks.push({ type: "actions", elements: [-1, 1].filter(direction => offset + direction * 20 >= 0 && offset + direction * 20 < q.options.length)
        .map(direction => ({ type: "button", action_id: direction < 0 ? "qpage_prev" : "qpage_next",
          text: { type: "plain_text", text: direction < 0 ? "Previous choices" : "More choices" },
          value: buttonValue({ ...payload(qi), page: offset / 20 + direction }) })) });
    }
    if (q.field?.type === "external") {
      blocks.push({ type: "actions", elements: [{ type: "button", action_id: "qexternal",
        text: { type: "plain_text", text: "Open form" }, url: q.field.url }] });
    }
    if (q.custom) {
      blocks.push({
        type: "actions",
        block_id: blockId(`ques_text_${req.id}_${qi}`),
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Type your own answer" },
            action_id: "qtext",
            value: buttonValue(payload(qi)),
          },
        ],
      });
    }
    if (q.field && q.field.type !== "external" && !q.field.required) blocks.push({ type: "actions", elements: [{
      type: "button", action_id: "qomit", text: { type: "plain_text", text: "Use default / leave empty" },
      value: buttonValue(payload(qi)),
    }] });
  });
  if (current < 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: boundedSection(`✅ Answers ready: ${esc(answers.flat().join(", "))}`) } });
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Retry submission" },
      action_id: "qretry", value: buttonValue(payload(0)) },
      { type: "button", text: { type: "plain_text", text: "Edit answers" }, action_id: "qedit", value: buttonValue(payload(0)) }] });
  }
  // Skip (reject) row — only while something is still open.
  if (req.questions.some((_, qi) => !done[qi])) {
    blocks.push({
      type: "actions",
      block_id: blockId(`ques_skip_${req.id}`),
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Skip (reject)" },
          style: "danger",
          action_id: "question_skip",
          value: buttonValue({ ...payload(0), a: -1 } satisfies QuestionButtonValue),
        },
      ],
    });
  }
  if (blocks.length > 50) throw new Error("Question card exceeds Slack's 50-block limit");
  return blocks;
}
