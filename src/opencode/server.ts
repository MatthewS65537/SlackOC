/**
 * ServerPool: lazily spawns one `opencode serve` child process per project
 * directory, health-checks it, and pipes its SSE event stream to a callback.
 * OpenCode persists sessions per project on disk, so a respawned server
 * recovers its sessions transparently.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { makeClient, sseEvents, type OCClient } from "./client.js";
import { logErr } from "../log.js";

export interface PoolServerInfo {
  dir: string;
  url: string | null;
  status: "starting" | "ready" | "dead";
}

export interface PoolEntry {
  dir: string;
  url: string | null;
  baseUrl: string | null;
  client: OCClient | null;
  status: "starting" | "ready" | "dead";
  ready: Promise<void>;
  sseAbort: AbortController | null;
  proc: import("node:child_process").ChildProcess | null;
  /** Last SSE event time — the idle reaper uses it to find servers nobody uses. */
  lastEventAt: number;
  /** killOne/killAll set this so a deliberate stop doesn't page as a "death". */
  killedIntentionally?: boolean;
}

/** A server process death is worth reporting only if it was healthy AND not stopped on purpose. */
export function shouldNotifyDeath(wasReady: boolean, killedIntentionally: boolean): boolean {
  return wasReady && !killedIntentionally;
}

/** Heartbeats prove the SSE stream is alive, not that anyone is using the server — they must not count as reaper activity. */
export function isActivityEvent(type: string): boolean {
  return type !== "server.heartbeat" && type !== "server.connected";
}

/** Reap a ready server that has seen no events for maxIdleMs and has no active work (busy check supplied by caller). */
export function shouldReap(
  e: { status: string; lastEventAt: number },
  now: number,
  maxIdleMs: number,
  busy: boolean,
): boolean {
  return e.status === "ready" && !busy && now - e.lastEventAt > maxIdleMs;
}

export class ServerPool {
  private entries = new Map<string, PoolEntry>();
  private ensureLocks = new Map<string, Promise<PoolEntry>>();

  constructor(
    private onEvent: (dir: string, eventType: string, properties: Record<string, unknown>) => void,
    private log: (msg: string) => void = () => {},
    /** A ready server died unexpectedly (crash, kill -9) — threads bound to it need resolving. */
    private onDeath?: (dir: string, code: number | null) => void,
    /** SSE stream recovered after a drop — fired with the outage length so stale runs can be reconciled (RB2). */
    private onResume?: (dir: string, gapMs: number) => void,
  ) {}

  /** Canonical dir key so equivalent paths share a server. */
  private key(dir: string): string {
    try {
      return realpathSync(dir);
    } catch {
      return dir.endsWith("/") ? dir.slice(0, -1) : dir;
    }
  }

  /** Get (or spawn) the server for a project dir. */
  async ensure(dir: string): Promise<PoolEntry> {
    const k = this.key(dir);
    const inFlight = this.ensureLocks.get(k);
    if (inFlight) return inFlight;
    const existing = this.entries.get(k);
    if (existing && existing.status === "ready") return existing;

    const p = (async () => {
      const entry = await this.spawn(dir);
      this.entries.set(k, entry);
      // Start SSE piping once ready; swallow rejection here — the caller below
      // awaits entry.ready directly and gets the error there.
      entry.ready
        .then(() => this.pipeEvents(entry))
        .catch((err) => this.log(`SSE startup failed for ${dir}: ${String(err)}`));
      await entry.ready;
      return entry;
    })().finally(() => this.ensureLocks.delete(k));

    this.ensureLocks.set(k, p);
    return p;
  }

  /** Already-running server for a dir, if any. */
  get(dir: string): PoolEntry | null {
    const e = this.entries.get(this.key(dir));
    return e && e.status === "ready" ? e : null;
  }

  /**
   * Stop servers that have been idle for maxIdleMs with no active work
   * (isBusy). Idle `opencode serve` processes sit resident forever on an
   * always-on box; they respawn lazily on next use, so reaping is cheap.
   * Returns the number of servers reaped.
   */
  reapIdle(maxIdleMs: number, isBusy: (dir: string) => boolean, now: number = Date.now()): number {
    let n = 0;
    for (const e of [...this.entries.values()]) {
      if (shouldReap(e, now, maxIdleMs, isBusy(e.dir))) {
        n += 1;
        this.log(`idle reaper: stopping opencode server for ${e.dir} (idle ${Math.round((now - e.lastEventAt) / 60_000)}m)`);
        void this.killOne(e.dir); // killOne marks it intentional — no death notification
      }
    }
    return n;
  }

  list(): PoolServerInfo[] {
    return [...this.entries.values()].map((e) => ({ dir: e.dir, url: e.baseUrl, status: e.status }));
  }

  async killAll(): Promise<void> {
    for (const e of this.entries.values()) {
      e.status = "dead";
      e.killedIntentionally = true;
      try {
        e.sseAbort?.abort();
      } catch {
        /* noop */
      }
      try {
        if (e.proc?.pid) process.kill(-e.proc.pid, "SIGTERM");
        e.proc?.kill("SIGTERM");
      } catch {
        try {
          e.proc?.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }
    }
    this.entries.clear();
  }

  /**
   * Kill ONE project's server and drop it from the pool. Used after a project
   * switch so the old directory's server isn't left running (or, worse, kept
   * as the routing target). The server exits → its `exit` handler also cleans
   * the registry entry; aborting SSE first stops reconnect churn.
   */
  async killOne(dir: string): Promise<void> {
    const k = this.key(dir);
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k);
    e.status = "dead";
    e.killedIntentionally = true;
    try {
      e.sseAbort?.abort();
    } catch {
      /* noop */
    }
    try {
      if (e.proc?.pid) process.kill(-e.proc.pid, "SIGTERM");
      e.proc?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  // ------------------------------------------------------------------

  private async spawn(dir: string): Promise<PoolEntry> {
    const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });

    const entry: PoolEntry = {
      dir,
      url: null,
      baseUrl: null,
      client: null,
      status: "starting",
      ready: null as unknown as Promise<void>,
      sseAbort: null,
      proc: child,
      lastEventAt: Date.now(),
    };

    entry.ready = new Promise<void>((resolve, reject) => {
      let output = "";
      const done = (err?: Error, baseUrl?: string) => {
        clearTimeout(timeout);
        if (err) {
          entry.status = "dead";
          reject(err);
        } else {
          entry.baseUrl = baseUrl!;
          entry.url = baseUrl!;
          entry.client = makeClient(baseUrl!);
          entry.status = "ready";
          this.log(`opencode server for ${dir} listening on ${baseUrl}`);
          resolve();
        }
      };

      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        done(new Error(`opencode serve in ${dir} did not start within 45s`));
      }, 45_000);

      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (!entry.baseUrl) {
          const m = output.match(/(https?:\/\/127\.0\.0\.1:\d+)/);
          if (m?.[1]) {
            void this.waitHealthy(m[1])
              .then(() => done(undefined, m[1]))
              .catch((err) => done(err as Error));
          }
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (c: Buffer) => {
        output += c.toString();
        this.log(`opencode[${dir}] stderr: ${c.toString().trim()}`);
      });
      child.on("error", (err) => done(new Error(`failed to spawn opencode: ${err.message}`)));
      child.on("exit", (code) => {
        this.log(`opencode server for ${dir} exited with code ${code}`);
        const wasReady = entry.status === "ready";
        entry.status = "dead";
        this.entries.delete(this.key(dir));
        done(new Error(`opencode serve exited early (code ${code}):\n${output.slice(-2000)}`));
        // Unexpected healthy-server death: runs bound to it hang without this —
        // the bridge finalizes those threads (and pages the owner) via onDeath.
        if (shouldNotifyDeath(wasReady, !!entry.killedIntentionally)) this.onDeath?.(dir, code);
      });
    });

    return entry;
  }

  private async waitHealthy(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server at ${baseUrl} never became healthy`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Subscribe to the per-server SSE stream with reconnect backoff. */
  private async pipeEvents(entry: PoolEntry): Promise<void> {
    if (!entry.baseUrl) return;
    const baseUrl = entry.baseUrl;
    const abort = new AbortController();
    entry.sseAbort = abort;

    void (async () => {
      let backoffMs = 1000;
      /** Set when the stream drops (error or clean end); cleared by the first event after resubscribing. */
      let downSince: number | null = null;
      while (!abort.signal.aborted && entry.status === "ready") {
        try {
          this.log(`SSE subscribing to ${baseUrl}/event`);
          for await (const ev of sseEvents(baseUrl, abort.signal)) {
            backoffMs = 1000; // healthy stream resets backoff
            if (downSince) {
              // Back on air: events fired during the gap are LOST — runs that
              // completed in it never signal again (RB2), so the bridge
              // reconciles them from polled state. Prolonged outages also go
              // on the error log once (\logs visibility from a phone).
              const gap = Date.now() - downSince;
              downSince = null;
              this.onResume?.(entry.dir, gap);
              if (gap > 5 * 60_000) {
                logErr(`SSE for ${entry.dir} was disconnected for ${Math.round(gap / 60_000)}m — events in the gap were lost; completed runs self-heal via reconcile`);
              }
            }
            if (isActivityEvent(ev.type)) entry.lastEventAt = Date.now(); // liveness signal for the idle reaper
            try {
              this.onEvent(entry.dir, ev.type, (ev.properties ?? {}) as Record<string, unknown>);
            } catch (err) {
              this.log(`event handler error: ${String(err)}`);
            }
          }
          // stream ended cleanly (dead server or release) → reconnect
          downSince ??= Date.now();
        } catch (err) {
          if (abort.signal.aborted) break;
          downSince ??= Date.now();
          this.log(`SSE error for ${entry.dir}: ${String(err)}`);
        }
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 15_000);
      }
    })();
  }
}
