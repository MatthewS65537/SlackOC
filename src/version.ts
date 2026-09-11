import { createRequire } from "node:module";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** Oldest OpenCode version this release was built against. */
export const MIN_OPENCODE: [number, number, number] = [1, 18, 0];

export const CONFIG_DIR_NAME = "slackoc";
