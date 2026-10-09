import { describe, expect, it } from "vitest";
import { homeView, notOwnerView } from "../src/slack/home.js";

const text = (v: { blocks: unknown[] }) => JSON.stringify(v.blocks);

describe("Home tab (C2)", () => {
  it("lists runs, waiting items, reports and usage with thread links", () => {
    const v = homeView({
      runs: [{ project: "slackoc", url: "https://x.slack.com/archives/C1/p1", elapsedMs: 65_000, queued: 1 }],
      waiting: [{ kind: "permission", title: "bash: rm -rf dist", project: "slackoc", url: null }],
      reports: [{ name: "Morning brief", enabled: true, nextRunAt: 1_800_000_000_000 }, { name: "Old", enabled: false, nextRunAt: 0 }],
      usage: "*$1.82*\n1.2M tokens · 4 sessions · 1 active day",
    });
    expect(v.type).toBe("home");
    const t = text(v);
    expect(t).toContain("▶ <https://x.slack.com/archives/C1/p1|slackoc> · 1m 5s · 1 queued");
    expect(t).toContain("🔐 slackoc · bash: rm -rf dist");
    expect(t).toContain("<!date^1800000000^");
    expect(t).toContain("⏸ *Old* · paused");
    expect(t).toContain("$1.82");
  });

  it("shows empty states instead of blank sections", () => {
    const t = text(homeView({ runs: [], waiting: [], reports: [], usage: null }));
    expect(t).toContain("Nothing running.");
    expect(t).toContain("Nothing is waiting on you.");
    expect(t).toContain("Usage is unavailable");
  });

  it("gives non-owners a one-line stub", () => {
    expect(text(notOwnerView())).toContain("belongs to someone else");
  });
});
