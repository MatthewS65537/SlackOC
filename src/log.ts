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

/** Identical lines beyond this many per window are counted, not written (outage spam). */
const REPEAT_LIMIT = 5;
const REPEAT_WINDOW_MS = 60_000;
const repeats = new Map<string, { since: number; count: number }>();

/** Collapse exact-duplicate lines: during a network outage the same failure repeats ~1/s for hours. */
function admitRepeat(line: string, now: number): string | null {
  let r = repeats.get(line);
  if (r && now - r.since >= REPEAT_WINDOW_MS) {
    const suppressed = r.count - REPEAT_LIMIT;
    repeats.delete(line);
    r = undefined;
    if (suppressed > 0) line = `${line} (+${suppressed} identical in the last ${Math.round(REPEAT_WINDOW_MS / 1000)}s)`;
  }
  if (!r) {
    if (repeats.size > 500) repeats.clear();
    repeats.set(line.replace(/ \(\+\d+ identical in the last \d+s\)$/, ""), { since: now, count: 1 });
    return line;
  }
  r.count += 1;
  if (r.count === REPEAT_LIMIT + 1) return `${line} (repeating — further copies suppressed for up to ${Math.round(REPEAT_WINDOW_MS / 1000)}s)`;
  return r.count > REPEAT_LIMIT ? null : line;
}

export function pushLog(line: string): void {
  const admitted = admitRepeat(line, Date.now());
  if (admitted === null) return;
  line = admitted;
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
  const before = totalPushed;
  pushLog(line);
  if (totalPushed !== before) console.error(line); // suppressed repeats stay off stderr too
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
  repeats.clear();
  buf.length = 0;
  totalPushed = 0;
}
