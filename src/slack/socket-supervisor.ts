/**
 * Owns Slack Socket Mode reconnection.
 *
 * @slack/socket-mode 3.x treats a network-level failure of
 * apps.connections.open (WebAPIRequestError — e.g. `fetch failed` right
 * after wake) as unrecoverable: its reconnect promise rejects unhandled and
 * the client never tries again. The process stays up, so launchd never
 * restarts it, and no Slack event arrives until a manual restart.
 *
 * The receiver therefore runs with the library's auto-reconnect DISABLED and
 * this supervisor is the only thing that calls start() after boot: every
 * close/disconnect schedules a reconnect with jittered backoff, so there is
 * never a second, racing reconnect loop and every failure is caught.
 */

/** The SocketModeClient surface the supervisor depends on. */
export interface SocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SocketSupervisorOptions {
  log: (line: string) => void;
  /** Called once Slack has been unreachable for `fatalAfterMs` (managed runs exit so launchd restarts cleanly). */
  onFatal?: (downMs: number) => void;
  /** Called after a reconnect or a detected wake — run catch-up. */
  onRecovered?: () => void;
  now?: () => number;
  checkEveryMs?: number;
  /** Down this long in total ⇒ onFatal. Infinity disables. */
  fatalAfterMs?: number;
  /** Timer drift beyond this ⇒ the machine slept. */
  wakeDriftMs?: number;
  /** Bound on one start() attempt (WSS URL fetch + websocket open + hello). */
  startTimeoutMs?: number;
  /** Bound on disconnect() before a fresh start. */
  disconnectTimeoutMs?: number;
  random?: () => number;
}

export type SocketHealth = {
  connected: boolean;
  /** ms since the socket went down (0 while connected). */
  downMs: number;
  lastConnectedAt?: number;
  reconnects: number;
  lastError?: string;
};

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export class SocketSupervisor {
  private connected = false;
  private downSince: number;
  private lastConnectedAt?: number;
  private lastTick: number;
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private restarting = false;
  private failures = 0;
  private reconnects = 0;
  private lastError?: string;
  private fatalFired = false;
  private stopped = false;
  private readonly listeners: Array<[string, (...args: unknown[]) => void]> = [];
  private readonly now: () => number;
  private readonly checkEveryMs: number;
  private readonly fatalAfterMs: number;
  private readonly wakeDriftMs: number;
  private readonly startTimeoutMs: number;
  private readonly disconnectTimeoutMs: number;
  private readonly random: () => number;

  constructor(private readonly client: SocketLike, private readonly opts: SocketSupervisorOptions) {
    this.now = opts.now ?? Date.now;
    this.checkEveryMs = opts.checkEveryMs ?? 15_000;
    this.fatalAfterMs = opts.fatalAfterMs ?? Infinity;
    this.wakeDriftMs = opts.wakeDriftMs ?? 30_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 90_000;
    this.disconnectTimeoutMs = opts.disconnectTimeoutMs ?? 5_000;
    this.random = opts.random ?? Math.random;
    this.downSince = this.lastTick = this.now();
  }

  /** Begin supervising. Call after the initial app.start() resolved (the socket is connected). */
  start(): void {
    this.markConnected();
    this.listen("connected", () => this.markConnected());
    // With auto-reconnect off, the library emits `disconnected` after every close.
    this.listen("disconnected", () => this.markDown("disconnected"));
    this.lastTick = this.now();
    this.timer = setInterval(() => this.check(), this.checkEveryMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const [event, fn] of this.listeners) this.client.off(event, fn);
    this.listeners.length = 0;
  }

  health(): SocketHealth {
    return {
      connected: this.connected,
      downMs: this.connected ? 0 : this.now() - this.downSince,
      lastConnectedAt: this.lastConnectedAt,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  /** A socket-mode promise rejected unhandled — treat the socket as down. */
  noteLibraryFailure(err: unknown): void {
    this.lastError = String((err as Error)?.message ?? err);
    this.markDown(`library failure: ${this.lastError}`);
  }

  /** Periodic pass: wake detection, fatal escalation, and a backstop reconnect. Exposed for tests. */
  check(): void {
    if (this.stopped) return;
    const now = this.now();
    const drift = now - this.lastTick - this.checkEveryMs;
    this.lastTick = now;
    if (drift > this.wakeDriftMs) {
      // A socket that survived sleep is fine; a dead one trips the library's
      // 30s server-ping timeout, closes, and lands in markDown.
      this.opts.log(`slack socket: wake detected (timers ${Math.round(drift / 1000)}s late)`);
      this.opts.onRecovered?.();
    }
    if (this.connected) return;
    const downMs = now - this.downSince;
    if (downMs >= this.fatalAfterMs && !this.fatalFired) {
      this.fatalFired = true;
      this.opts.log(`slack socket: unreachable for ${Math.round(downMs / 60_000)} min — exiting so the service manager restarts the bridge`);
      this.opts.onFatal?.(downMs);
      return;
    }
    // Backstop: a lost timer (sleep) must never strand the socket.
    if (!this.restarting && !this.retryTimer) this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.connected || this.restarting || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconnect();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.connected || this.restarting) return;
    this.restarting = true;
    this.reconnects += 1;
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Flush any half-open socket first; the library resolves once it emits `disconnected`.
      await this.bounded(this.client.disconnect().catch(() => {}), this.disconnectTimeoutMs);
      if (this.stopped) return;
      const started = this.client.start();
      started.catch(() => {}); // a late rejection after the timeout won must not go unhandled
      await Promise.race([
        started,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`start timed out (${this.startTimeoutMs / 1000}s)`)), this.startTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      this.failures = 0;
      this.markConnected();
      this.opts.onRecovered?.();
    } catch (err) {
      this.failures += 1;
      this.lastError = String((err as Error)?.message ?? err);
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.failures - 1, 6));
      const wait = Math.round(base * (0.75 + this.random() * 0.5));
      this.opts.log(`slack socket: reconnect failed (${this.lastError}) — retrying in ${Math.round(wait / 1000)}s`);
      this.restarting = false;
      this.schedule(wait);
    } finally {
      clearTimeout(timeout);
      this.restarting = false;
    }
  }

  private bounded(p: Promise<unknown>, ms: number): Promise<unknown> {
    return Promise.race([p, new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); })]);
  }

  private markConnected(): void {
    if (!this.connected && this.lastConnectedAt !== undefined) {
      this.opts.log(`slack socket: connected after ${Math.round((this.now() - this.downSince) / 1000)}s down`);
    }
    this.connected = true;
    this.fatalFired = false;
    this.lastConnectedAt = this.now();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  }

  private markDown(reason: string): void {
    if (this.stopped) return;
    if (this.connected) {
      this.connected = false;
      this.downSince = this.now();
      this.opts.log(`slack socket: ${reason} — reconnecting`);
    }
    // First attempt is quick: Slack's routine `disconnect` (pod recycle) must not cost seconds.
    if (!this.restarting) this.schedule(this.failures ? 0 : 250);
  }

  private listen(event: string, fn: (...args: unknown[]) => void): void {
    this.client.on(event, fn);
    this.listeners.push([event, fn]);
  }
}

/** True when an unhandled rejection came from the Socket Mode client's reconnect path. */
export function isSocketModeFailure(err: unknown): boolean {
  const stack = String((err as Error)?.stack ?? "");
  return /@slack[\\/]socket-mode/.test(stack) || /apps\.connections\.open/.test(String((err as Error)?.message ?? ""));
}
