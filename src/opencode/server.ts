/** Project handles over OpenCode V2's shared, authenticated background service. */
import { Service } from "@opencode/client/service";
import { canonicalDir } from "../paths.js";
import { abortableSleep } from "../http.js";
import { isSupportedOpencodeVersion } from "../version.js";
import { clientEvents, makeClient, type OCClient } from "./client.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
export interface PoolServerInfo { dir: string; url: string | null; status: "starting" | "ready" | "dead" }
export interface PoolEntry extends PoolServerInfo {
  baseUrl: string | null;
  client: OCClient | null;
  ready: Promise<void>;
  connectionState?: ConnectionState;
  /** Startup failed; the directory stays registered so its events still route. */
  failed?: boolean;
}
export interface PoolHooks {
  onConnectionState?: (dir: string, state: ConnectionState) => void;
  /** Authoritative session→directory lookup (thread bindings) for events that arrive without a location. */
  sessionDir?: (sessionID: string) => string | undefined;
}
export interface RequestLease { entry: PoolEntry; release: () => void }
/** No transport activity (events or keepalives) this long ⇒ the stream is wedged; resubscribe. */
export const EVENT_IDLE_TIMEOUT_MS = 45_000; // the service sends keepalives every 15s
/** A stream must stay up this long before reconnect backoff resets (stops connect-drop flapping). */
export const EVENT_HEALTHY_MS = 30_000;

const reasonText = (reason: unknown): string => String((reason as Error)?.message ?? reason);

export class ServerPool {
  private entries = new Map<string, PoolEntry>();
  private lifetime = new AbortController();
  private endpoint?: { url: string; headers?: Record<string, string> };
  private discovering?: Promise<void>;
  private streamAbort?: AbortController;
  private stream?: Promise<void>;
  private eventClient?: OCClient;
  private closed = false;
  private connected = false;
  private waiters = new Set<() => void>();
  /** sessionID → dir, learned from located events; routes a later location-less event for the same session. */
  private sessionDirs = new Map<string, string>();

  constructor(
    private onEvent: (dir: string, eventType: string, properties: Record<string, unknown>) => void,
    private log: (message: string) => void = () => {},
    private onResume?: (dir: string, gapMs: number) => void,
    private onReady?: (dir: string, baseUrl: string) => void,
    private hooks: PoolHooks = {},
  ) {}

  private connection(state: ConnectionState): void {
    for (const entry of this.entries.values()) {
      if (entry.connectionState === state) continue;
      entry.connectionState = state;
      this.hooks.onConnectionState?.(entry.dir, state);
    }
  }

  private discover(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("server pool is closed"));
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      const endpoint = await Service.ensure({ version: isSupportedOpencodeVersion });
      this.lifetime.signal.throwIfAborted();
      this.endpoint = { url: endpoint.url, headers: Service.headers(endpoint) };
      for (const entry of this.entries.values()) entry.url = entry.baseUrl = endpoint.url;
      this.log(`OpenCode V2 service connected: ${endpoint.url}`);
    })().finally(() => { this.discovering = undefined; });
    return this.discovering;
  }

  private client(dir?: string): OCClient {
    return makeClient(this.endpoint!.url, { directory: dir, signal: this.lifetime.signal,
      endpoint: () => this.endpoint!, onFault: () => {
        // Never retry a mutating request here. Refresh discovery; only a moved
        // service (new port/credentials) needs a new event subscription.
        if (this.closed) return;
        const before = this.endpoint?.url;
        void this.discover().then(() => {
          if (this.endpoint?.url !== before) this.streamAbort?.abort(new Error("OpenCode service moved"));
        }, err => this.log(`OpenCode rediscovery: ${String(err)}`));
      } });
  }

  ensure(dir: string): Promise<PoolEntry> {
    if (this.closed) return Promise.reject(new Error("server pool is closed"));
    const key = canonicalDir(dir);
    const existing = this.entries.get(key);
    if (existing && !existing.failed) return existing.ready.then(() => existing);
    const entry: PoolEntry = existing ?? { dir: key, url: null, baseUrl: null, status: "starting", client: null,
      ready: Promise.resolve(), connectionState: "connecting" };
    entry.failed = false;
    this.entries.set(key, entry);
    entry.ready = (async () => {
      if (!this.endpoint) await this.discover();
      if (this.closed || this.entries.get(key) !== entry) throw new Error("server handle canceled during startup");
      entry.url = entry.baseUrl = this.endpoint!.url;
      entry.client = this.client(key);
      entry.status = "ready";
      this.hooks.onConnectionState?.(key, "connecting");
      if (!this.stream) {
        this.eventClient = this.client();
        this.stream = this.pipeEvents();
      }
      if (!this.connected) await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); this.waiters.delete(ready); resolve(); };
        const timer = setTimeout(() => { this.waiters.delete(ready); reject(new Error("OpenCode event connection did not become ready within 10s")); }, 10_000);
        this.waiters.add(ready);
      });
      if (this.closed || this.entries.get(key) !== entry) throw new Error("server handle canceled during startup");
      entry.connectionState = "connected";
      this.hooks.onConnectionState?.(key, "connected");
      this.onReady?.(key, entry.url);
    })().catch(err => {
      // Keep the directory registered (not "ready"): its events keep routing
      // and onResume still reconciles its views once the stream returns. The
      // next ensure() retries startup.
      if (this.entries.get(key) === entry && !this.closed) { entry.failed = true; entry.status = "starting"; }
      else entry.status = "dead";
      throw err;
    });
    return entry.ready.then(() => entry);
  }

  /** Nothing tracks leases; release() is a no-op kept so callers retain their try/finally shape. */
  private lease(entry: PoolEntry): RequestLease {
    return { entry, release: () => {} };
  }
  async acquire(dir: string): Promise<RequestLease> { return this.lease(await this.ensure(dir)); }
  acquireExisting(dir: string): RequestLease | undefined {
    const entry = this.get(dir);
    return !this.closed && entry ? this.lease(entry) : undefined;
  }
  get(dir: string): PoolEntry | null {
    const entry = this.entries.get(canonicalDir(dir));
    return entry?.status === "ready" ? entry : null;
  }
  list(): PoolServerInfo[] { return [...this.entries.values()].map(({ dir, url, status }) => ({ dir, url, status })); }
  async killOne(dir: string): Promise<void> {
    const key = canonicalDir(dir); const entry = this.entries.get(key);
    if (!entry) return;
    entry.status = "dead";
    this.entries.delete(key);
    this.hooks.onConnectionState?.(key, "disconnected");
  }
  async killAll(): Promise<void> { for (const key of this.entries.keys()) await this.killOne(key); }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error("bridge closed"));
    this.streamAbort?.abort();
    for (const ready of this.waiters) ready();
    await this.killAll();
    await this.stream;
    // Never stop a service owned by OpenCode or another interface.
  }
  async reconnect(): Promise<void> {
    await this.discover();
    this.streamAbort?.abort(new Error("reconnect requested"));
  }

  /**
   * Native session events carry a location. One that lacks it is routed by its
   * session's known directory and dropped when that is unknown, never guessed.
   * The only translated event without a session (server.connected) is global
   * and has no per-directory consumer, so it is dropped too.
   */
  private route(directory: string | undefined, props: Record<string, unknown>): string | undefined {
    const sid = (props.sessionID ?? (props.info as { sessionID?: unknown } | undefined)?.sessionID
      ?? (props.part as { sessionID?: unknown } | undefined)?.sessionID) as string | undefined;
    if (directory) {
      const dir = canonicalDir(directory);
      if (!this.entries.has(dir)) return;
      if (typeof sid === "string") this.sessionDirs.set(sid, dir);
      return dir;
    }
    if (typeof sid !== "string") return;
    const known = this.sessionDirs.get(sid) ?? this.hooks.sessionDir?.(sid);
    const dir = known ? canonicalDir(known) : undefined;
    return dir && this.entries.has(dir) ? dir : undefined;
  }

  private async pipeEvents(): Promise<void> {
    let delay = 100; let downSince = Date.now(); let connected = false; let connectedAt = 0;
    while (!this.closed) {
      const streamAbort = this.streamAbort = new AbortController();
      const signal = AbortSignal.any([this.lifetime.signal, streamAbort.signal]);
      // Idle watchdog: an open-but-silent stream (hung service, half-dead
      // socket after sleep) would otherwise never be noticed.
      let idle: NodeJS.Timeout | undefined;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => streamAbort.abort(new Error(`no OpenCode stream activity for ${EVENT_IDLE_TIMEOUT_MS / 1000}s`)), EVENT_IDLE_TIMEOUT_MS);
        idle.unref?.();
      };
      touch();
      try {
        for await (const event of clientEvents(this.eventClient!, signal, touch)) {
          if (this.closed) return;
          if (!connected) {
            connected = true; connectedAt = Date.now();
            this.connected = true;
            for (const entry of this.entries.values()) {
              // A directory whose startup timed out waiting for this stream is usable now.
              if (entry.failed && this.endpoint) {
                entry.failed = false; entry.status = "ready"; entry.ready = Promise.resolve();
                entry.url = entry.baseUrl = this.endpoint.url; entry.client ??= this.client(entry.dir);
              }
            }
            for (const ready of this.waiters) ready();
            this.connection("connected");
            for (const entry of this.entries.values()) this.onResume?.(entry.dir, Date.now() - downSince);
          }
          const props = (event.properties ?? {}) as Record<string, unknown>;
          const dir = this.route(event.directory, props);
          if (dir) this.onEvent(dir, event.type, props);
        }
        if (!this.closed) this.log(`OpenCode event connection ended${streamAbort.signal.aborted ? `: ${reasonText(streamAbort.signal.reason)}` : ""}`);
      } catch (err) {
        if (!this.closed) this.log(`OpenCode event connection: ${streamAbort.signal.aborted ? reasonText(streamAbort.signal.reason) : String(err)}`);
      } finally { clearTimeout(idle); }
      if (this.closed) return;
      if (connected) downSince = Date.now();
      // Only a stream that stayed up resets backoff; connect-then-drop keeps growing it.
      if (connected && Date.now() - connectedAt >= EVENT_HEALTHY_MS) delay = 100;
      connected = false;
      this.connected = false;
      this.connection("reconnecting");
      try {
        await abortableSleep(delay, this.lifetime.signal);
        await this.discover();
      } catch (err) { if (this.closed) return; this.log(`OpenCode discovery: ${String(err)}`); }
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
