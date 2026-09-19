import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  service: vi.fn().mockResolvedValue(undefined), start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined), daemon: vi.fn().mockResolvedValue(0),
}));
vi.mock("../src/service.js", () => ({ runServiceCommand: mocks.service }));
vi.mock("../src/start.js", () => ({ startBridge: mocks.start, stopBridge: mocks.stop }));
vi.mock("../src/init.js", () => ({ runInit: vi.fn() }));
vi.mock("../src/doctor.js", () => ({ runDoctor: vi.fn() }));
vi.mock("../src/daemon.js", () => ({ daemonInstall: mocks.daemon, daemonStatus: mocks.daemon, daemonUninstall: mocks.daemon, installedWorkdir: vi.fn() }));

const argv = process.argv;
const code = process.exitCode;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { process.argv = argv; process.exitCode = code; vi.restoreAllMocks(); });

describe("CLI service dispatch", () => {
  it.each(["install", "start", "stop", "status", "uninstall"])("routes service %s without invoking a foreground bridge", async command => {
    const args = command === "install" ? [command, "--dir", "/path with spaces", "--keep-awake", "false"] : [command];
    process.argv = [process.execPath, "/fixture/cli.js", "service", ...args];
    await import("../src/cli.js");
    expect(mocks.service).toHaveBeenCalledExactlyOnceWith(args);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.daemon).not.toHaveBeenCalled();
  });
  it("surfaces service validation failures through the CLI exit code", async () => {
    mocks.service.mockRejectedValueOnce(new Error("--keep-awake must be explicitly true or false"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [process.execPath, "/fixture/cli.js", "service", "install", "--keep-awake", "yes"];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith("error:", "--keep-awake must be explicitly true or false");
  });
  it.skipIf(process.platform !== "darwin")("routes the legacy macOS daemon alias through the safe service commands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [process.execPath, "/fixture/cli.js", "daemon", "install"];
    await import("../src/cli.js");
    expect(mocks.service).toHaveBeenCalledWith(["install"]);
    expect(mocks.daemon).not.toHaveBeenCalled();
  });
});
