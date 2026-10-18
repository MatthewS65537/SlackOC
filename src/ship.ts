import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { withTempDir } from "./headless.js";
import { safeCodePayload } from "./slack/tool-format.js";
import { vcsBranch, type OCClient } from "./opencode/client.js";
import type { OcFileDiff } from "./opencode/api.js";
import { shortId } from "./util.js";

/**
 * C1 Ship panel: commit the files a session changed, and optionally push and
 * open a draft PR. No model is involved: `planShip` turns the owner's choices
 * into exact argv lists (or a refusal), `runShip` runs them with execFile
 * (never a shell) and stops at the first failure. Never `--force`; hooks run.
 */

export const MAIN_BRANCHES = ["main", "master"];
/** Stands in for the commit message file in planned steps; runShip swaps in the real temp path. */
export const MSG_FILE = "<msgfile>";
export const STEP_TIMEOUT_MS = 60_000;
const TAIL_LINES = 20;

/**
 * One changed path, relative to the repo root. `orig` is a staged rename's
 * source (committed alongside so the rename lands whole). `removed` marks a
 * staged deletion: it is in neither the index nor the work tree, so `git add`
 * would fail on it; `git commit -- <path>` still records it.
 */
export interface ShipFile { path: string; orig?: string; removed?: boolean }

export interface ShipInput {
  /** The checked-out branch; null on a detached HEAD. */
  current: string | null;
  /** Commit on a fresh branch (`newBranch`) or on `current`. */
  branch: "new" | "current";
  newBranch: string;
  files: ShipFile[];
  message: string;
  push: boolean;
  pr: boolean;
  allowMainPush: boolean;
}

/** Which modal input a refusal belongs to (diff-view.ts maps these to block ids). */
export type ShipField = "branch" | "branch_name" | "files" | "message" | "publish";
export type ShipPlan = { steps: string[][]; branch: string } | { refusal: string; field: ShipField };

/** Repo-relative, no `..` segments: a selected path can never reach outside the repo. */
function safePath(p: string): boolean {
  return p.length > 0 && !p.includes("\0") && !isAbsolute(p) && !p.split(/[\\/]/).includes("..");
}

/**
 * git's check-ref-format rules, plus a word-character start (`-x` reads as an option, and a push
 * refspec `+main` means force) and no `refs/`/`heads/` prefix (`refs/heads/main` would dodge the main check).
 */
export function validBranchName(name: string): boolean {
  return /^\w/.test(name) && !/^(refs|heads)\//.test(name)
    && !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\/\.|[/.]$|\.lock$|\.lock\//.test(name)
    && name !== "HEAD";
}

export function planShip(input: ShipInput): ShipPlan {
  const { current, files, push, pr } = input;
  if (current === null) return { refusal: "HEAD is detached. Check out a branch first.", field: "branch" };
  if (!files.length) return { refusal: "Select at least one file.", field: "files" };
  const unsafe = files.flatMap(f => f.orig === undefined ? [f.path] : [f.path, f.orig]).find(p => !safePath(p));
  if (unsafe !== undefined) return { refusal: `Refusing a path outside the repo: ${unsafe}`, field: "files" };
  const message = input.message.trim();
  if (!message) return { refusal: "Write a commit message.", field: "message" };
  const target = input.branch === "new" ? input.newBranch.trim() : current;
  if (!validBranchName(target)) {
    return input.branch === "new"
      ? { refusal: target ? `${target} isn't a valid branch name.` : "Name the new branch.", field: "branch_name" }
      : { refusal: `Can't ship from branch ${target}.`, field: "branch" };
  }
  if (pr && !push) return { refusal: "A draft PR needs Push ticked too.", field: "publish" };
  if (push && MAIN_BRANCHES.includes(target) && !input.allowMainPush) {
    return { refusal: `Pushing to ${target} is off. Pick a new branch, or set ship.allowMainPush in the SlackOC config.`, field: "branch" };
  }
  const steps: string[][] = [];
  if (input.branch === "new") steps.push(["git", "switch", "-c", target]);
  const add = files.filter(f => !f.removed).map(f => f.path);
  if (add.length) steps.push(["git", "add", "--", ...add]);
  // Paths after `--` commit only the selection, not whatever else was already staged.
  const commit = [...new Set(files.flatMap(f => f.orig === undefined ? [f.path] : [f.path, f.orig]))];
  steps.push(["git", "commit", "-F", MSG_FILE, "--", ...commit]);
  // Explicit refspec: the branch name can never be read as a force (`+`) or a different ref.
  if (push) steps.push(["git", "push", "-u", "origin", `refs/heads/${target}:refs/heads/${target}`]);
  if (pr) {
    const [title = "", ...body] = message.split("\n");
    // `--flag=value` so a title or body starting with "-" can't read as a flag.
    steps.push(["gh", "pr", "create", "--draft", `--title=${title.trim()}`, `--body=${body.join("\n").trim()}`, `--head=${target}`]);
  }
  return { steps, branch: target };
}

/** Shell-style rendering for display only (steps never go through a shell). Long/multi-line args are shortened. */
export function formatArgv(argv: string[]): string {
  return argv.map(a => {
    const shown = a.replace(/\n/g, "⏎");
    const cut = shown.length > 60 ? `${shown.slice(0, 59)}…` : shown;
    return /^[\w@%+=:,./<>-]+$/.test(cut) ? cut : `'${cut.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}

export type ExecFileFn = (file: string, args: string[], opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }) =>
  Promise<{ stdout: string; stderr: string }>;

/** execFile, no shell. Rejections carry `stdout`/`stderr`; a timeout kills the child (`killed`). */
export const execFileAsync: ExecFileFn = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, { ...opts, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
});

/**
 * Fail instead of waiting on a credential prompt nobody can answer, and treat
 * every path as a literal name: a file called `*` or `:(top)x` must not
 * widen `git add`/`git commit` beyond the ticked files.
 */
const SHIP_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_LITERAL_PATHSPECS: "1" };

export interface ShipStepResult { argv: string[]; stdout: string }
export type ShipRun =
  | { ok: true; results: ShipStepResult[] }
  | { ok: false; results: ShipStepResult[]; failed: string[]; tail: string };

/** Credentials git/gh/hooks may echo: URL userinfo (`https://user:token@host`) and GitHub token shapes. */
export const redactSecrets = (text: string): string => text
  .replace(/(\w+:\/\/)[^/\s@]+@/g, "$1***@")
  .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, "***");

/** Last ~20 lines of what the failing step said (credentials redacted), or why it couldn't run at all. */
export function failureTail(argv: string[], error: unknown): string {
  const e = error as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown; message?: string };
  if (e?.code === "ENOENT") return `${argv[0]} isn't installed (or isn't on the bridge's PATH).`;
  const raw = e?.stderr?.trim() || e?.stdout?.trim() || e?.message || String(error);
  const out = redactSecrets(raw).split("\n").slice(-TAIL_LINES).join("\n");
  const tail = out.length > 2_500 ? `…${out.slice(-2_500)}` : out;
  return e?.killed ? `Timed out after ${STEP_TIMEOUT_MS / 1000}s.\n${tail}` : tail;
}

/** Runs the planned steps in `cwd`, in order, stopping at the first failure. The message file lives in a private temp dir removed afterwards. */
export async function runShip(steps: string[][], opts: { cwd: string; message: string; exec?: ExecFileFn }): Promise<ShipRun> {
  const exec = opts.exec ?? execFileAsync;
  return withTempDir(async dir => {
    const msgFile = join(dir, "COMMIT_MSG");
    const message = opts.message.trim();
    await writeFile(msgFile, `${message}\n`, { mode: 0o600 });
    const results: ShipStepResult[] = [];
    for (const step of steps) {
      const argv = step.map((a, i) => a === MSG_FILE && step[i - 1] === "-F" ? msgFile : a);
      try {
        const { stdout } = await exec(argv[0]!, argv.slice(1), { cwd: opts.cwd, timeout: STEP_TIMEOUT_MS, env: SHIP_ENV });
        results.push({ argv: step, stdout });
      } catch (error) {
        return { ok: false, results, failed: step, tail: failureTail(step, error) };
      }
    }
    return { ok: true, results };
  });
}

/** `[agent/x abc1234] msg` → abc1234 (root commits read `[main (root-commit) abc1234]`). */
function commitSha(results: ShipStepResult[]): string | undefined {
  const out = results.find(r => r.argv[0] === "git" && r.argv[1] === "commit")?.stdout ?? "";
  return /^\[[^\]\n]*?\b([0-9a-f]{7,40})\]/m.exec(out)?.[1];
}

/** The thread's result line: what landed, or the step that failed and its stderr tail. */
export function shipResultText(branch: string, run: ShipRun): string {
  const sha = commitSha(run.results);
  const committed = `${sha ? `\`${sha}\` ` : ""}on \`${safeCodePayload(branch)}\``;
  if (!run.ok) {
    const done = sha ? ` (committed ${committed} already; nothing was undone)` : "";
    return `:x: Ship stopped at \`${safeCodePayload(formatArgv(run.failed))}\`${done}\n\`\`\`\n${safeCodePayload(run.tail, true)}\n\`\`\``;
  }
  const bits = [`🚀 Committed ${committed}`];
  if (run.results.some(r => r.argv[1] === "push")) bits.push("pushed");
  const pr = run.results.find(r => r.argv[0] === "gh")?.stdout.match(/https?:\/\/\S+/g)?.at(-1);
  if (pr) bits.push(`draft PR <${pr}>`);
  return bits.join(" · ");
}

/** `git status --porcelain=v1 -z` entry. `code` is the two-letter XY status. */
export interface DirtyFile extends ShipFile { code: string }

/**
 * Parses `git status --porcelain=v1 -z`: NUL-terminated `XY path` entries, no
 * quoting, paths relative to the repo root. A rename/copy entry is followed by
 * its source path as a separate NUL-terminated field.
 */
export function parseStatusZ(out: string): DirtyFile[] {
  const fields = out.split("\0");
  const files: DirtyFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!, code = entry.slice(0, 2);
    const file: DirtyFile = { code, path: entry.slice(3) };
    if (x === "R" || x === "C") {
      const orig = fields[++i];
      if (x === "R" && orig) file.orig = orig;
    }
    if (x === "D") file.removed = true;
    files.push(file);
  }
  return files;
}

/** Checked-out branch via git; null on a detached HEAD. `symbolic-ref` also works on an unborn branch. */
export async function gitBranch(cwd: string, exec: ExecFileFn = execFileAsync): Promise<string | null> {
  try {
    return (await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeout: 10_000 })).stdout.trim() || null;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

/** Branch from OpenCode's V2 `vcs.get`, falling back to git when it's unavailable or reports none. */
export async function currentBranch(client: OCClient, cwd: string, exec: ExecFileFn = execFileAsync): Promise<string | null> {
  const fromVcs = await vcsBranch(client).catch(() => undefined);
  return fromVcs && fromVcs !== "HEAD" ? fromVcs : gitBranch(cwd, exec);
}

/** `agent/<slug of the session title>`, or `agent/<short id>` when the title has no ASCII words. */
export function defaultBranchName(title: string, sessionId: string): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  return `agent/${slug || shortId(sessionId).toLowerCase()}`;
}

export function defaultMessage(title: string, diffs: OcFileDiff[], sessionId: string): string {
  const add = diffs.reduce((n, d) => n + d.additions, 0), del = diffs.reduce((n, d) => n + d.deletions, 0);
  const stat = diffs.length ? `+${add}/-${del} across ${diffs.length} file(s).\n\n` : "";
  return `${title.trim() || "Changes from an OpenCode session"}\n\n${stat}Made with SlackOC + OpenCode (${sessionId})`;
}

export interface ShipInputs {
  /** Repo root: every step runs here, and status paths are relative to it. */
  top: string;
  current: string | null;
  /** Dirty files the session changed (pre-ticked), then the rest (unticked). */
  sessionFiles: DirtyFile[];
  otherFiles: DirtyFile[];
  message: string;
  newBranch: string;
}

/** Everything the panel needs, read from git and OpenCode. Null when `projectDir` isn't inside a git repo. */
export async function loadShipInputs(client: OCClient, projectDir: string, sessionId: string, session: { title: string; diffs: OcFileDiff[] },
  exec: ExecFileFn = execFileAsync): Promise<ShipInputs | null> {
  let top: string, prefix: string;
  try {
    [top = "", prefix = ""] = (await exec("git", ["rev-parse", "--show-toplevel", "--show-prefix"], { cwd: projectDir, timeout: 10_000 })).stdout.split("\n");
  } catch { return null; }
  if (!top) return null;
  const [current, status] = await Promise.all([currentBranch(client, top, exec),
    exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: top, timeout: 30_000 })]);
  // OpenCode's diff paths may be absolute or relative to the project dir or the repo root: accept any.
  const touched = new Set(session.diffs.flatMap(({ file }) => isAbsolute(file)
    ? [relative(top, file), prefix + relative(projectDir, file)] : [prefix + file, file]));
  const dirty = parseStatusZ(status.stdout);
  const mine = (f: DirtyFile) => touched.has(f.path) || (f.orig !== undefined && touched.has(f.orig));
  return { top, current, sessionFiles: dirty.filter(mine), otherFiles: dirty.filter(f => !mine(f)),
    message: defaultMessage(session.title, session.diffs, sessionId), newBranch: defaultBranchName(session.title, sessionId) };
}
