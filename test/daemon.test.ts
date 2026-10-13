import { describe, expect, it, vi } from "vitest";
import { detectPlatform, renderLaunchdPlist, renderSystemdUnit } from "../src/daemon.js";

// A config dir with XML and systemd metacharacters, so the log paths exercise escaping too.
vi.mock("../src/config.js", () => ({ CONFIG_DIR: "/home/u/R&D 100%/slackoc", CONFIG_PATH: "/home/u/R&D 100%/slackoc/config.json" }));

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
    expect(unit).toContain(`ExecStart="${opts.node}" "${opts.cli}" start`);
    expect(unit).toContain(`WorkingDirectory=${opts.workdir}`);
    expect(unit).toContain(`Environment="PATH=${opts.path}"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("daemon-stderr.log");
  });

  it("systemd unit keeps paths with spaces whole inside double quotes (#45)", () => {
    const unit = renderSystemdUnit({ ...opts, node: "/home/u/My Tools/node", path: "/usr/bin:/mnt/c/Program Files/Git/cmd" });
    expect(unit).toContain(`ExecStart="/home/u/My Tools/node" "${opts.cli}" start`);
    expect(unit).toContain(`Environment="PATH=/usr/bin:/mnt/c/Program Files/Git/cmd"`);
  });

  it("systemd path settings escape specifiers but stay unquoted (#45)", () => {
    const unit = renderSystemdUnit({ ...opts, workdir: "/srv/100%/my app" });
    expect(unit).toContain("WorkingDirectory=/srv/100%%/my app\n");
    expect(unit).toContain("StandardOutput=append:/home/u/R&D 100%%/slackoc/daemon-stdout.log\n");
    expect(unit).toContain("StandardError=append:/home/u/R&D 100%%/slackoc/daemon-stderr.log\n");
  });

  it("systemd unit rejects control characters that would inject a directive", () => {
    expect(() => renderSystemdUnit({ ...opts, workdir: "/srv/x\nExecStartPre=/bin/evil" })).toThrow(/control character/);
  });

  it("launchd plist XML-escapes every interpolated value", () => {
    const xml = renderLaunchdPlist({ ...opts, workdir: "/Users/me/R&D <draft>", path: "/a&b:/usr/bin" });
    expect(xml).toContain("<key>WorkingDirectory</key><string>/Users/me/R&amp;D &lt;draft&gt;</string>");
    expect(xml).toContain("<key>PATH</key><string>/a&amp;b:/usr/bin</string>");
    expect(xml).toContain("<string>/home/u/R&amp;D 100%/slackoc/daemon-stderr.log</string>");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;)/); // no bare ampersand left anywhere
  });
});
