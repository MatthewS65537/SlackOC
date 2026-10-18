import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAppTokenShape,
  assertBotTokenShape,
  assertOwnerIdShape,
  slackApiWithScopes,
  testAppToken,
  testBotToken,
  verifyOwnerId,
} from "../src/init.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => body })),
  );
}

describe("token/owner shape guards", () => {
  it("bot token must start with xoxb-", () => {
    expect(() => assertBotTokenShape("xoxb-good")).not.toThrow();
    expect(() => assertBotTokenShape("xapp-wrong")).toThrow(/xoxb-/);
  });
  it("app token must start with xapp-", () => {
    expect(() => assertAppTokenShape("xapp-good")).not.toThrow();
    expect(() => assertAppTokenShape("xoxb-wrong")).toThrow(/xapp-/);
  });
  it("owner id must look like U…", () => {
    expect(() => assertOwnerIdShape("U01234ABCD")).not.toThrow();
    expect(() => assertOwnerIdShape("W123")).toThrow();
  });
});

describe("live token validators (stubbed fetch)", () => {
  it("every Slack call carries a 10 s timeout signal", async () => {
    const signal = AbortSignal.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetch);
    await testAppToken("xapp-t");
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("apps.connections.open"), expect.objectContaining({ signal }));
  });

  it("slackApiWithScopes parses x-oauth-scopes, and reports null when the header is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', { headers: { "x-oauth-scopes": "chat:write, files:write" } })));
    await expect(slackApiWithScopes("auth.test", "xoxb-t")).resolves.toEqual({ body: { ok: true }, scopes: ["chat:write", "files:write"] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}')));
    await expect(slackApiWithScopes("auth.test", "xoxb-t")).resolves.toEqual({ body: { ok: true }, scopes: null });
  });
  it("testBotToken happy path", async () => {
    stubFetchJson({ ok: true, team: "My Team", user: "slackoc" });
    await expect(testBotToken("xoxb-t")).resolves.toEqual({ ok: true, team: "My Team", user: "slackoc" });
  });
  it("testBotToken rejects bad tokens", async () => {
    stubFetchJson({ ok: false, error: "invalid_auth" });
    await expect(testBotToken("xoxb-t")).rejects.toThrow(/invalid_auth/);
  });
  it("testAppToken happy path (apps.connections.open)", async () => {
    stubFetchJson({ ok: true, url: "wss://…" });
    await expect(testAppToken("xapp-t")).resolves.toBeUndefined();
  });
  it("testAppToken rejects bad tokens", async () => {
    stubFetchJson({ ok: false, error: "invalid_auth" });
    await expect(testAppToken("xapp-t")).rejects.toThrow(/invalid_auth/);
  });

  it("verifyOwnerId returns the real name", async () => {
    stubFetchJson({ ok: true, user: { name: "mattsu", real_name: "Matthew Su" } });
    await expect(verifyOwnerId("xoxb-t", "U01234ABCD")).resolves.toEqual({ name: "Matthew Su" });
  });
  it("verifyOwnerId throws on unknown user (typo guard)", async () => {
    stubFetchJson({ ok: false, error: "user_not_found" });
    await expect(verifyOwnerId("xoxb-t", "U01234ABCD")).rejects.toThrow(/no member/);
  });
  it("verifyOwnerId soft-skips when scope is missing", async () => {
    stubFetchJson({ ok: false, error: "missing_scope" });
    await expect(verifyOwnerId("xoxb-t", "U01234ABCD")).resolves.toBeNull();
  });
});

describe("runInit", () => {
  it("keeps optional settings (ship) from an existing config and replaces tokens", async () => {
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const root = resolve("test/.fixtures/init");
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(join(root, "home-"));
    mkdirSync(join(home, "slackoc"));
    const path = join(home, "slackoc", "config.json");
    writeFileSync(path, JSON.stringify({ slackBotToken: "xoxb-old", slackAppToken: "xapp-old", ownerSlackUserId: "UOLD00000", createdAt: "x", ship: { allowMainPush: true } }));
    vi.stubEnv("SLACKOC_HOME", home);
    vi.resetModules(); // CONFIG_DIR is read at import time
    vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetchJson({ ok: true, user: "bot" });
    try {
      const { runInit } = await import("../src/init.js");
      await runInit({ botToken: "xoxb-new", appToken: "xapp-new", ownerId: "UNEW00000" });
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved).toMatchObject({ slackBotToken: "xoxb-new", slackAppToken: "xapp-new", ownerSlackUserId: "UNEW00000", ship: { allowMainPush: true } });
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
