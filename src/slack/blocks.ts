import { createHash } from "node:crypto";
import type { OcPermission, OcQuestionRequest } from "../opencode/api.js";
import { visibleQuestions } from "../opencode/v2.js";
import { esc, truncate } from "../util.js";
import { unicodeEmoji } from "./emoji.js";

const SLACK_SECTION_LIMIT = 3000;
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

/** Action id for the "View changes" button (finalize line, \diff, completion DMs) — opens the diff modal in diff-view.ts. Value = sessionId. */
export const VIEW_DIFF_ACTION = "view_diff";

/** A summary section plus a one-tap "View changes" button. The plain-text arg carries the same content for notifications/fallback. */
export function viewDiffBlocks(text: string, sessionId: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: `vdiff_${sessionId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📄 View changes" },
          action_id: VIEW_DIFF_ACTION,
          value: sessionId,
        },
      ],
    },
  ];
}

/** \undo card buttons (run-controls.ts). Value = JSON RevertCardValue. */
export const REVERT_KEEP_ACTION = "revert_keep";
export const REVERT_CLEAR_ACTION = "revert_clear";
export interface RevertCardValue { s: string; m: string; n: number } // session, staged boundary message, turns

/** The \undo card: what was rewound plus Keep / Put it back. */
export function revertCardBlocks(text: string, value: RevertCardValue): unknown[] {
  const v = buttonValue(value);
  return [
    { type: "section", text: { type: "mrkdwn", text: boundedSection(text) } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Keep" }, action_id: REVERT_KEEP_ACTION, value: v },
      { type: "button", text: { type: "plain_text", text: "Put it back" }, action_id: REVERT_CLEAR_ACTION, value: v },
    ] },
  ];
}

/** Buttons on a queued prompt's "⏳ Queued" ack (run-controls.ts). Value = JSON QueuedCardValue. */
export const INBOX_STEER_ACTION = "inbox_steer";
export const INBOX_CANCEL_ACTION = "inbox_cancel";
export interface QueuedCardValue { c: string; t: string; u: string } // channel, thread root, user message ts

export function queuedAckBlocks(text: string, value: QueuedCardValue): unknown[] {
  const v = buttonValue(value);
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Steer now" }, action_id: INBOX_STEER_ACTION, value: v },
      { type: "button", text: { type: "plain_text", text: "Cancel" }, action_id: INBOX_CANCEL_ACTION, value: v },
    ] },
  ];
}

export interface PermButtonValue {
  s: string; // sessionId
  p: string; // permissionId
  r: "once" | "always" | "reject";
  g: number; // binding generation
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

function permissionCommands(id: string): string {
  if (!validPermissionId(id)) return "Use `\\permissions` to inspect this request; its ID cannot be used in a reply command.";
  return `Reply \`\\permission ${id} once\` to approve once, \`\\permission ${id} deny\` to deny, or \`\\permission ${id} always\` for persistent approval.\nUse \`\\permissions\` to list pending requests.`;
}

/** Text-only post body, including usable exact commands even if the card failed. */
export function permissionFallbackText(perm: OcPermission): string {
  const suffix = `\nRequest: ${esc(boundedSection(perm.id, 255))}\n${permissionCommands(perm.id)}`;
  return boundedSection(permissionSummary(perm), SLACK_SECTION_LIMIT - suffix.length) + suffix;
}

export function permissionBlocks(perm: OcPermission, generation: number): unknown[] {
  if (!validPermissionId(perm.id) || !validPermissionId(perm.sessionID)) throw new Error("Invalid permission identity");
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid permission generation");
  const mk = (label: string, style: string | undefined, r: PermButtonValue["r"]) => ({
    type: "button",
    text: { type: "plain_text", text: label },
    ...(style ? { style } : {}),
    action_id: `perm_${r}`,
    value: buttonValue({ s: perm.sessionID, p: perm.id, r, g: generation } satisfies PermButtonValue),
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
  g?: number; // binding generation; questionGuard rejects cards without it
  b?: string; // full binding token; generations are thread-local
  c?: number; // question-card presentation, separate from binding generation
}

/** Payload for the multi-select "Submit selection" and free-text buttons. */
export interface QuestionActionValue {
  s: string; // sessionId
  q: string; // requestId
  i: number; // question index
  g?: number; // binding generation; questionGuard rejects cards without it
  b?: string;
  c?: number;
  r?: 1; // qnav_next only: leave the cursor and return to the first unfinished question / review step
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
 *
 * `context.shown` is the question on screen (the Back/Next cursor; -1 = the
 * review step). It defaults to the first unfinished visible question. Forms
 * with >1 visible question get a `◀ Back` (qnav_prev) / `Next ▶` (qnav_next,
 * only once the shown question is finalized) row whose payload `i` is the
 * target. Picked options render `primary` so a revisited answer is visible.
 * When everything is answered the card becomes a review step: an answer
 * summary with `Submit answers` (qsubmit_all), Back and `Edit answers` (qedit).
 */
export function questionBlocks(req: OcQuestionRequest, answers: string[][], finalized?: boolean[], page = 0,
  context?: { generation?: number; binding?: string; presentation?: number; response?: "pending" | "answering" | "uncertain" | "resolved"; shown?: number }): unknown[] {
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
  const visible = visibleQuestions(req, answers);
  const visibleIdx = req.questions.flatMap((_, i) => visible[i] ? [i] : []);
  const current = context?.shown !== undefined && (context.shown < 0 || visible[context.shown]) ? context.shown
    : req.questions.findIndex((_, i) => !done[i] && visible[i]);
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
      if (picked.includes(o.value ?? o.label)) b.style = "primary";
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
  const back = current < 0 ? visibleIdx.at(-1) : visibleIdx.filter(i => i < current).at(-1);
  const backButton = back === undefined ? [] : [{ type: "button", action_id: "qnav_prev",
    text: { type: "plain_text", text: "◀ Back" }, value: buttonValue(payload(back)) }];
  if (current >= 0 && visibleIdx.length > 1) {
    // Next jumps to the following visible question, or (from the last one) leaves the cursor.
    const next = visibleIdx.find(i => i > current);
    const nav = [...backButton, ...(done[current] ? [{ type: "button", action_id: "qnav_next", text: { type: "plain_text", text: "Next ▶" },
      value: buttonValue(next === undefined ? { ...payload(current), r: 1 } : payload(next)) }] : [])];
    if (nav.length) blocks.push({ type: "actions", block_id: blockId(`ques_nav_${req.id}`), elements: nav });
  }
  if (current < 0) {
    // Review step: nothing is sent until the owner confirms (single-question asks submit on tap).
    const lines = visibleIdx.map(i => `• *${esc(req.questions[i]!.header)}*: ${esc(answers[i]?.join(", ") || "(default)")}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: boundedSection(["✅ *Answers:*", ...lines].join("\n")) } });
    blocks.push({ type: "actions", block_id: blockId(`ques_review_${req.id}`), elements: [{ type: "button", text: { type: "plain_text", text: "Submit answers" },
      style: "primary", action_id: "qsubmit_all", value: buttonValue(payload(0)) },
      ...(visibleIdx.length > 1 ? backButton : []),
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

export interface PlanTodo { content: string; status: string }

/** The todos array from a `todowrite` call's input, or null when it isn't one. */
export function planTodos(input: unknown): PlanTodo[] | null {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap(t => t && typeof t === "object" && typeof (t as PlanTodo).content === "string"
    ? [{ content: (t as PlanTodo).content, status: String((t as PlanTodo).status ?? "pending") }] : []);
}

const PLAN_GLYPH: Record<string, string> = { completed: "☑", in_progress: "◐", cancelled: "☒" };

/** Live plan card (A1): a "3 of 5" header over ☐ / ◐ / ☑ rows; cancelled rows are struck through. */
export function planText(todos: PlanTodo[], max = 30): string {
  const done = todos.filter(t => t.status === "completed").length;
  const rows = todos.slice(0, max).map(t => {
    const text = esc(truncate(t.content.replace(/\s+/g, " ").trim(), 150));
    const shown = t.status === "in_progress" ? `*${text}*` : t.status === "cancelled" ? `~${text}~` : text;
    return `${PLAN_GLYPH[t.status] ?? "☐"} ${shown}`;
  });
  if (todos.length > max) rows.push(`_…and ${todos.length - max} more_`);
  return [`📋 *Plan* · ${done} of ${todos.length} done`, ...rows].join("\n");
}

export const PICK_ACTION_PATTERN = /^pick_(model|agent|project|session)$/;
export interface PickOption { text: string; value: string }

/**
 * Dropdown card (C1) above a command's numbered list. Each option's value is
 * the command it runs. Null past Slack's 100-option cap: the text list stays.
 */
export function pickerBlocks(kind: "agent" | "project" | "session", prompt: string,
  groups: Array<{ label: string; options: PickOption[] }>, current?: string): unknown[] | null {
  const fit = groups.map(g => ({ label: g.label, options: g.options.filter(o => o.value.length <= 150) })).filter(g => g.options.length);
  const total = fit.reduce((n, g) => n + g.options.length, 0);
  if (!total || total > 100) return null;
  const opt = (o: PickOption) => ({ text: { type: "plain_text", text: truncate(o.text, 75) }, value: o.value });
  const initial = fit.flatMap(g => g.options).find(o => o.value === current);
  const select = {
    type: "static_select", action_id: `pick_${kind}`, placeholder: { type: "plain_text", text: `Choose a ${kind}` },
    ...(fit.length > 1
      ? { option_groups: fit.map(g => ({ label: { type: "plain_text", text: truncate(g.label, 75) }, options: g.options.map(opt) })) }
      : { options: fit[0]!.options.map(opt) }),
    ...(initial ? { initial_option: opt(initial) } : {}),
  };
  return [{ type: "section", text: { type: "mrkdwn", text: prompt }, accessory: select }];
}

/**
 * `\model` card: a type-ahead external_select whose options come from the
 * `pick_model` options handler (pickers.ts). Selection runs through the shared
 * PICK_ACTION_PATTERN handler like every other picker card.
 */
export function modelSearchBlocks(prompt: string, initialOption?: unknown): unknown[] {
  return [{ type: "section", text: { type: "mrkdwn", text: prompt }, accessory: {
    type: "external_select", action_id: "pick_model", min_query_length: 0,
    placeholder: { type: "plain_text", text: "Search models…" },
    ...(initialOption ? { initial_option: initialOption } : {}),
  } }];
}
