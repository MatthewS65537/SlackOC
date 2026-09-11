import { describe, expect, it } from "vitest";
import { GhostDetector } from "../src/ghosts.js";

describe("GhostDetector", () => {
  const T0 = 1_000_000_000_000;

  it("stays quiet on healthy traffic (live far outweighs replays)", () => {
    const g = new GhostDetector();
    for (let i = 0; i < 5; i += 1) g.noteLive(T0 + i * 1000);
    g.noteReplayed(1, T0 + 2000); // a benign race
    expect(g.check(T0 + 3000)).toBeNull();
  });

  it("stays quiet below the replay threshold", () => {
    const g = new GhostDetector();
    g.noteReplayed(2, T0);
    expect(g.check(T0 + 1000)).toBeNull();
  });

  it("does not warn when live outnumbers replays", () => {
    const g = new GhostDetector();
    for (let i = 0; i < 4; i += 1) g.noteLive(T0 + i);
    g.noteReplayed(3, T0 + 1000);
    expect(g.check(T0 + 2000)).toBeNull();
  });

  it("warns on a pure zombie (everything via sweep, nothing live)", () => {
    const g = new GhostDetector();
    g.noteReplayed(3, T0);
    const warn = g.check(T0 + 1000);
    expect(warn).toContain("second bridge instance");
    expect(warn).toContain("3 message(s)");
  });

  it("warns on a partial split (replays ≥ live)", () => {
    const g = new GhostDetector();
    g.noteLive(T0);
    g.noteReplayed(4, T0 + 1000);
    expect(g.check(T0 + 2000)).toContain("vs 1 via socket");
  });

  it("throttles to one warning per cooldown", () => {
    const g = new GhostDetector();
    g.noteReplayed(3, T0);
    expect(g.check(T0 + 1000)).toContain("second bridge");
    g.noteReplayed(3, T0 + 2000);
    expect(g.check(T0 + 3000)).toBeNull(); // still cooling down
    g.noteReplayed(3, T0 + 60 * 60_000); // fresh thefts after the cooldown
    expect(g.check(T0 + 60 * 60_000 + 1000)).toContain("second bridge");
  });

  it("forgets deliveries older than the window", () => {
    const g = new GhostDetector();
    g.noteReplayed(5, T0);
    expect(g.check(T0 + 16 * 60_000)).toBeNull(); // all aged out
  });
});
