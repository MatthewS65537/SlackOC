export interface ParsedCmd {
  name: string;
  args: string;
}

/**
 * Parses leading-backslash SlackOC commands: `\model openai/gpt-5-high` →
 * { name: "model", args: "openai/gpt-5-high" }. Returns null for ordinary
 * prompt text (incl. text that starts with / — Slack slash commands are
 * untouched by design).
 */
export function parseBackslash(text: string): ParsedCmd | null {
  // `\!` (shell) is the one non-word name; its command may follow without a space (`\!ls`).
  if (text.trim().startsWith("\\!")) return { name: "!", args: text.trim().slice(2).trim() };
  const m = text.trim().match(/^\\([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m || !m[1]) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}
