import { describe, expect, it, vi, afterEach } from "vitest";
import { detectDefaultModel, pendingQuestions, questionReply, questionReject } from "../src/opencode/client.js";

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

// ─── question API client fns (#2) ───────────────────────────────────────────

describe("pendingQuestions / questionReply / questionReject", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pendingQuestions GETs /question and parses the array", async () => {
    const payload = [{ id: "q1", sessionID: "s1", questions: [] }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("http://localhost:4096/question");
      return { ok: true, json: async () => payload };
    }));
    const out = await pendingQuestions("http://localhost:4096");
    expect(out).toEqual(payload);
  });

  it("pendingQuestions throws on non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(pendingQuestions("http://localhost:4096")).rejects.toThrow("HTTP 500");
  });

  it("questionReply POSTs the answers matrix to /question/{id}/reply", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ ok: true }) };
    }));
    await questionReply("http://localhost:4096", "req-1", [["React"], ["TypeScript"]]);
    expect(captured!.url).toBe("http://localhost:4096/question/req-1/reply");
    expect(captured!.init.method).toBe("POST");
    expect(JSON.parse(captured!.init.body as string)).toEqual({ answers: [["React"], ["TypeScript"]] });
  });

  it("questionReply throws on non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(questionReply("http://localhost:4096", "bad", [["x"]])).rejects.toThrow("HTTP 404");
  });

  it("questionReject POSTs to /question/{id}/reject with no body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ ok: true }) };
    }));
    await questionReject("http://localhost:4096", "req-2");
    expect(captured!.url).toBe("http://localhost:4096/question/req-2/reject");
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.body).toBeUndefined();
  });
});
