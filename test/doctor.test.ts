import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor, scopeCheck } from "../src/doctor.js";

const f = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for("nodejs.util.promisify.custom")]: f.exec,
}) }));
vi.mock("../src/config.js", () => ({ loadConfig: () => null }));
afterEach(() => vi.restoreAllMocks());

describe("doctor V2 CLI version check", () => {
  it.each([
    ["opencode v2.0.21\n", true],
    ["2.0.12\n", true],
    ["opencode v2.0.11\n", false],
    ["opencode v2.0.21-beta.1\n", false],
    ["opencode v3.0.0\n", false],
  ])("checks %s against the shared-service version policy", async (stdout, supported) => {
    f.exec.mockResolvedValue({ stdout });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDoctor();
    expect(output.mock.calls.map(([line]) => String(line)))
      .toContainEqual(expect.stringContaining(`${supported ? "✓" : "✗"} opencode V2 ≥ 2.0.12`));
  });
});

describe("doctor live scope probes (RQ6)", () => {
  it("missing_scope → failing check that says reinstall", () => {
    const c = scopeCheck("scope files:read (attachments)", { ok: false, error: "missing_scope" });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("reinstall");
  });

  it("known bogus-resource validation errors → granted", () => {
    expect(scopeCheck("s", { ok: false, error: "file_not_found" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: false, error: "channel_not_found" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: false, error: "message_not_found" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: false, error: "no_reaction" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: true }).ok).toBe(true); // bizarre success still proves the scope
  });

  it.each(["invalid_auth", "token_revoked", "account_inactive", "ratelimited", "internal_error", "unknown_error"])("%s cannot prove a scope is granted", (error) => {
    const check = scopeCheck("s", { ok: false, error });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(error);
    expect(check.detail).not.toContain("reinstall");
  });

  it("a failed response without an error is inconclusive, not granted", () => {
    expect(scopeCheck("s", { ok: false }).ok).toBe(false);
  });
});
