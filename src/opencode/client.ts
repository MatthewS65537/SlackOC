/**
 * Slim wrapper layer over @opencode-ai/sdk: client construction, response
 * unwrapping, and a hand-rolled SSE reader for GET /event.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type {
  OCClient,
  OcEvent,
  OcFileDiff,
  OcMessageInfo,
  OcPart,
  OcSession,
  OcPermission,
  OcQuestionRequest,
} from "./api.js";

export type { OCClient };

export function makeClient(baseUrl: string): OCClient {
  return createOpencodeClient({ baseUrl, throwOnError: true });
}

/** RequestResult can be {data} or raw depending on sdk version — normalize. */
export async function data<T>(p: Promise<unknown>): Promise<T> {
  const r = (await p) as { data?: unknown } | unknown;
  if (r && typeof r === "object" && "data" in r) return (r as { data: T }).data;
  return r as T;
}

export async function sessionCreate(c: OCClient, title?: string): Promise<OcSession> {
  return data(c.session.create({ body: title ? { title } : {} }));
}

export async function sessionGet(c: OCClient, id: string): Promise<OcSession> {
  return data(c.session.get({ path: { id } }));
}

/** All messages (info + parts) of a session — used by finalize's delivery backstop. */
export async function sessionMessages(
  c: OCClient,
  id: string,
): Promise<Array<{ info: OcMessageInfo; parts: OcPart[] }>> {
  const r = (await c.session.messages({ path: { id } })) as unknown as
    | Array<{ info: OcMessageInfo; parts: OcPart[] }>
    | { data?: Array<{ info: OcMessageInfo; parts: OcPart[] }> };
  // Response shape varies by sdk version: {data} wrapper or bare array.
  return (Array.isArray(r) ? r : r.data) ?? [];
}

export async function sessionList(c: OCClient): Promise<OcSession[]> {
  return data(c.session.list());
}

export async function sessionDiff(c: OCClient, id: string): Promise<OcFileDiff[]> {
  return data(c.session.diff({ path: { id } }));
}

export async function sessionAbort(c: OCClient, id: string): Promise<unknown> {
  return data(c.session.abort({ path: { id } }));
}

export async function sessionDelete(c: OCClient, id: string): Promise<unknown> {
  return data(c.session.delete({ path: { id } }));
}

export async function promptAsync(
  c: OCClient,
  id: string,
  text: string,
  opts: {
    model?: string;
    agent?: string;
    title?: string;
    /** Images (data URIs) to attach — Slack screenshots etc. */
    files?: Array<{ mime: string; filename?: string; dataUrl: string }>;
  } = {},
): Promise<void> {
  const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const f of opts.files ?? []) parts.push({ type: "file", mime: f.mime, filename: f.filename, url: f.dataUrl });
  const body: Record<string, unknown> = { parts };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) {
    const slash = opts.model.indexOf("/");
    if (slash > 0) {
      body.model = { providerID: opts.model.slice(0, slash), modelID: opts.model.slice(slash + 1) };
    }
  }
  await data(c.session.promptAsync({ path: { id }, body } as never));
}

export async function sessionCommand(c: OCClient, id: string, command: string, args: string): Promise<unknown> {
  return data(c.session.command({ path: { id }, body: { command, arguments: args } }));
}

export async function permRespond(
  c: OCClient,
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject",
): Promise<unknown> {
  return data(
    c.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    }),
  );
}

export interface ProvidersInfo {
  providers: Array<{ id: string; name: string; models: Record<string, { id: string; name: string; capabilities?: { reasoning?: boolean } }> }>;
  default: Record<string, string>;
}

export async function configProviders(c: OCClient): Promise<ProvidersInfo> {
  return data(c.config.providers());
}

/** Raw server config — `model` is the configured default ("provider/model") when set. */
export interface OcConfigInfo {
  model?: string;
  [key: string]: unknown;
}

export async function configGet(c: OCClient): Promise<OcConfigInfo> {
  return data(c.config.get());
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

export async function agentsList(c: OCClient): Promise<AgentInfo[]> {
  return data(c.app.agents());
}

/** GET /permission — global pending permission list (polling fallback if SSE misses an event). */
export async function pendingPermissions(baseUrl: string): Promise<OcPermission[]> {
  const res = await fetch(`${baseUrl}/permission`);
  if (!res.ok) throw new Error(`permission list failed: HTTP ${res.status}`);
  return (await res.json()) as OcPermission[];
}

/**
 * GET /question — global pending question list (boot-recovery sweep). The
 * pinned v1 SDK has no typed wrapper, so this is a raw fetch like
 * pendingPermissions; base URL comes from PoolEntry.url.
 */
export async function pendingQuestions(baseUrl: string): Promise<OcQuestionRequest[]> {
  const res = await fetch(`${baseUrl}/question`);
  if (!res.ok) throw new Error(`question list failed: HTTP ${res.status}`);
  return (await res.json()) as OcQuestionRequest[];
}

/**
 * POST /question/{id}/reply — answer a parked question. `answers` is one
 * label-array per question, in question order (single-select ⇒ one label each).
 */
export async function questionReply(baseUrl: string, requestId: string, answers: string[][]): Promise<unknown> {
  const res = await fetch(`${baseUrl}/question/${requestId}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) throw new Error(`question reply failed: HTTP ${res.status}`);
  return res.json();
}

/** POST /question/{id}/reject — skip a parked question (unblocks the run). */
export async function questionReject(baseUrl: string, requestId: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/question/${requestId}/reject`, { method: "POST" });
  if (!res.ok) throw new Error(`question reject failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Hand-rolled SSE reader for GET /event. Yields parsed event objects.
 * Throws on connection failure; res.body ends when the server closes.
 */
export async function* sseEvents(url: string, signal: AbortSignal): AsyncGenerator<OcEvent> {
  const res = await fetch(`${url}/event`, {
    signal,
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) throw new Error(`SSE subscribe failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const s = line.slice(5).trim();
        if (!s || s === "[DONE]") continue;
        try {
          yield JSON.parse(s) as OcEvent;
        } catch {
          /* malformed event line — skip */
        }
      }
    }
  }
}
