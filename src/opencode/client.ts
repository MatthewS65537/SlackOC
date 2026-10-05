/**
 * OpenCode V2 client and bridge-facing compatibility port. All production
 * requests use @opencode/client with service authentication and locations.
 */

import { OpenCode, type OpenCodeClient, type SessionMessageInfo } from "@opencode/client";
import { normalizeForm, formAnswer, normalizeMessages, V2Events } from "./v2.js";
import { abortableFetch, COMMAND_TIMEOUT_MS, type RequestOptions } from "../http.js";
import { normalizePermission } from "./api.js";
import type {
  OCClient,
  OcEvent,
  OcFileDiff,
  OcMessageInfo,
  OcPart,
  OcSession,
  OcSessionStatus,
  OcPermission,
  OcQuestionRequest,
} from "./api.js";

export type { OCClient };

function usefulError(error: unknown): never {
  const e = error as { reason?: string; cause?: unknown; message?: string };
  if (e?.reason === "Transport" && e.cause instanceof Error) throw e.cause;
  const cause = e?.cause as { status?: number } | undefined;
  if (e?.reason === "UnexpectedStatus" && cause?.status) throw new Error(`HTTP ${cause.status}`, { cause: error });
  throw error;
}

function readableErrors<T extends object>(object: T): T {
  return new Proxy(object, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value === "function") return (...args: unknown[]) => {
      const result = value.apply(target, args);
      return result instanceof Promise ? result.catch(usefulError) : result;
    };
    return value && typeof value === "object" ? readableErrors(value) : value;
  } });
}

export interface ClientOptions extends RequestOptions {
  directory?: string;
  headers?: Record<string, string>;
  endpoint?: () => { url: string; headers?: Record<string, string> };
  onFault?: () => void;
  onRequest?: () => () => void;
}

export function makeClient(baseUrl: string, options: ClientOptions = {}): OCClient {
  const native = readableErrors(OpenCode.make({ baseUrl, headers: options.headers, fetch: async (input, init) => {
    let request = new Request(input, init);
    const endpoint = options.endpoint?.();
    if (endpoint) {
      const url = new URL(request.url);
      const target = new URL(endpoint.url);
      url.protocol = target.protocol; url.host = target.host;
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      for (const [k, v] of Object.entries(endpoint.headers ?? {})) headers.set(k, v);
      request = new Request(url, { method: request.method, headers, body: request.body,
        signal: request.signal, ...(request.body ? { duplex: "half" } : {}) } as RequestInit);
    }
    if (new URL(request.url).pathname === "/api/event") return fetch(request);
    const release = options.onRequest?.();
    const timeoutMs = new URL(request.url).pathname.endsWith("/command") ? COMMAND_TIMEOUT_MS : options.timeoutMs;
    try {
      const response = await abortableFetch(request, {}, { ...options, timeoutMs });
      if (response.status === 401 || response.status >= 500) options.onFault?.();
      return response;
    } catch (err) { if (!options.signal?.aborted) options.onFault?.(); throw err; }
    finally { release?.(); }
  } }));
  const location = options.directory ? { directory: options.directory } : undefined;
  const normalizeSession = (s: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>): OcSession =>
    ({ ...s, directory: s.location.directory, title: s.title ?? "" });
  const modelSettings = new Map<string, { model?: string; agent?: string }>();
  return { v2: native, directory: options.directory,
    session: {
      create: async ({ body, signal } = {}) => normalizeSession(await native.session.create({ title: body?.title, location }, { signal })),
      get: async ({ path, signal }) => normalizeSession(await native.session.get({ sessionID: path.id }, { signal })),
      status: async ({ signal } = {}) => Object.fromEntries(Object.entries(await native.session.active({ signal })).map(([id]) => [id, { type: "busy" }])),
      list: async ({ signal } = {}) => {
        const all: OcSession[] = []; let cursor: string | undefined;
        do {
          const page = await native.session.list({ limit: 100, ...(cursor ? { cursor } : { order: "desc" as const }) }, { signal });
          all.push(...page.data.map(normalizeSession));
          const next = page.cursor.next ?? undefined;
          if (next && next === cursor) throw new Error("Repeated session pagination cursor");
          cursor = next;
        } while (cursor);
        return all;
      },
      messages: async ({ path, signal }) => {
        const all: SessionMessageInfo[] = []; let cursor: string | undefined;
        do {
          const page = await native.message.list({ sessionID: path.id, limit: 100, ...(cursor ? { cursor } : { order: "asc" as const }) }, { signal });
          all.push(...page.data);
          const next = page.cursor.next ?? undefined;
          if (next && next === cursor) throw new Error("Repeated message pagination cursor");
          cursor = next;
        } while (cursor);
        const rows = normalizeMessages(all, path.id);
        // Admission is durable before a queued input appears in the transcript.
        for (const item of await native.session.inbox.list({ sessionID: path.id }, { signal })) {
          if (item.type === "user" && !rows.some(r => r.info.id === item.id)) rows.push({
            info: { id: item.id, sessionID: path.id, role: "user", time: item.time }, parts: [],
          });
        }
        return rows;
      },
      diff: async ({ path, signal }) => (await native.session.diff({ sessionID: path.id }, { signal }))
        .map(d => ({ ...d, before: "", after: "" })),
      abort: ({ path, signal }) => native.session.interrupt({ sessionID: path.id }, { signal }),
      delete: ({ path, signal }) => native.session.remove({ sessionID: path.id }, { signal }),
      promptAsync: async ({ path, body, signal }) => {
        const sessionID = path.id as string;
        const known = modelSettings.get(sessionID) ?? {};
        if (body.agent && known.agent !== body.agent) {
          await native.session.switchAgent({ sessionID, agent: body.agent }, { signal }); known.agent = body.agent;
        }
        if (body.model) {
          const key = `${body.model.providerID}/${body.model.modelID}`;
          if (known.model !== key) {
            const [id, variant] = body.model.modelID.split("#");
            await native.session.switchModel({ sessionID, model: { providerID: body.model.providerID, id, variant } }, { signal });
            known.model = key;
          }
        }
        modelSettings.set(sessionID, known);
        return native.session.prompt({ sessionID, id: body.messageID,
          text: body.parts.filter((p: OcPart) => p.type === "text").map((p: OcPart) => p.text).join("\n"),
          files: body.parts.filter((p: OcPart) => p.type === "file").map((p: OcPart) => ({ uri: p.url!, name: p.filename })), delivery: "queue" }, { signal });
      },
      command: ({ path, body, signal }) => native.session.command({ sessionID: path.id, name: body.command, text: body.arguments, delivery: "queue" }, { signal }),
    },
    config: {
      get: async ({ signal } = {}) => {
        const model = (await native.model.default({ location }, { signal })).data;
        return { model: model ? `${model.providerID}/${model.id}` : undefined };
      },
      providers: async ({ signal } = {}) => {
        const models = (await native.model.list({ location }, { signal })).data.filter(m => m.enabled);
        const ids = [...new Set(models.map(m => m.providerID))];
        return { providers: ids.map(id => ({ id, name: id, models: Object.fromEntries(models.filter(m => m.providerID === id).map(m => [m.id, m])) })), default: {} };
      },
    },
    app: { agents: async ({ signal } = {}) => (await native.agent.list({ location }, { signal })).data
      .filter(a => !a.hidden).map(a => ({ ...a, name: a.id })) },
    postSessionIdPermissionsPermissionId: ({ path, body, signal }) => native.permission.reply({ sessionID: path.id, requestID: path.permissionID, decision: body.response }, { signal }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Full, non-paginated map. OpenCode removes idle entries; use sessionIdle for that inference. */
export async function sessionStatus(c: OCClient, options: { signal?: AbortSignal } = {}): Promise<Record<string, OcSessionStatus>> {
  const result = await data<unknown>(c.session.status({ signal: options.signal }));
  if (!isRecord(result) || Object.values(result).some((status) => {
    if (!isRecord(status)) return true;
    if (status.type === "idle" || status.type === "busy") return false;
    return status.type !== "retry" || typeof status.message !== "string" ||
      typeof status.attempt !== "number" || !Number.isFinite(status.attempt) ||
      typeof status.next !== "number" || !Number.isFinite(status.next);
  })) throw new Error("invalid session status response");
  return result as Record<string, OcSessionStatus>;
}

/**
 * Idle in the shared service, not proof that a task succeeded.
 * V2 session.active lists running sessions; absent IDs require existence checks.
 * Confirm existence first, then fetch/validate that full map. HTTP failures,
 * malformed payloads, and a missing session throw; never substitute {} for them.
 * Callers must still check the newest transcript, pending interactions, and run
 * generation. A separate standalone OpenCode service is outside this scope.
 */
export async function sessionIdle(c: OCClient, id: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
  const session = await sessionGet(c, id, options.signal);
  if (!session || session.id !== id) throw new Error("session idle probe could not confirm session identity");
  const statuses = await sessionStatus(c, options);
  return !Object.hasOwn(statuses, id) || statuses[id]?.type === "idle";
}

/** RequestResult can be {data} or raw depending on sdk version — normalize. */
export async function data<T>(p: Promise<unknown>): Promise<T> {
  const r = (await p) as { data?: unknown } | unknown;
  if (r && typeof r === "object" && "data" in r) return (r as { data: T }).data;
  return r as T;
}

export async function sessionCreate(c: OCClient, title?: string, signal?: AbortSignal): Promise<OcSession> {
  return data(c.session.create({ body: title ? { title } : {}, signal }));
}

export async function sessionGet(c: OCClient, id: string, signal?: AbortSignal): Promise<OcSession> {
  return data(c.session.get({ path: { id }, signal }));
}

/** All messages (info + parts) of a session — used by finalize's delivery backstop. */
export async function sessionMessages(
  c: OCClient,
  id: string,
  signal?: AbortSignal,
): Promise<Array<{ info: OcMessageInfo; parts: OcPart[] }>> {
  const result = await data<unknown>(c.session.messages({ path: { id }, signal }));
  if (!Array.isArray(result) || result.some((row) => !isRecord(row) ||
    !isRecord(row.info) || typeof row.info.role !== "string" || !Array.isArray(row.parts))) {
    throw new Error("invalid session messages response");
  }
  return result as Array<{ info: OcMessageInfo; parts: OcPart[] }>;
}

export async function sessionList(c: OCClient, signal?: AbortSignal): Promise<OcSession[]> {
  return data(c.session.list({ signal }));
}

export async function sessionDiff(c: OCClient, id: string, signal?: AbortSignal): Promise<OcFileDiff[]> {
  return data(c.session.diff({ path: { id }, signal }));
}

export async function sessionAbort(c: OCClient, id: string, signal?: AbortSignal): Promise<unknown> {
  return data(c.session.abort({ path: { id }, signal }));
}

export async function sessionDelete(c: OCClient, id: string, signal?: AbortSignal): Promise<unknown> {
  return data(c.session.delete({ path: { id }, signal }));
}

export async function promptAsync(
  c: OCClient,
  id: string,
  text: string,
  opts: {
    model?: string;
    agent?: string;
    title?: string;
    /** Durable V2 inbox/message ID used for evidence-based recovery. */
    messageID?: string;
    signal?: AbortSignal;
    /** Images (data URIs) to attach — Slack screenshots etc. */
    files?: Array<{ mime: string; filename?: string; dataUrl: string }>;
  } = {},
): Promise<void> {
  const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const f of opts.files ?? []) parts.push({ type: "file", mime: f.mime, filename: f.filename, url: f.dataUrl });
  const body: Record<string, unknown> = { parts };
  if (opts.messageID) body.messageID = opts.messageID;
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) {
    const slash = opts.model.indexOf("/");
    if (slash > 0) {
      body.model = { providerID: opts.model.slice(0, slash), modelID: opts.model.slice(slash + 1) };
    }
  }
  await data(c.session.promptAsync({ path: { id }, body, signal: opts.signal } as never));
}

export async function sessionCommand(c: OCClient, id: string, command: string, args: string, signal?: AbortSignal): Promise<unknown> {
  return data(c.session.command({ path: { id }, body: { command, arguments: args }, signal }));
}

export async function permRespond(
  c: OCClient,
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject",
  signal?: AbortSignal,
): Promise<unknown> {
  return data(
    c.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
      signal,
    }),
  );
}

export interface ProvidersInfo {
  providers: Array<{ id: string; name: string; models: Record<string, { id: string; name: string; capabilities?: { reasoning?: boolean } }> }>;
  default: Record<string, string>;
}

export async function configProviders(c: OCClient, signal?: AbortSignal): Promise<ProvidersInfo> {
  return data(c.config.providers({ signal }));
}

/** Raw server config — `model` is the configured default ("provider/model") when set. */
export interface OcConfigInfo {
  model?: string;
  [key: string]: unknown;
}

export async function configGet(c: OCClient, signal?: AbortSignal): Promise<OcConfigInfo> {
  return data(c.config.get({ signal }));
}

/** Resolve the location's default model without spending tokens or creating a session. */
export async function detectDefaultModel(c: OCClient, _projectDir: string): Promise<string | undefined> {
  return (await configGet(c)).model;
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode: string;
  builtIn?: boolean;
}

export async function agentsList(c: OCClient, signal?: AbortSignal): Promise<AgentInfo[]> {
  return data(c.app.agents({ signal }));
}

/** GET /api/permission/request — pending permissions in this location. */
export async function pendingPermissions(client: OCClient | string, options: RequestOptions = {}): Promise<OcPermission[]> {
  const c = typeof client === "string" ? makeClient(client, options) : client;
  const result: unknown = (await c.v2!.permission.request.list({ location: c.directory ? { directory: c.directory } : undefined }, options))?.data;
  if (!Array.isArray(result) || result.some((row) => !isRecord(row) ||
    typeof row.id !== "string" || typeof row.sessionID !== "string" ||
    (typeof row.action !== "string" && typeof row.permission !== "string" && typeof row.type !== "string"))) {
    throw new Error("invalid pending permissions response");
  }
  return result.map(normalizePermission);
}

/** GET /api/form — pending session forms in this location. */
export async function pendingQuestions(client: OCClient | string, options: RequestOptions = {}): Promise<OcQuestionRequest[]> {
  const c = typeof client === "string" ? makeClient(client, options) : client;
  const result = (await c.v2!.form.list({ location: c.directory ? { directory: c.directory } : undefined }, options))?.data;
  if (!Array.isArray(result) || result.some(r => !r || typeof r.id !== "string" || typeof r.sessionID !== "string" || !Array.isArray(r.fields))) throw new Error("invalid pending questions response");
  return result.map(normalizeForm);
}

/**
 * Reply to a V2 form. `answers` contains option values or free text, converted
 * into the field-keyed, typed FormAnswer contract before submission.
 */
export async function questionReply(client: OCClient | string, requestId: string, answers: string[][], options: RequestOptions & { request?: OcQuestionRequest } = {}): Promise<unknown> {
  const c = typeof client === "string" ? makeClient(client) : client;
  const req = options.request ?? (await pendingQuestions(c, options)).find(q => q.id === requestId);
  if (!req) throw new Error("Form is no longer pending");
  return c.v2!.session.form.reply({ sessionID: req.sessionID, formID: req.id, answer: formAnswer(req, answers) }, options);
}

/** DELETE /api/session/{sessionID}/form/{formID} — cancel a pending form. */
export async function questionReject(client: OCClient | string, requestId: string, options: RequestOptions & { sessionId?: string } = {}): Promise<unknown> {
  const c = typeof client === "string" ? makeClient(client) : client;
  const sessionID = options.sessionId ?? (await pendingQuestions(c, options)).find(q => q.id === requestId)?.sessionID;
  if (!sessionID) throw new Error("Form is no longer pending");
  return c.v2!.session.form.cancel({ sessionID, formID: requestId }, options);
}

/**
 * Raw SSE diagnostic reader. Production subscriptions use clientEvents below.
 * Throws on connection failure; res.body ends when the server closes.
 */
// Installed server binary emits server.heartbeat every 10 seconds (Sep 18, 2026).
// Six missed beats allow scheduling jitter without an overall run lifetime limit.
export const SSE_IDLE_TIMEOUT_MS = 60_000;

export async function* sseEvents(url: string, signal: AbortSignal, idleMs = SSE_IDLE_TIMEOUT_MS): AsyncGenerator<OcEvent> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const cancelReader = () => { void reader?.cancel(controller.signal.reason).catch(() => {}); };
  const cancel = () => controller.abort(signal.reason);
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`SSE idle timeout (${idleMs / 1000}s)`)), idleMs);
    timer.unref?.();
  };
  controller.signal.addEventListener("abort", cancelReader);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  reset();
  try {
    controller.signal.throwIfAborted();
    const res = await fetch(`${url}/api/event`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {});
      throw new Error(`SSE subscribe failed: HTTP ${res.status}`);
    }
    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      reset();
      buf += dec.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buf))) {
        const frame = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        const payload = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!payload || payload === "[DONE]") continue;
        let event: OcEvent;
        try { event = JSON.parse(payload) as OcEvent; } catch { continue; }
        if (event && typeof event.type === "string") yield event;
      }
      if (buf.length > 4 * 1024 * 1024) throw new Error("SSE frame exceeds 4 MiB");
    }
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", cancelReader);
    controller.abort();
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

/** V2 subscriptions are live-only. The pool owns resubscription and reconciliation. */
export async function* clientEvents(client: OCClient, signal: AbortSignal): AsyncGenerator<OcEvent> {
  const adapter = new V2Events();
  for await (const event of client.v2!.event.subscribe({ signal })) {
    for (const mapped of adapter.translate(event)) yield { ...mapped, directory: event.location?.directory };
  }
}
