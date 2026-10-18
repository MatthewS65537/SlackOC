import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  HeadlessError, MAC_CHROME_PATHS, htmlToPdf, locateChrome, pdfArgs, screenshot, screenshotArgs, targetUrl, withTempDir, type ExecFn,
} from "../src/headless.js";

const root = resolve("test/.fixtures/headless");
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Fake Chrome: records argv, writes `bytes` to the --print-to-pdf/--screenshot target. */
function fakeExec(bytes: string | null = "%PDF-fake", stderr = "") {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const exec = vi.fn<ExecFn>(async (file, args, { timeoutMs }) => {
    calls.push({ file, args, timeoutMs });
    const out = args.find(a => /^--(print-to-pdf|screenshot)=/.test(a))!.replace(/^--[^=]+=/, "");
    if (bytes !== null) writeFileSync(out, bytes);
    return { stderr };
  });
  return { exec, calls, findChrome: async () => "/fake/chrome" };
}
const flag = (args: string[], name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

describe("Chrome discovery", () => {
  const PATH = ["/usr/local/bin", "/usr/bin"].join(process.platform === "win32" ? ";" : ":");
  it("prefers SLACKOC_CHROME, then macOS app bundles in order, then PATH names", async () => {
    const all = new Set(["/custom/chrome", ...MAC_CHROME_PATHS, "/usr/bin/google-chrome", "/usr/local/bin/chromium"]);
    const has = (set: Set<string>) => async (p: string) => set.has(p);
    expect(await locateChrome({ SLACKOC_CHROME: "/custom/chrome", PATH }, has(all))).toBe("/custom/chrome");
    expect(await locateChrome({ PATH }, has(all))).toBe(MAC_CHROME_PATHS[0]);
    expect(await locateChrome({ PATH }, has(new Set([MAC_CHROME_PATHS[3]!, MAC_CHROME_PATHS[1]!])))).toBe(MAC_CHROME_PATHS[1]);
    // Name order wins over PATH order (google-chrome before chromium), like `which google-chrome || which chromium`.
    expect(await locateChrome({ PATH }, has(new Set(["/usr/local/bin/chromium", "/usr/bin/google-chrome"])))).toBe("/usr/bin/google-chrome");
    expect(await locateChrome({ PATH }, has(new Set(["/usr/bin/chromium-browser"])))).toBe("/usr/bin/chromium-browser");
  });
  it("falls through a SLACKOC_CHROME that is not runnable, and reports nothing found", async () => {
    expect(await locateChrome({ SLACKOC_CHROME: "/gone", PATH }, async p => p === MAC_CHROME_PATHS[2])).toBe(MAC_CHROME_PATHS[2]);
    expect(await locateChrome({ PATH: "" }, async () => false)).toBeUndefined();
  });
});

describe("Chrome arguments", () => {
  it("prints without header/footer, with load timeout and virtual time, URL last", () => {
    const args = pdfArgs("file:///p/r.html", "/o/r.pdf", "/prof");
    expect(args.slice(0, 4)).toEqual(["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check"]);
    expect(args).toEqual(expect.arrayContaining(["--user-data-dir=/prof", "--no-pdf-header-footer", "--print-to-pdf=/o/r.pdf", "--timeout=15000", "--virtual-time-budget=5000"]));
    expect(args.at(-1)).toBe("file:///p/r.html");
  });
  it("screenshots at the requested viewport with hidden scrollbars", () => {
    const args = screenshotArgs("http://localhost:3000/", "/o/s.png", "/prof", { width: 412, height: 892 });
    expect(args).toEqual(expect.arrayContaining(["--hide-scrollbars", "--window-size=412,892", "--screenshot=/o/s.png", "--timeout=10000"]));
    expect(args).not.toContain("--no-pdf-header-footer");
    expect(args.at(-1)).toBe("http://localhost:3000/");
  });
  it("turns paths (with spaces and leading dashes) into file:// URLs that can't be read as flags", () => {
    expect(targetUrl("/a b/--x.html")).toBe("file:///a%20b/--x.html");
    expect(targetUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(targetUrl("--headless")).toMatch(/^file:\/\//);
  });
});

describe("running Chrome", () => {
  const html = join(root, "page.html");
  writeFileSync(html, "<h1>hi</h1>");

  it("runs the found binary with a fresh profile under the OS temp dir and removes it afterwards", async () => {
    const fake = fakeExec();
    await withTempDir(async dir => {
      await htmlToPdf(html, join(dir, "out.pdf"), fake);
      expect(readFileSync(join(dir, "out.pdf"), "utf8")).toBe("%PDF-fake");
    });
    const { file, args, timeoutMs } = fake.calls[0]!;
    const profile = flag(args, "user-data-dir")!;
    expect(file).toBe("/fake/chrome");
    expect(profile.startsWith(tmpdir())).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(timeoutMs).toBeGreaterThan(15_000);
  });
  it("names the SLACKOC_CHROME fix when no browser is found, without running anything", async () => {
    const fake = fakeExec();
    const err = await screenshot(html, join(root, "x.png"), { width: 1, height: 1 }, { ...fake, findChrome: async () => undefined }).catch(e => e);
    expect(err).toBeInstanceOf(HeadlessError);
    expect(err).toMatchObject({ reason: "missing", message: expect.stringContaining("SLACKOC_CHROME") });
    expect(fake.exec).not.toHaveBeenCalled();
  });
  it("maps a killed run to a timeout and still removes the profile", async () => {
    let profile = "";
    const exec: ExecFn = async (_f, args) => {
      profile = flag(args, "user-data-dir")!;
      throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
    };
    await expect(htmlToPdf(html, join(root, "t.pdf"), { exec, findChrome: async () => "/fake/chrome" })).rejects.toMatchObject({ reason: "timeout", message: expect.stringMatching(/timed out/) });
    expect(existsSync(profile)).toBe(false);
  });
  it("explains a page that failed to load (Chrome exits 0 but writes nothing)", async () => {
    const fake = fakeExec(null, "[1:2:ERROR:headless_command_handler.cc:403] Page load failed: net::ERR_CONNECTION_REFUSED\n");
    await expect(screenshot("http://localhost:1/", join(root, "none.png"), { width: 412, height: 892 }, fake))
      .rejects.toThrow("Chrome couldn't load the page (net::ERR_CONNECTION_REFUSED)");
  });
});

// Real headless Chrome on local files; skipped in CI and wherever no browser is installed.
const chrome = process.env.CI ? undefined : await locateChrome();
describe.skipIf(!chrome)("real headless Chrome", () => {
  const html = join(root, "real.html");
  writeFileSync(html, "<!doctype html><title>t</title><h1 style='background:#2a78d6;color:#fff'>Report</h1>");

  it("prints an HTML file to a PDF", async () => {
    const out = join(root, "real.pdf");
    await htmlToPdf(html, out);
    expect(readFileSync(out).subarray(0, 5).toString()).toBe("%PDF-");
  }, 30_000);
  it("screenshots a local HTML file at the phone viewport", async () => {
    const out = join(root, "real.png");
    await screenshot(html, out, { width: 412, height: 892 });
    const png = readFileSync(out);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([412, 892]); // IHDR width/height
  }, 30_000);
});
