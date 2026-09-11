import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SlackocConfig {
  /** xoxb-... */
  slackBotToken: string;
  /** xapp-... (Socket Mode app-level token) */
  slackAppToken: string;
  /** The single Slack user allowed to drive this bridge. SECURITY INVARIANT. */
  ownerSlackUserId: string;
  /**
   * @deprecated Unused at runtime: `slackoc start` always boots with the CLI's
   * launch cwd as the default project. init still writes this (back-compat).
   */
  defaultProjectDir?: string;
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
  } catch {
    return null;
  }
}

export function saveConfig(cfg: SlackocConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

export function maskToken(token: string): string {
  if (token.length <= 10) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
