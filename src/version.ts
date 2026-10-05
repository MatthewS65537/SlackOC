import { createRequire } from "node:module";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** Oldest OpenCode version this release was built against. */
export const MIN_OPENCODE: [number, number, number] = [2, 0, 12];

/** Stable releases of the supported API major, at or above our minimum. */
export function isSupportedOpencodeVersion(version: string): boolean {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && major === MIN_OPENCODE[0]
    && (minor! > MIN_OPENCODE[1] || (minor === MIN_OPENCODE[1] && patch! >= MIN_OPENCODE[2]));
}

export const CONFIG_DIR_NAME = "slackoc";
