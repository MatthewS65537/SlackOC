/**
 * Ghost-connection witness.
 *
 * Slack Socket Mode hands each envelope to exactly one connection and offers
 * no API to enumerate an app token's active connections — so a second bridge
 * instance (or a zombie connection Slack hasn't reaped) sharing the token is
 * invisible by query. It is NOT invisible by behavior: every message the
 * catch-up sweep replays is proof an envelope failed to arrive live, while
 * the socket listeners count what DID arrive. A zombie steals everything
 * (live = 0); a competing instance steals a share (live > 0 but replays > 0).
 * A healthy bridge replays ~nothing but benign races.
 *
 * The detector slides a window over both counters and fires a loud, actionable
 * warning when deliveries arrive mostly-or-entirely via sweep — throttled so
 * an ongoing incident pages once an hour, not once a minute.
 */

export interface GhostDetectorOpts {
  /** Observation window; older bumps fall out of both counters. */
  windowMs?: number;
  /** Minimum replayed messages in-window before a warning is even considered. */
  threshold?: number;
  /** Minimum spacing between two warnings. */
  cooldownMs?: number;
}

const DEFAULTS = { windowMs: 15 * 60_000, threshold: 3, cooldownMs: 60 * 60_000 };

export class GhostDetector {
  private live: number[] = [];
  private replays: number[] = [];
  private lastWarnAt = 0;
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(opts: GhostDetectorOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.threshold = opts.threshold ?? DEFAULTS.threshold;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
  }

  /** The socket delivered an envelope live. */
  noteLive(now = Date.now()): void {
    this.live.push(now);
  }

  /** The catch-up sweep replayed `n` messages that never arrived live. */
  noteReplayed(n: number, now = Date.now()): void {
    for (let i = 0; i < n; i += 1) this.replays.push(now);
  }

  /**
   * Evaluate the pattern; returns the warning text (and starts the cooldown)
   * or null. Call after every sweep pass.
   */
  check(now = Date.now()): string | null {
    this.live = this.live.filter((t) => now - t <= this.windowMs);
    this.replays = this.replays.filter((t) => now - t <= this.windowMs);
    if (this.replays.length < this.threshold) return null;
    if (this.replays.length < this.live.length) return null;
    if (now - this.lastWarnAt < this.cooldownMs) return null;
    this.lastWarnAt = now;
    return (
      `catch-up: ${this.replays.length} message(s) arrived via sweep vs ${this.live.length} via socket in the last ` +
      `${Math.round(this.windowMs / 60_000)} min — a second bridge instance with this app token may be consuming ` +
      `your events. Kill it (slackoc stop on the other machine) or regenerate the app-level token.`
    );
  }
}
