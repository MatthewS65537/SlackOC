import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading `~` / `~/` to this machine's home dir (like a shell: `~//x` stays under home). */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Filesystem identity when available; missing paths retain normalized absolute spelling. */
export function canonicalDir(dir: string): string {
  const absolute = resolve(dir);
  try { return realpathSync(absolute); }
  catch { return absolute; }
}
