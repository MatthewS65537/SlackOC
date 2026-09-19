import { describe, expect, it, vi, afterEach } from "vitest";
import {
  detectDefaultModel, pendingPermissions, pendingQuestions, questionReply, questionReject,
  sessionIdle, sessionMessages, sessionStatus,
} from "../src/opencode/client.js";

/**
 * Fake OCClient whose session methods record calls. `assistant` is the model
 * the server stamps on the assistant message (what a real prompt would use).
 */
function fakeClient(opts: { assistant?: { providerID: string; modelID: string }; throwOnCreate?: boolean }) {
  const calls: string[] = [];
  const client = {
    session: {
      create: async () => {
        calls.push("create");
        if (opts.throwOnCreate) throw new Error("boom");
        return { data: { id: "ses_probe" } };
      },
      promptAsync: async () => {
        calls.push("promptAsync");
        return { data: {} };
      },
      messages: async () => {
        calls.push("messages");
        const arr: Array<{ info: { role: string; providerID?: string; modelID?: string }; parts: unknown[] }> = [
          { info: { role: "user" }, parts: [] },
        ];
        if (opts.assistant) arr.push({ info: { role: "assistant", ...opts.assistant }, parts: [] });
        return arr;
      },
      abort: async () => {
        calls.push("abort");
        return { data: {} };
      },
      delete: async () => {
        calls.push("delete");
        return { data: {} };
      },
    },
  } as never;
  return { client, calls };
}

describe("detectDefaultModel", () => {
  // Unique project dir per test: the cache is module-level and keyed by dir.
  it("reads the model the server assigns, then tears down the probe session", async () => {
    const { client, calls } = fakeClient({ assistant: { providerID: "airouter", modelID: "Qwen3.8" } });
    const m = await detectDefaultModel(client, "/proj/read-model");
    expect(m).toBe("airouter/Qwen3.8");
    expect(calls).toContain("abort");
    expect(calls).toContain("delete");
  });

  it("caches per project dir — a repeat call creates no new session", async () => {
    const { client, calls } = fakeClient({ assistant: { providerID: "airouter", modelID: "Qwen3.8" } });
    await detectDefaultModel(client, "/proj/cache-hit");
    const afterFirst = calls.filter((c) => c === "create").length;
    await detectDefaultModel(client, "/proj/cache-hit");
    const afterSecond = calls.filter((c) => c === "create").length;
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it("probes different project dirs independently", async () => {
    const { client, calls } = fakeClient({ assistant: { providerID: "airouter", modelID: "Qwen3.8" } });
    await detectDefaultModel(client, "/proj/indep-a");
    await detectDefaultModel(client, "/proj/indep-b");
    expect(calls.filter((c) => c === "create").length).toBe(2);
  });

  it("returns undefined (never a guess) when the probe fails", async () => {
    const { client } = fakeClient({ throwOnCreate: true });
    expect(await detectDefaultModel(client, "/proj/boom")).toBeUndefined();
  });
});

describe("validated idle inference from the complete status map", () => {
  function client(statuses: unknown = {}) {
    const get = vi.fn(async () => ({ data: { id: "ses_probe", directory: "/project" } }));
    const status = vi.fn(async () => ({ data: statuses }));
    return { get, status, c: { session: { get, status } } as never };
  }

  it("proves an existing session idle when the successful full map omits it", async () => {
    const { c, get, status } = client({ ses_other: { type: "busy" } });
    expect(await sessionIdle(c, "ses_probe")).toBe(true);
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(status.mock.invocationCallOrder[0]!);
    expect(await sessionStatus(c)).toEqual({ ses_other: { type: "busy" } });
  });

  it.each([
    [{ type: "idle" }, true],
    [{ type: "busy" }, false],
    [{ type: "retry", attempt: 1, message: "waiting", next: 123 }, false],
  ])("handles explicit status %j", async (status, expected) => {
    expect(await sessionIdle(client({ ses_probe: status }).c, "ses_probe")).toBe(expected);
  });

  it("does not infer idle for a deleted or mismatched session", async () => {
    const missing = client();
    missing.get.mockRejectedValueOnce(new Error("HTTP 404"));
    await expect(sessionIdle(missing.c, "ses_probe")).rejects.toThrow("404");
    expect(missing.status).not.toHaveBeenCalled();
    await expect(sessionIdle(client().c, "ses_another")).rejects.toThrow("identity");
  });

  it("does not turn a status request failure into an empty map", async () => {
    const { c, status } = client();
    status.mockRejectedValueOnce(new Error("connection lost"));
    await expect(sessionIdle(c, "ses_probe")).rejects.toThrow("connection lost");
  });

  it.each([null, undefined, [], "", { error: "offline" }, { ses_probe: null },
    { ses_probe: { type: "new-unknown-state" } }, { ses_other: { type: "retry" } }])(
    "does not infer idle from malformed/unsupported status data %j", async (payload) => {
      const { c, status } = client();
      status.mockResolvedValueOnce({ data: payload });
      await expect(sessionIdle(c, "ses_probe")).rejects.toThrow("invalid session status");
    },
  );

  it("forwards caller cancellation to both requests", async () => {
    const { c, get, status } = client();
    const signal = new AbortController().signal;
    await sessionIdle(c, "ses_probe", { signal });
    expect(get).toHaveBeenCalledWith({ path: { id: "ses_probe" }, signal });
    expect(status).toHaveBeenCalledWith({ signal });
  });
});

describe("reconciliation response contracts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves assistant correlation/finish fields in SDK-wrapped and raw transcripts", async () => {
    const row = { info: { id: "msg_assistant", sessionID: "ses_probe", role: "assistant", parentID: "msg_user",
      finish: "tool-calls", time: { created: 1, completed: 2 } }, parts: [] };
    const messages = vi.fn().mockResolvedValueOnce({ data: [row] }).mockResolvedValueOnce([row]);
    const c = { session: { messages } } as never;
    expect(await sessionMessages(c, "ses_probe")).toEqual([row]);
    expect(await sessionMessages(c, "ses_probe")).toEqual([row]);
  });

  it.each([undefined, {}, null, [{ parts: [] }], [{ info: { role: "assistant" } }]])(
    "rejects malformed transcripts rather than reporting no messages: %j", async (payload) => {
      const c = { session: { messages: async () => ({ data: payload }) } } as never;
      await expect(sessionMessages(c, "ses_probe")).rejects.toThrow("invalid session messages");
    },
  );

  it("normalizes real modern pending permission fields and preserves legacy fields", async () => {
    const legacy = { id: "per_old", sessionID: "ses_probe", type: "read", title: "Read file" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { id: "per_new", sessionID: "ses_probe", permission: "bash", patterns: ["npm test"],
        always: [], metadata: { title: "Run tests" }, tool: { messageID: "msg1", callID: "call1" } },
      legacy,
    ])));
    expect(await pendingPermissions("http://localhost:4096")).toEqual([
      { id: "per_new", sessionID: "ses_probe", type: "bash", pattern: ["npm test"], title: "Run tests",
        metadata: { title: "Run tests" }, messageID: "msg1", callID: "call1" }, legacy,
    ]);
  });

  it.each([{}, null, [{ id: "broken" }]])("rejects malformed pending-interaction lists %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    await expect(pendingQuestions("http://localhost:4096")).rejects.toThrow("invalid pending questions");
    await expect(pendingPermissions("http://localhost:4096")).rejects.toThrow("invalid pending permissions");
  });

  it("propagates failed permission-list requests rather than treating them as no waits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(pendingPermissions("http://localhost:4096")).rejects.toThrow("HTTP 503");
  });
});

// ─── question API client fns (#2) ───────────────────────────────────────────

describe("pendingQuestions / questionReply / questionReject", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pendingQuestions GETs /question and parses the array", async () => {
    const payload = [{ id: "q1", sessionID: "s1", questions: [] }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("http://localhost:4096/question");
      return Response.json(payload);
    }));
    const out = await pendingQuestions("http://localhost:4096");
    expect(out).toEqual(payload);
  });

  it("pendingQuestions throws on non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(pendingQuestions("http://localhost:4096")).rejects.toThrow("HTTP 500");
  });

  it("questionReply POSTs the answers matrix to /question/{id}/reply", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return Response.json({ ok: true });
    }));
    await questionReply("http://localhost:4096", "req-1", [["React"], ["TypeScript"]]);
    expect(captured!.url).toBe("http://localhost:4096/question/req-1/reply");
    expect(captured!.init.method).toBe("POST");
    expect(JSON.parse(captured!.init.body as string)).toEqual({ answers: [["React"], ["TypeScript"]] });
  });

  it("questionReply throws on non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(questionReply("http://localhost:4096", "bad", [["x"]])).rejects.toThrow("HTTP 404");
  });

  it("questionReject POSTs to /question/{id}/reject with no body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return Response.json({ ok: true });
    }));
    await questionReject("http://localhost:4096", "req-2");
    expect(captured!.url).toBe("http://localhost:4096/question/req-2/reject");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.body).toBeUndefined();
  });
});
