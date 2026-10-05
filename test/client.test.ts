import { describe, expect, it, vi, afterEach } from "vitest";
import { makeClient, detectDefaultModel, pendingPermissions, pendingQuestions, questionReply, questionReject,
  sessionIdle, sessionMessages, sessionStatus, promptAsync, permRespond } from "../src/opencode/client.js";
import { formAnswer, visibleQuestions, normalizeForm, V2Events } from "../src/opencode/v2.js";
import type { FormInfo, V2Event } from "@opencode/client";

afterEach(() => vi.unstubAllGlobals());
const form: FormInfo = { id: "frm_test", sessionID: "ses_test", title: "Choose", fields: [
  { key: "framework", type: "string", options: [{ label: "React (recommended)", value: "react" }] },
  { key: "features", type: "multiselect", options: [{ label: "TypeScript", value: "ts" }] },
] };
function wire(handler: (request: Request) => Response | Promise<Response>) {
  const mock = vi.fn((input: Request) => handler(input)); vi.stubGlobal("fetch", mock); return mock;
}

describe("V2 HTTP contracts", () => {
  it("gets the configured default without creating a session or sending a ping", async () => {
    const calls = wire(request => {
      expect(new URL(request.url).pathname).toBe("/api/model/default");
      return Response.json({ location: { directory: "/project" }, data: { id: "model", providerID: "provider" } });
    });
    expect(await detectDefaultModel(makeClient("http://fixture", { directory: "/project" }), "/project")).toBe("provider/model");
    expect(calls).toHaveBeenCalledOnce();
  });
  it("submits durable input with the correlation ID, queue policy, and V2 file URI", async () => {
    wire(async r => {
      expect(new URL(r.url).pathname).toBe("/api/session/ses_test/prompt");
      expect(await r.json()).toEqual({ id: "msg_test", text: "hello", delivery: "queue", files: [{ uri: "data:image/png;base64,YQ==", name: "a.png" }] });
      return Response.json({ data: { id: "msg_test", sessionID: "ses_test" } });
    });
    await promptAsync(makeClient("http://fixture"), "ses_test", "hello", { messageID: "msg_test", files: [{ mime: "image/png", filename: "a.png", dataUrl: "data:image/png;base64,YQ==" }] });
  });
  it("reads pending forms using authenticated, location-scoped V2 requests", async () => {
    wire(r => {
      const url = new URL(r.url);
      expect(url.pathname).toBe("/api/form");
      expect(r.headers.get("authorization")).toBe("Basic fixture");
      expect(url.search).toContain("project");
      return Response.json({ location: { directory: "/project" }, data: [form] });
    });
    const qs = await pendingQuestions(makeClient("http://fixture", { headers: { authorization: "Basic fixture" }, directory: "/project" }));
    expect(qs[0]?.questions[0]?.options[0]).toMatchObject({ label: "React (recommended)", value: "react" });
  });
  it("replies using field keys and values, and accepts an empty 204", async () => {
    wire(async r => {
      expect(new URL(r.url).pathname).toBe("/api/session/ses_test/form/frm_test/reply");
      expect(await r.json()).toEqual({ answer: { framework: "react", features: ["ts"] } });
      return new Response(null, { status: 204 });
    });
    await questionReply(makeClient("http://fixture"), form.id, [["react"], ["ts"]], { request: normalizeForm(form) });
  });
  it("cancels a form using DELETE and no synthetic prompt", async () => {
    wire(r => { expect(r.method).toBe("DELETE"); expect(r.url).toBe("http://fixture/api/session/ses_test/form/frm_test"); return new Response(null, { status: 204 }); });
    await questionReject(makeClient("http://fixture"), form.id, { sessionId: form.sessionID });
  });
  it("maps V2 permission action/resources/source and replies with decision", async () => {
    const client = makeClient("http://fixture");
    wire(async r => {
      if (r.method === "POST") {
        expect(r.url).toBe("http://fixture/api/session/ses_test/permission/per_test/reply");
        expect(await r.json()).toEqual({ decision: "once" }); return new Response(null, { status: 204 });
      }
      return Response.json({ data: [{ id: "per_test", sessionID: "ses_test", action: "shell", resources: ["npm test"], source: { type: "tool", messageID: "msg_a", id: "call_a" } }] });
    });
    expect((await pendingPermissions(client))[0]).toMatchObject({ type: "shell", pattern: ["npm test"], messageID: "msg_a", callID: "call_a" });
    await permRespond(client, "ses_test", "per_test", "once");
  });
  it("paginates messages and correlates assistants without treating tool completion as final", async () => {
    wire(r => {
      const u = new URL(r.url);
      if (u.pathname.endsWith("/inbox")) return Response.json({ data: [{ type: "user", id: "msg_queued", time: { created: 4 } }] });
      if (!u.searchParams.has("cursor")) return Response.json({ data: [{ id: "msg_user", type: "user", time: { created: 1 }, text: "hello" }], cursor: { next: "page2" } });
      expect(u.searchParams.has("order")).toBe(false);
      return Response.json({ data: [{ id: "msg_assistant", type: "assistant", agent: "build", time: { created: 2, completed: 3 }, model: { id: "m", providerID: "p" }, content: [], finish: "tool-calls" }], cursor: {} });
    });
    const rows = await sessionMessages(makeClient("http://fixture"), "ses_test");
    expect(rows[1]?.info).toMatchObject({ parentID: "msg_user", finish: "tool-calls" });
    expect(rows[2]?.info.id).toBe("msg_queued");
  });
  it.each([null, {}, { data: [{ id: "broken" }] }])("refuses malformed pending interaction responses %j", async body => {
    wire(() => Response.json(body));
    await expect(pendingQuestions("http://fixture")).rejects.toThrow("invalid pending questions");
    await expect(pendingPermissions("http://fixture")).rejects.toThrow("invalid pending permissions");
  });
  it("propagates an unavailable service rather than reporting no pending interactions", async () => {
    wire(() => new Response(null, { status: 503 }));
    await expect(pendingPermissions("http://fixture")).rejects.toThrow("503");
  });
});

describe("idle evidence", () => {
  const client = (statuses: unknown = {}) => ({ session: { get: vi.fn(async () => ({ id: "ses_test" })), status: vi.fn(async () => statuses) } });
  it("requires an existing exact session and a successful complete active map", async () => {
    const c = client({ ses_other: { type: "busy" } });
    expect(await sessionIdle(c as never, "ses_test")).toBe(true);
    await expect(sessionIdle(c as never, "wrong")).rejects.toThrow("identity");
    c.session.status.mockRejectedValueOnce(new Error("offline"));
    await expect(sessionIdle(c as never, "ses_test")).rejects.toThrow("offline");
  });
  it.each([null, undefined, [], "", { error: "offline" }, { ses_test: null }, { ses_test: { type: "unknown" } }, { ses_test: { type: "retry" } }])("rejects malformed statuses %j", async s => {
    await expect(sessionStatus({ session: { status: async () => s } } as never)).rejects.toThrow("invalid session status");
  });
});

describe("native V2 event translation", () => {
  it("does not offer custom input for fixed options and preserves conditional defaults", () => {
    expect(normalizeForm(form).questions[0]?.custom).toBe(false);
    const req = normalizeForm({ ...form, fields: [
      { key: "enabled", type: "boolean", default: false },
      { key: "amount", type: "integer", when: [{ key: "enabled", op: "eq", value: true }] },
      { key: "notes", type: "string" },
    ] });
    expect(visibleQuestions(req, [[], [], []])).toEqual([true, false, true]);
    expect(formAnswer(req, [["false"], ["42"], ["hello"]])).toEqual({ enabled: false, notes: "hello" });
    expect(() => formAnswer(req, [["true"], ["1.5"], []])).toThrow("number");
  });
  it("emits only one idle for the V2 completion signals", () => {
    const events = new V2Events();
    const e = (type: string, data: object) => events.translate({ type, data } as V2Event);
    e("session.execution.started", { sessionID: "s" });
    expect(e("session.execution.succeeded", { sessionID: "s" })).toHaveLength(1);
    expect(e("session.status", { sessionID: "s", status: { type: "idle" } })).toEqual([]);
    expect(e("session.idle", { sessionID: "s" })).toEqual([]);
    e("session.execution.started", { sessionID: "s" });
    expect(e("session.execution.succeeded", { sessionID: "s" })).toHaveLength(1);
  });
  it("routes forms and complete text with stable transcript part identities", () => {
    const events = new V2Events();
    expect(events.translate({ type: "form.created", data: { form } } as V2Event)[0]).toMatchObject({ type: "question.asked", properties: { id: form.id } });
    expect(events.translate({ type: "session.text.ended", created: 100, data: { sessionID: "ses_test", assistantMessageID: "msg_a", ordinal: 1, text: "hello" } } as V2Event)[0])
      .toMatchObject({ type: "message.part.updated", properties: { part: { id: "msg_a:1", text: "hello", time: { end: 100 } } } });
  });
});
