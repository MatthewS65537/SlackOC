import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Filesystem identity when available; missing paths retain normalized absolute spelling. */
export function canonicalDir(dir: string): string {
  const absolute = resolve(dir);
  try { return realpathSync(absolute); }
  catch { return absolute; }
}
