/** One generation-owned OpenCode child and event stream per canonical project. */
import { spawn } from "node:child_process";
import { canonicalDir } from "../paths.js";
import { abortableFetch, abortableSleep, HEALTH_TIMEOUT_MS } from "../http.js";
import { makeClient, sseEvents, type OCClient } from "./client.js";
import { logErr } from "../log.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
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
  lastEventAt: number;
  killedIntentionally?: boolean;
  lastUsedAt?: number;
  connectionState?: ConnectionState;
}

interface ManagedEntry extends PoolEntry {
  lifetime: AbortController;
  cancelStart: (reason: Error) => void;
  lastHealthAt: number;
  requests: number;
}

export interface PoolHooks {
  isBusy?: (dir: string) => boolean;
  onConnectionState?: (dir: string, state: ConnectionState) => void;
}

export interface RequestLease {
  entry: PoolEntry;
  /** Idempotent; release in finally after session creation/submission. */
  release: () => void;
}

export const STALE_HEALTH_MS = 30_000;
export function shouldNotifyDeath(wasReady: boolean, killedIntentionally: boolean): boolean {
  return wasReady && !killedIntentionally;
}
export function isActivityEvent(type: string): boolean {
  return type !== "server.heartbeat" && type !== "server.connected";
}
export function shouldReap(
  e: { status: string; lastEventAt: number; lastUsedAt?: number },
  now: number, maxIdleMs: number, busy: boolean,
): boolean {
  return e.status === "ready" && !busy && now - Math.max(e.lastEventAt, e.lastUsedAt ?? 0) > maxIdleMs;
}

export class ServerPool {
  private entries = new Map<string, ManagedEntry>();
  private ensureLocks = new Map<string, { promise: Promise<PoolEntry>; abort: AbortController }>();
  private leases = new Map<string, number>();
  private closed = false;

  constructor(
    private onEvent: (dir: string, eventType: string, properties: Record<string, unknown>) => void,
    private log: (msg: string) => void = () => {},
    private onDeath?: (dir: string, code: number | null) => void,
    private onResume?: (dir: string, gapMs: number) => void,
    private onReady?: (dir: string, baseUrl: string) => void,
    private hooks: PoolHooks = {},
  ) {}

  private current(entry: ManagedEntry): boolean {
    return this.entries.get(entry.dir) === entry && !entry.lifetime.signal.aborted;
  }

  private connection(entry: ManagedEntry, state: ConnectionState): void {
    if (entry.connectionState === state) return;
    entry.connectionState = state;
    try { this.hooks.onConnectionState?.(entry.dir, state); }
    catch (err) { this.log(`connection callback failed: ${String(err)}`); }
  }

  /** Reservations start before ensure, closing the startup/session-create reaper gap. */
  async acquire(dir: string): Promise<RequestLease> {
    if (this.closed) throw new Error("server pool is closed");
    const key = canonicalDir(dir);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    let held: ManagedEntry | undefined;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.leases.get(key) ?? 1) - 1;
      if (n) this.leases.set(key, n); else this.leases.delete(key);
      if (held) { held.requests--; held.lastUsedAt = Date.now(); }
    };
    try {
      held = await this.ensure(key) as ManagedEntry;
      held.requests++;
      return { entry: held, release };
    }
    catch (err) { release(); throw err; }
  }

  ensure(dir: string): Promise<PoolEntry> {
    if (this.closed) return Promise.reject(new Error("server pool is closed"));
    const key = canonicalDir(dir);
    const pending = this.ensureLocks.get(key);
    if (pending) return pending.promise;
    const abort = new AbortController();
    // Publish the lock before any user callback or spawn can re-enter the pool.
    const lock = { abort, promise: null as unknown as Promise<PoolEntry> };
    lock.promise = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted();
      let entry = this.entries.get(key);
      if (entry?.status === "ready" && Date.now() - entry.lastHealthAt >= STALE_HEALTH_MS) {
        try {
          await this.probe(entry.baseUrl!, AbortSignal.any([abort.signal, entry.lifetime.signal]));
          if (!this.current(entry)) throw new Error("server generation replaced during health check");
          entry.lastHealthAt = Date.now();
        } catch (err) {
          abort.signal.throwIfAborted();
          if (!this.current(entry)) throw err;
          this.connection(entry, "reconnecting");
          // Leases reserve incoming work; existing requests/views protect work already accepted.
          if (entry.requests || this.hooks.isBusy?.(key)) throw err;
          this.retire(entry, new Error("idle server failed health check"));
          entry = undefined;
        }
      }
      abort.signal.throwIfAborted();
      if (!entry || entry.status === "dead") entry = this.spawn(key);
      await entry.ready;
      abort.signal.throwIfAborted();
      if (!this.current(entry)) throw new Error("server generation replaced during startup");
      entry.lastUsedAt = Date.now();
      return entry;
    }).finally(() => {
      if (this.ensureLocks.get(key) === lock) this.ensureLocks.delete(key);
    });
    this.ensureLocks.set(key, lock);
    return lock.promise;
  }

  get(dir: string): PoolEntry | null {
    const entry = this.entries.get(canonicalDir(dir));
    return entry?.status === "ready" ? entry : null;
  }

  reapIdle(maxIdleMs: number, isBusy: (dir: string) => boolean, now = Date.now()): number {
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      const busy = !!(this.ensureLocks.has(entry.dir) || this.leases.get(entry.dir) || entry.requests ||
        this.hooks.isBusy?.(entry.dir) || isBusy(entry.dir));
      if (this.current(entry) && shouldReap(entry, now, maxIdleMs, busy)) {
        count++;
        this.log(`idle reaper: stopping opencode server for ${entry.dir}`);
        // Retire this identity synchronously; never look up and kill a later replacement.
        this.retire(entry, new Error("idle server reaped"));
      }
    }
    return count;
  }

  list(): PoolServerInfo[] {
    return [...this.entries.values()].map((e) => ({ dir: e.dir, url: e.baseUrl, status: e.status }));
  }

  async killAll(): Promise<void> {
    for (const key of new Set([...this.entries.keys(), ...this.ensureLocks.keys()])) await this.killOne(key);
  }

  /** Bridge shutdown is terminal; late handlers cannot spawn replacement children. */
  async close(): Promise<void> {
    this.closed = true;
    await this.killAll();
  }

  async killOne(dir: string): Promise<void> {
    const key = canonicalDir(dir);
    this.ensureLocks.get(key)?.abort.abort(new Error("server startup/use canceled"));
    this.ensureLocks.delete(key);
    const entry = this.entries.get(key);
    if (entry) this.retire(entry, new Error("server stopped"));
  }

  private retire(entry: ManagedEntry, reason: Error): void {
    if (entry.killedIntentionally) return;
    const current = this.entries.get(entry.dir) === entry;
    if (current) this.entries.delete(entry.dir);
    entry.killedIntentionally = true;
    entry.status = "dead";
    entry.cancelStart(reason);
    entry.lifetime.abort(reason);
    entry.sseAbort?.abort(reason);
    if (current) this.connection(entry, "disconnected");
    try {
      if (entry.proc?.pid && process.platform !== "win32") process.kill(-entry.proc.pid, "SIGTERM");
    } catch { /* already gone */ }
    try { entry.proc?.kill("SIGTERM"); } catch { /* already gone */ }
  }

  private spawn(dir: string): ManagedEntry {
    const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: process.platform !== "win32",
    });
    const entry: ManagedEntry = {
      dir, url: null, baseUrl: null, client: null, status: "starting", ready: null as unknown as Promise<void>,
      sseAbort: null, proc: child, lastEventAt: Date.now(), lastUsedAt: Date.now(), lastHealthAt: 0,
      lifetime: new AbortController(), cancelStart: () => {}, requests: 0,
    };
    this.entries.set(dir, entry);
    let output = "";
    entry.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let probing = false;
      const finish = (error?: Error, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeListener("data", onData);
        if (error || !this.current(entry)) {
          reject(error ?? new Error("obsolete server startup"));
          this.retire(entry, error ?? new Error("obsolete server startup"));
          return;
        }
        entry.url = entry.baseUrl = url!;
        entry.client = makeClient(url!, { signal: entry.lifetime.signal, onRequest: () => {
          entry.requests++;
          entry.lastUsedAt = Date.now();
          return () => { entry.requests--; entry.lastUsedAt = Date.now(); };
        } });
        entry.status = "ready";
        entry.lastHealthAt = Date.now();
        this.log(`opencode server for ${dir} listening on ${url}`);
        resolve();
        void this.pipeEvents(entry);
        try { this.onReady?.(dir, url!); } catch (err) { this.log(`onReady failed: ${String(err)}`); }
      };
      entry.cancelStart = (err) => finish(err);
      const timer = setTimeout(() => finish(new Error(`opencode serve in ${dir} did not start within 45s`)), 45_000);
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
        if (!probing && !settled && match) {
          probing = true;
          void this.waitHealthy(match[0], entry.lifetime.signal).then(
            () => finish(undefined, match[0]), (err: Error) => finish(err),
          );
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!settled) onData(chunk);
        this.log(`opencode[${dir}] stderr: ${chunk.toString().trim()}`);
      });
      child.on("error", (err) => finish(new Error(`failed to spawn opencode: ${err.message}`)));
      child.on("exit", (code) => {
        const current = this.entries.get(dir) === entry;
        const notify = current && shouldNotifyDeath(entry.status === "ready", !!entry.killedIntentionally);
        this.log(`opencode server for ${dir} exited with code ${code}`);
        if (current) this.entries.delete(dir);
        entry.status = "dead";
        entry.lifetime.abort(new Error("server exited"));
        entry.sseAbort?.abort();
        finish(new Error(`opencode serve exited early (code ${code}):\n${output.slice(-2000)}`));
        if (current) this.connection(entry, "disconnected");
        if (notify) {
          try { this.onDeath?.(dir, code); } catch (err) { this.log(`onDeath failed: ${String(err)}`); }
        }
      });
    });
    this.connection(entry, "connecting");
    return entry;
  }

  private async probe(url: string, signal: AbortSignal, timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
    const res = await abortableFetch(`${url}/api/health`, {}, { signal, timeoutMs });
    if (!res.ok) throw new Error(`server health failed: HTTP ${res.status}`);
  }

  private async waitHealthy(url: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      signal.throwIfAborted();
      try { await this.probe(url, signal, Math.min(HEALTH_TIMEOUT_MS, Math.max(1, deadline - Date.now()))); return; }
      catch (err) { signal.throwIfAborted(); if (Date.now() >= deadline) throw err; }
      await abortableSleep(Math.min(250, deadline - Date.now()), signal);
    }
  }

  private async pipeEvents(entry: ManagedEntry): Promise<void> {
    const abort = new AbortController();
    entry.sseAbort = abort;
    const signal = AbortSignal.any([abort.signal, entry.lifetime.signal]);
    let backoffMs = 1000;
    let downSince: number | null = null;
    while (!signal.aborted && this.current(entry) && entry.status === "ready") {
      try {
        this.log(`SSE subscribing to ${entry.baseUrl}/event`);
        for await (const event of sseEvents(entry.baseUrl!, signal)) {
          if (!this.current(entry) || signal.aborted) break;
          backoffMs = 1000;
          this.connection(entry, "connected");
          if (downSince !== null) {
            const gap = Date.now() - downSince;
            downSince = null;
            try { this.onResume?.(entry.dir, gap); } catch (err) { this.log(`onResume failed: ${String(err)}`); }
            if (gap > 5 * 60_000) logErr(`SSE for ${entry.dir} was disconnected for ${Math.round(gap / 60_000)}m — reconciling missed events`);
          }
          if (isActivityEvent(event.type)) entry.lastEventAt = Date.now();
          try { this.onEvent(entry.dir, event.type, (event.properties ?? {}) as Record<string, unknown>); }
          catch (err) { this.log(`event handler error: ${String(err)}`); }
        }
      } catch (err) {
        if (signal.aborted) break;
        this.log(`SSE error for ${entry.dir}: ${String(err)}`);
      }
      if (signal.aborted || !this.current(entry)) break;
      downSince ??= Date.now();
      this.connection(entry, "reconnecting");
      try { await abortableSleep(backoffMs, signal); } catch { break; }
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  }
}
