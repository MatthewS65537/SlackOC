import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { htmlToPdf, screenshot, withTempDir, type HeadlessOptions } from "../headless.js";
import { MAX_SEND_FILE_BYTES } from "../send-file.js";
import { safeCodePayload } from "../slack/tool-format.js";
import type { CmdCtx, CmdDef } from "./registry.js";

/**
 * `\shot <url|path> [phone|desktop|pdf]`: capture a page with headless Chrome
 * and upload it into the thread. Pure bridge work: no model call, and the
 * thread's OpenCode session is never touched.
 */

export const SHOT_MODES = { phone: { width: 412, height: 892 }, desktop: { width: 1440, height: 900 }, pdf: null } as const;
export type ShotMode = keyof typeof SHOT_MODES;
export type ShotTarget = { kind: "url"; url: string } | { kind: "file"; path: string; label: string };
const USAGE = "\\shot <url|path> [phone|desktop|pdf]";

/** Trailing mode word (phone by default); the rest, spaces included, is the target. */
export function parseShotArgs(args: string): { target: string; mode: ShotMode } {
  const m = /^(.+?)\s+(phone|desktop|pdf)$/i.exec(args.trim());
  return m ? { target: m[1]!, mode: m[2]!.toLowerCase() as ShotMode } : { target: args.trim(), mode: "phone" };
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * http(s) URLs (bare `localhost[:port]` gets http://), or a file inside the
 * thread's project: relative paths resolve against the project, never the
 * bridge's launch dir, and symlinks may not escape it.
 */
export async function resolveShotTarget(raw: string, projectDir: string): Promise<ShotTarget> {
  let target = raw;
  // slackToPlain turns Slack's autolinks into [label](url): what the owner typed is the label.
  const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i.exec(target);
  if (link) target = /^https?:\/\//i.test(link[1]!) ? link[2]! : link[1]!;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(target)) target = `http://${target}`;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(target)) {
    let url: URL;
    try { url = new URL(target); } catch { throw new Error(`not a valid URL: ${target}`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs or files inside this thread's project can be captured");
    return { kind: "url", url: url.href };
  }
  const outside = new Error("refusing a path outside this thread's project");
  const lexical = resolve(projectDir, target);
  if (!inside(projectDir, lexical)) throw outside;
  let path: string;
  try { path = await realpath(lexical); } catch { throw new Error(`no such file in the project: ${target}`); }
  if (!inside(await realpath(projectDir), path)) throw outside;
  if (!(await stat(path)).isFile()) throw new Error(`not a file: ${target}`);
  return { kind: "file", path, label: relative(projectDir, lexical) };
}

/** `localhost-3000-login.png` / `report.pdf`: readable, filesystem-safe, bounded. */
export function shotFilename(target: ShotTarget, ext: "png" | "pdf"): string {
  let stem: string;
  if (target.kind === "url") {
    const u = new URL(target.url);
    stem = `${u.hostname}${u.port ? `-${u.port}` : ""}${u.pathname}`;
  } else stem = basename(target.path, extname(target.path));
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60);
  return `${stem || "shot"}.${ext}`;
}

export async function runShot(ctx: CmdCtx, args: string, headless: HeadlessOptions = {}): Promise<void> {
  const { target: raw, mode } = parseShotArgs(args);
  if (!raw) throw new Error(`usage: \`${USAGE}\``);
  const project = ctx.thread?.projectDir ?? ctx.state.defaultDir(ctx.channelId, ctx.cwd);
  const target = await resolveShotTarget(raw, project);
  const input = target.kind === "url" ? target.url : target.path;
  const ext = mode === "pdf" ? "pdf" : "png";
  const started = Date.now();
  const data = await withTempDir(async dir => {
    const out = join(dir, `shot.${ext}`);
    const size = SHOT_MODES[mode];
    if (size) await screenshot(input, out, size, headless);
    else await htmlToPdf(input, out, headless);
    return readFile(out);
  });
  if (data.length > MAX_SEND_FILE_BYTES) throw new Error("the capture exceeds the 50 MiB upload limit");
  const size = SHOT_MODES[mode];
  const what = size ? `${mode} ${size.width}×${size.height}` : "PDF";
  const label = target.kind === "url" ? target.url : target.label;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  await ctx.uploadToThread(shotFilename(target, ext), data, `📸 \`${safeCodePayload(label)}\` · ${what} · ${secs}s`);
}

export const shotCommand: CmdDef = {
  name: "shot",
  aliases: ["screenshot", "snap"],
  usage: USAGE,
  summary: "Screenshot a URL or project file with headless Chrome",
  detail: "`phone` (412×892) is the default, `desktop` is 1440×900, `pdf` prints the page. Paths resolve inside this thread's project. No model call; the session is untouched. Set `SLACKOC_CHROME` if Chrome isn't found.",
  run: (ctx, args) => runShot(ctx, args),
};
