import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), start: vi.fn() }));
vi.mock("../src/send-file.js", () => ({ runSendFileCommand: mocks.send }));
vi.mock("../src/start.js", () => ({ startBridge: mocks.start }));
const argv = process.argv;
const code = process.exitCode;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.send.mockResolvedValue(undefined); });
afterEach(() => { process.argv = argv; process.exitCode = code; vi.restoreAllMocks(); });

describe("send-file CLI dispatch", () => {
  it("forwards arguments to the lazy upload command without starting the bridge", async () => {
    const args = ["--file", "/path with spaces/report.pdf", "--session", "ses_current"];
    process.argv = [process.execPath, "/fixture/cli.js", "send-file", ...args];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledExactlyOnceWith(args));
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("reports command failure with a nonzero exit code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.send.mockRejectedValueOnce(new Error("--session is required"));
    process.argv = [process.execPath, "/fixture/cli.js", "send-file", "--file", "/report.pdf"];
    await import("../src/cli.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(error).toHaveBeenCalledWith("error:", "--session is required");
  });
});
