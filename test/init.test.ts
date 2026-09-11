import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAppTokenShape,
  assertBotTokenShape,
  assertOwnerIdShape,
  testAppToken,
  testBotToken,
  verifyOwnerId,
} from "../src/init.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
