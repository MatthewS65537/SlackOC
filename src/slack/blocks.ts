import type { OcPermission } from "../opencode/api.js";
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
