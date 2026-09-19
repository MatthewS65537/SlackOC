import type { OcPart } from "../opencode/api.js";
import { esc, truncate } from "../util.js";

/** Freeform descriptions are data, never Slack markup. */
export function safePayload(s: string): string {
  return esc(s).replace(/`/g, "ˋ").replace(/\*/g, "∗").replace(/_/g, "＿").replace(/~/g, "∼");
}

/** Code preserves ASCII identifiers/operators; neutralize only its delimiters. */
export function safeCodePayload(s: string, fenced = false): string {
  return esc(s).replace(fenced ? /`{3}/g : /`/g, (delimiter) => "ˋ".repeat(delimiter.length));
}

function compact(s: string, n: number): string {
  return truncate((s.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim(), n);
}

/** Normalize transport wrappers, retaining the MCP server/tool identity. */
function toolName(name: string): string {
  return name.replace(/^functions\./, "").replace(/^mcp__/, "").replace(/__/g, "/")
    .replace(/^([\w-]+)_\1-/, "$1/");
}

export function formatTool(part: OcPart, projectDir: string): string {
  const tool = toolName(part.tool ?? "tool");
  const input = part.state?.input ?? {};
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const prefix = `${projectDir.replace(/\/+$/, "")}/`;
  const rel = (s: string) => s.startsWith(prefix) ? s.slice(prefix.length) : s;
  const target = (s: string | undefined, n = 60) => compact(s ?? "…", n);
  const code = (s: string | undefined, n = 60) => `\`${safeCodePayload(target(s, n))}\``;
  const prose = (s: string | undefined, n = 60) => safePayload(target(s, n));
  const path = () => code(rel(str("filePath", "path") ?? "…"), 70);
  const inPath = () => str("path") ? ` in ${code(rel(str("path")!))}` : "";
  let line: string;
  switch (tool) {
    case "bash": case "shell": line = `🔧 ${str("description") ? prose(str("description")) : str("command") ? code(str("command")) : prose(part.state?.title)}`; break;
    case "read": line = `📄 read ${path()}`; break;
    case "edit": line = `✏️ edit ${path()}`; break;
    case "write": line = `📝 write ${path()}`; break;
    case "glob": case "grep": line = `🔍 ${tool} ${code(str("pattern", "query"), 40)}${inPath()}`; break;
    case "list": line = `🗂️ list ${path()}`; break;
    case "webfetch": line = `🌐 fetch ${code(str("url"))}`; break;
    case "websearch": line = `🌐 search "${prose(str("query"), 50)}"`; break;
    case "skill": line = `⚡ skill ${code(str("name"), 40)}`; break;
    case "task": line = `🤖 task ${prose([str("subagent_type"), str("description")].filter(Boolean).join(": ") || str("prompt"))}`; break;
    case "question": line = "❓ question"; break;
    case "todowrite": line = "📋 todos"; break;
    case "patch": case "apply_patch": {
      const patch = str("patchText", "patch", "input") ?? "";
      const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => rel(m[1]!.trim()));
      line = `🩹 patch ${code([...new Set(paths)].join(", ") || rel(str("filePath", "path") ?? "…"), 100)}`;
      break;
    }
    default: {
      const title = part.state?.title?.split(prefix).join("");
      line = `🔧 ${code(tool)}${title && title !== tool ? ` · ${prose(title)}` : ""}`;
    }
  }
  return line;
}
