import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./util.js";

export interface SlackocConfig {
  /** xoxb-... */
  slackBotToken: string;
  /** xapp-... (Socket Mode app-level token) */
  slackAppToken: string;
  /** The single Slack user allowed to drive this bridge. SECURITY INVARIANT. */
  ownerSlackUserId: string;
  createdAt: string;
}

export const CONFIG_DIR = join(process.env.SLACKOC_HOME ?? join(homedir(), ".config"), "slackoc");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STATE_PATH = join(CONFIG_DIR, "state.json");
export const PID_PATH = join(CONFIG_DIR, "slackoc.pid");

export function loadConfig(): SlackocConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as SlackocConfig;
  } catch (err) {
    console.error(`${CONFIG_PATH} is unreadable (${String((err as Error)?.message ?? err)}) — re-run \`slackoc init\`.`);
    return null;
  }
}

/** Slack member IDs: U plus at least eight uppercase alphanumerics. */
export const OWNER_ID_RE = /^U[A-Z0-9]{8,}$/;

export function saveConfig(cfg: SlackocConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Atomic: a crash mid-write must not leave a truncated token file
  // (loadConfig would then report "not set up" with no hint why).
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2), 0o600);
}

export function maskToken(token: string): string {
  if (token.length <= 10) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
