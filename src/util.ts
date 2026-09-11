export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

/** Last 2 path segments, with elision for deep paths. */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

export function money(c: number): string {
  if (!c) return "$0";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`;
}

export function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n));
}

export function shortId(id: string): string {
  return id.startsWith("ses_") ? id.slice(4, 14) : id.slice(0, 10);
}

/** Terse run duration: "41s" / "2m 14s" / "1h 3m". */
export function dur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function age(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Escape Slack mrkdwn metachars when interpolating raw text inline. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert GitHub-flavored markdown (what LLMs emit) to Slack mrkdwn.
 * Handles the constructs assistants actually use: headings, bold, italics,
 * inline code, fenced blocks, links, bullet lists. Slack has no headings or
 * blockquotes-as-syntax, so headings become *bold* lines and lists keep "-".
 * Fenced code and inline code are passed through untouched (Slack renders ```).
 */
export function mdToMrkdwn(s: string): string {
  // Split out fenced code blocks first so nothing inside them is transformed.
  const blocks: string[] = [];
  const withStash = s.replace(/```[^\n]*\n[\s\S]*?```|```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `\0${blocks.length - 1}\0`;
  });

  const rawLines = withStash.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    // GFM tables: a header row, a |---|---| separator, then ≥1 data row.
    // Slack has no table syntax — re-render as an aligned fenced code block,
    // which is actually readable on a phone (RQ5).
    if (isTableRow(line) && i + 2 < rawLines.length && isTableSep(rawLines[i + 1]!) && isTableRow(rawLines[i + 2]!)) {
      const rows: string[] = [line];
      let j = i + 1;
      while (j < rawLines.length && (isTableRow(rawLines[j]!) || isTableSep(rawLines[j]!))) {
        rows.push(rawLines[j]!);
        j++;
      }
      lines.push(rewrapTable(rows));
      i = j - 1;
      continue;
    }
    // ATX headings → bold line (strip #s and trailing ###s)
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h?.[2]) {
      lines.push(`*${inline(h[2])}*`);
      continue;
    }
    // Bullets: -, *, + → •
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (b?.[2]) {
      lines.push(`${b[1]}• ${inline(b[2])}`);
      continue;
    }
    lines.push(inline(line));
  }

  const out = lines.join("\n").replace(/\0(\d+)\0/g, (_, i) => blocks[Number(i)] ?? "");
  return out;
}

/** A GFM table delimiter row like `|---|---|` or `| --- | :--- |`. */
function isTableSep(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*(\|[\s:|-]*-[\s:|-]*)*\|?\s*$/.test(line) && line.includes("|") && line.includes("-");
}

/** A pipe-led line with at least one cell separator. */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|.*\|\s*$/.test(line);
}

/** Re-render a GFM table as a monospaced aligned block (separator rows dropped). */
function rewrapTable(rows: string[]): string {
  const data = rows.filter((r) => !isTableSep(r));
  const cells = data.map((r) =>
    r
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim()),
  );
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  const body = cells.map((r) =>
    r
      .map((c, i) => (c ?? "").padEnd(widths[i]!))
      .join("  ")
      .replace(/\s+$/, ""),
  );
  return "```\n" + body.join("\n") + "\n```";
}

/** Inline-level GFM → mrkdwn (bold/italic/code images links) for one line. */
function inline(s: string): string {
  // Images ![alt](url) → plain link text
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) => `${alt} ${url}`.trim());
  // Links [text](url) → <url|text> (skip bare code spans)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, text, url) => {
    if (/^(https?:|mailto:)/.test(url)) return `<${url}|${text}>`;
    return m;
  });
  // Inline code spans: stash so emphasis rules don't mangle their content.
  const codes: string[] = [];
  s = s.replace(/`[^`]+`/g, (m) => {
    codes.push(m);
    return `\u0001${codes.length - 1}\u0001`;
  });
  // Emphasis in ONE pass, longest-first, so bold output isn't re-matched as italic.
  s = s.replace(/\*\*\*([^*]+?)\*\*\*|\*\*([^*]+?)\*\*|\*([^*\n]+?)\*/g, (_m, tri, bold, ital) => {
    if (tri !== undefined) return `*_${tri}_*`;
    if (bold !== undefined) return `*${bold}*`;
    return `_${ital}_`;
  });
  // Underscore italics with boundaries (snake_case_id stays untouched).
  s = s.replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s.,:;!?)]|$)/g, "$1_$2_");
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)] ?? "");
}

/**
 * Normalize Slack's entity-encoded message text into what the model expects:
 * decode &lt; &gt; &quot; &amp;, unwrap <url|label> link markup to GFM links,
 * convert channel refs. Code spans/fenced blocks are stashed first so their
 * contents pass through untouched.
 */
export function slackToPlain(s: string): string {
  const stashed: string[] = [];
  const withStash = s.replace(/```[^\n]*\n[\s\S]*?```|```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    stashed.push(m);
    return `\u0000${stashed.length - 1}\u0000`;
  });

  let out = withStash;
  // Labeled links <https://x|label> → [label](url); bare <https://x> → url.
  out = out.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, (_m, url, label) => `[${label}](${url})`);
  out = out.replace(/<(https?:\/\/[^>]+)>/g, (_m, url) => url);
  // Channel refs <#C123|name> / <#C123> → #name
  out = out.replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, _id, name) => `#${name ?? "channel"}`);
  // Entities — &amp; LAST so a literal &amp;lt; decodes to text "<".
  out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => stashed[Number(i)] ?? "");
}

/** Split into chunks ≤ max (soft), preferring newline boundaries. */
export function chunkText(s: string, max = 3800): string[] {
  if (s.length <= max) return [s];
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.3) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
    if (!rest) break;
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}
