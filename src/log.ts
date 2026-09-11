/**
 * In-memory ring buffer of recent bridge log lines. Lets `\logs` answer
 * "what is the bridge doing?" from Slack when the console is out of reach
 * (the common case for remote deployments). Oldest lines drop out.
 */

// via bolt (the direct dep) — importing @slack/logger directly would be a phantom dep.
import { LogLevel, type Logger } from "@slack/bolt";

const CAP = 200;
const buf: string[] = [];

export function pushLog(line: string): void {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  buf.push(stamped);
  if (buf.length > CAP) buf.shift();
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
}
