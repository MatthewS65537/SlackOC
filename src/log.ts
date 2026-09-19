/**
 * Bridge log: an in-memory ring buffer (lets `\logs` answer "what is the
 * bridge doing?" from Slack) plus an optional persistent file with size
 * rotation (lets a crash or a yesterday's 429 storm be post-mortemed).
 * File logging is opt-in via enableFileLog() — the bridge enables it at
 * boot; tests enable it against a fixture path.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { LogLevel, type Logger } from "@slack/bolt";
import { CONFIG_DIR } from "./config.js";

export const LOG_PATH = join(CONFIG_DIR, "bridge.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_BACKUPS = 2; // bridge.log.1, bridge.log.2

const CAP = 200;
const buf: string[] = [];
let fileLog: string | null = null;
let totalPushed = 0;

/** Start appending to a persistent log file (default: ~/.config/slackoc/bridge.log). */
export function enableFileLog(path: string = LOG_PATH): void {
  // The managed supervisor is the only disk writer. Its pipes capture raw
  // stdout/stderr as well as ring-only info lines, without rotation fd races.
  fileLog = process.env.SLACKOC_SERVICE === "bridge" ? join(CONFIG_DIR, "logs", "bridge.log") : path;
  if (process.env.SLACKOC_SERVICE === "bridge") return;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* best-effort — a missing dir just means no file log */
  }
}

/** The active file-log path, or null when file logging is off. */
export function fileLogPath(): string | null {
  return fileLog;
}

/** Rotate bridge.log → .1 → .2 once it crosses the size cap. */
function rotateIfNeeded(): void {
  if (!fileLog) return;
  if (!existsSync(fileLog) || statSync(fileLog).size < LOG_MAX_BYTES) return;
  for (let i = LOG_BACKUPS; i >= 1; i--) {
    const from = i === 1 ? fileLog : `${fileLog}.${i - 1}`;
    if (existsSync(from)) renameSync(from, `${fileLog}.${i}`);
  }
}

export function pushLog(line: string): void {
  const now = new Date();
  const stamped = `${now.toISOString().slice(11, 19)} ${line}`;
  buf.push(stamped);
  if (buf.length > CAP) buf.shift();
  totalPushed++;
  if (fileLog) {
    try {
      if (process.env.SLACKOC_SERVICE === "bridge") {
        process.stdout.write(`${now.toISOString().replace(/\.\d{3}Z$/, "Z")} ${line}\n`);
        return;
      }
      rotateIfNeeded();
      // Full ISO stamp in the file — a post-mortem spanning days needs dates.
      appendFileSync(fileLog, `${now.toISOString().replace(/\.\d{3}Z$/, "Z")} ${line}\n`);
    } catch {
      /* disk errors must never kill the bridge */
    }
  }
}

/** Total lines pushed since boot — the cursor for `\logs --follow`. */
export function logCount(): number {
  return totalPushed;
}

/** Lines pushed after `cursor` (bounded by the 200-line ring). */
export function newLogsSince(cursor: number): string[] {
  const oldest = totalPushed - buf.length + 1; // 1-based index of buf[0]
  const start = Math.max(cursor + 1, oldest);
  if (start > totalPushed) return [];
  return buf.slice(start - oldest);
}

/**
 * Log an error line to stderr AND the ring buffer. Errors that previously
 * went to an unwatched console become visible to `\logs` remotely — the
 * whole point of the ring buffer.
 */
export function logErr(line: string): void {
  pushLog(line);
  console.error(line);
}

export function recentLogs(n = 50): string[] {
  return buf.slice(-n);
}

/**
 * Bolt/socket-mode Logger routed into the ring buffer: socket connect/
 * disconnect/ping-timeout/dispatch-failure lines otherwise die on an
 * unwatched console — exactly the evidence needed when inbound events stop.
 * Everything ≥ info reaches \logs; warnings/errors also hit stderr.
 */
export function ringLogger(name = "slack"): Logger {
  const fmt = (a: unknown): string =>
    a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a);
  const line = (...msg: unknown[]): string =>
    `[${name}] ${msg.map(fmt).join(" ")}`.slice(0, 400);
  const LEVELS: LogLevel[] = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
  let min = 1; // info
  return {
    debug: (...msg) => {
      if (min <= 0) pushLog(line(...msg));
    },
    info: (...msg) => {
      if (min <= 1) pushLog(line(...msg));
    },
    warn: (...msg) => {
      if (min <= 2) logErr(line(...msg));
    },
    error: (...msg) => {
      if (min <= 3) logErr(line(...msg));
    },
    setLevel(level: LogLevel) {
      const i = LEVELS.indexOf(level);
      if (i >= 0) min = i;
    },
    getLevel: () => LEVELS[min]!,
    setName() {
      /* single-sink logger — names irrelevant */
    },
  };
}

/** Test hook. */
export function clearLogs(): void {
  buf.length = 0;
  totalPushed = 0;
}
