import { describe, expect, it } from "vitest";
import { isActivityEvent, shouldNotifyDeath, shouldReap } from "../src/opencode/server.js";

describe("server death notification gate", () => {
  it("notifies only for a ready server that was not stopped on purpose", () => {
    expect(shouldNotifyDeath(true, false)).toBe(true); // crash mid-run → page
    expect(shouldNotifyDeath(true, true)).toBe(false); // killOne/\restart/reaper/shutdown
    expect(shouldNotifyDeath(false, false)).toBe(false); // died while still starting — no views exist
    expect(shouldNotifyDeath(false, true)).toBe(false);
  });
});

describe("idle server reaper gate", () => {  const min = 60_000;
  it("reaps a ready server idle past the TTL with no active work", () => {
    const e = { status: "ready", lastEventAt: 0 };
    expect(shouldReap(e, 31 * min, 30 * min, false)).toBe(true);
  });

  it("spares young, busy, and non-ready servers", () => {
    expect(shouldReap({ status: "ready", lastEventAt: 29 * min }, 30 * min, 30 * min, false)).toBe(false); // recent events
    expect(shouldReap({ status: "ready", lastEventAt: 0 }, 31 * min, 30 * min, true)).toBe(false); // active view on it
    expect(shouldReap({ status: "starting", lastEventAt: 0 }, 31 * min, 30 * min, false)).toBe(false); // not ready yet
    expect(shouldReap({ status: "dead", lastEventAt: 0 }, 31 * min, 30 * min, false)).toBe(false);
  });
});

describe("reaper activity filter (RB1)", () => {
  it("heartbeats/connected do not count as activity; real events do", () => {
    expect(isActivityEvent("server.heartbeat")).toBe(false);
    expect(isActivityEvent("server.connected")).toBe(false);
    expect(isActivityEvent("session.idle")).toBe(true);
    expect(isActivityEvent("message.part.updated")).toBe(true);
  });
});
