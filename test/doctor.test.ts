import { describe, expect, it } from "vitest";
import { scopeCheck } from "../src/doctor.js";

describe("doctor live scope probes (RQ6)", () => {
  it("missing_scope → failing check that says reinstall", () => {
    const c = scopeCheck("scope files:read (attachments)", { ok: false, error: "missing_scope" });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("reinstall");
  });

  it("any other error (bogus args reached validation) → granted", () => {
    expect(scopeCheck("s", { ok: false, error: "file_not_found" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: false, error: "message_not_found" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: false, error: "no_reaction" }).ok).toBe(true);
    expect(scopeCheck("s", { ok: true }).ok).toBe(true); // bizarre success still proves the scope
  });
});
