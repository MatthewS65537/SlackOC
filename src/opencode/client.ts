/**
 * Slim wrapper layer over @opencode-ai/sdk: client construction, response
 * unwrapping, and a hand-rolled SSE reader for GET /event.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
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

export function makeClient(baseUrl: string, options: RequestOptions & { onRequest?: () => () => void } = {}): OCClient {
  return createOpencodeClient({ baseUrl, throwOnError: true, fetch: async (request) => {
    const release = options.onRequest?.();
    const timeoutMs = new URL(request.url).pathname.endsWith("/command") ? COMMAND_TIMEOUT_MS : options.timeoutMs;
    try { return await abortableFetch(request, {}, { ...options, timeoutMs }); }
    finally { release?.(); }
  } });
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
 * Idle in THIS client's server/directory scope, not proof that a task succeeded.
 * Verified against OpenCode 1.18.31: SessionStatus.set(id, idle) deletes the key;
 * get(id) defaults to idle, and GET /session/status returns all of list().
 * Confirm existence first, then fetch/validate that full map. HTTP failures,
 * malformed payloads, and a missing session throw; never substitute {} for them.
 * Callers must still check the newest transcript, pending interactions, and run
 * generation. This does not observe runners hosted in a different server process.
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
    /** Caller correlation ID supported by prompt_async; not a promise of idempotent retries. */
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

/** projectDir → "provider/model". One dir = one server = one default. */
const defaultModelCache = new Map<string, string>();

/**
 * Resolve the model a bare prompt would ACTUALLY use, by asking the server.
 * The server stamps providerID/modelID on the assistant message before the LLM
 * produces output, so a trivial probe reads it in ~250ms, then aborts + deletes
 * the throwaway session. Cached per project dir so it runs once per server.
 * Returns undefined (never a guess) if the probe fails — callers show no star.
 */
export async function detectDefaultModel(c: OCClient, projectDir: string): Promise<string | undefined> {
  const hit = defaultModelCache.get(projectDir);
  if (hit) return hit;
  let model: string | undefined;
  let sess: OcSession | undefined;
  try {
    sess = await sessionCreate(c);
    await promptAsync(c, sess.id, "ping");
    for (let i = 0; i < 24; i++) {
      const msgs = await sessionMessages(c, sess.id);
      const a = msgs.find((m) => m.info?.role === "assistant");
      if (a?.info?.providerID && a?.info?.modelID) {
        model = `${a.info.providerID}/${a.info.modelID}`;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    /* probe failed — leave undefined */
  } finally {
    if (sess) {
      await sessionAbort(c, sess.id).catch(() => {});
      await sessionDelete(c, sess.id).catch(() => {});
    }
  }
  if (model) defaultModelCache.set(projectDir, model);
  return model;
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

/** GET /permission — pending permissions in this server/directory scope, normalized across API versions. */
export async function pendingPermissions(baseUrl: string, options: RequestOptions = {}): Promise<OcPermission[]> {
  const res = await abortableFetch(`${baseUrl}/permission`, {}, options);
  if (!res.ok) throw new Error(`permission list failed: HTTP ${res.status}`);
  const result: unknown = await res.json();
  if (!Array.isArray(result) || result.some((row) => !isRecord(row) ||
    typeof row.id !== "string" || typeof row.sessionID !== "string" ||
    (typeof row.permission !== "string" && typeof row.type !== "string"))) {
    throw new Error("invalid pending permissions response");
  }
  return result.map(normalizePermission);
}

/**
 * GET /question — pending questions in this server/directory scope. The
 * pinned v1 SDK has no typed wrapper, so this is a raw fetch like
 * pendingPermissions; base URL comes from PoolEntry.url.
 */
export async function pendingQuestions(baseUrl: string, options: RequestOptions = {}): Promise<OcQuestionRequest[]> {
  const res = await abortableFetch(`${baseUrl}/question`, {}, options);
  if (!res.ok) throw new Error(`question list failed: HTTP ${res.status}`);
  const result: unknown = await res.json();
  if (!Array.isArray(result) || result.some((row) => !isRecord(row) ||
    typeof row.id !== "string" || typeof row.sessionID !== "string" || !Array.isArray(row.questions))) {
    throw new Error("invalid pending questions response");
  }
  return result as OcQuestionRequest[];
}

/**
 * POST /question/{id}/reply — answer a parked question. `answers` is one
 * label-array per question, in question order (single-select ⇒ one label each).
 */
export async function questionReply(baseUrl: string, requestId: string, answers: string[][], options: RequestOptions = {}): Promise<unknown> {
  const res = await abortableFetch(`${baseUrl}/question/${requestId}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  }, options);
  if (!res.ok) throw new Error(`question reply failed: HTTP ${res.status}`);
  return res.json();
}

/** POST /question/{id}/reject — skip a parked question (unblocks the run). */
export async function questionReject(baseUrl: string, requestId: string, options: RequestOptions = {}): Promise<unknown> {
  const res = await abortableFetch(`${baseUrl}/question/${requestId}/reject`, { method: "POST" }, options);
  if (!res.ok) throw new Error(`question reject failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Hand-rolled SSE reader for GET /event. Yields parsed event objects.
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
    const res = await fetch(`${url}/event`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
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
