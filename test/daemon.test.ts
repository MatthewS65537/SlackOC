import { describe, expect, it } from "vitest";
import { detectPlatform, renderLaunchdPlist, renderSystemdUnit } from "../src/daemon.js";

const opts = {
  node: "/opt/homebrew/bin/node",
  cli: "/opt/slackoc/bin/slackoc.js",
  workdir: "/Users/me/projects/demo",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
};

describe("daemon unit rendering (D3)", () => {
  it("detectPlatform maps node platforms to the two supported targets", () => {
    expect(["darwin", "linux", "unsupported"]).toContain(detectPlatform());
  });

  it("launchd plist runs `node <cli> start` from the workdir with KeepAlive", () => {
    const xml = renderLaunchdPlist(opts);
    expect(xml).toContain(`<string>${opts.node}</string>`);
    expect(xml).toContain(`<string>${opts.cli}</string>`);
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain(`<string>${opts.workdir}</string>`);
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain(`<string>${opts.path}</string>`);
    // stdout/stderr captured for pre-logging boot failures
    expect(xml).toContain("daemon-stderr.log");
  });

  it("systemd unit is a user service that restarts on failure", () => {
    const unit = renderSystemdUnit(opts);
    expect(unit).toContain(`ExecStart=${opts.node} ${opts.cli} start`);
    expect(unit).toContain(`WorkingDirectory=${opts.workdir}`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("daemon-stderr.log");
  });
});
