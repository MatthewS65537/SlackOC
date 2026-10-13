import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HELP_SECTIONS } from "../src/commands/handlers.js";
import { execute, getCommand, type CmdCtx } from "../src/commands/registry.js";
import { parseShotArgs, resolveShotTarget, runShot } from "../src/commands/shot.js";
import type { ExecFn } from "../src/headless.js";

const root = resolve("test/.fixtures/shot");
const project = join(root, "project");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(project, "sub"), { recursive: true });
writeFileSync(join(project, "page.html"), "<h1>hi</h1>");
writeFileSync(join(root, "outside.html"), "<h1>secret</h1>");
symlinkSync(join(root, "outside.html"), join(project, "link.html"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Thread bound to `project`; touching the OpenCode pool (any session work) throws. */
function ctx(thread: CmdCtx["thread"] = { projectDir: project } as CmdCtx["thread"]) {
  const uploads: Array<{ filename: string; content: string | Buffer; comment?: string }> = [];
  const posts: string[] = [];
  const c = {
    channelId: "C1", threadTs: "1.000001", threadKey: "C1:1.000001", thread, cwd: "/launch/dir",
    state: { defaultDir: () => project },
    pool: new Proxy({}, { get: (_t, key) => { throw new Error(`pool.${String(key)} touched`); } }),
    postToThread: async (text: string) => { posts.push(text); },
    uploadToThread: async (filename: string, content: string | Buffer, comment?: string) => { uploads.push({ filename, content, comment }); },
  } as unknown as CmdCtx;
  return { c, uploads, posts };
}

function chrome(found = true) {
  const exec = vi.fn<ExecFn>(async (_file, args) => {
    writeFileSync(args.find(a => /^--(screenshot|print-to-pdf)=/.test(a))!.split("=").slice(1).join("="), "img");
    return { stderr: "" };
  });
  return { exec, findChrome: async () => found ? "/fake/chrome" : undefined };
}

describe("\\shot arguments", () => {
  it.each([
    ["http://localhost:3000", { target: "http://localhost:3000", mode: "phone" }],
    ["http://localhost:3000 desktop", { target: "http://localhost:3000", mode: "desktop" }],
    ["docs/My Report.html  PDF", { target: "docs/My Report.html", mode: "pdf" }],
    ["phone", { target: "phone", mode: "phone" }],
  ])("%j", (args, expected) => expect(parseShotArgs(args)).toEqual(expected));
});

describe("\\shot targets", () => {
  it("accepts http(s) URLs, bare localhost, and Slack autolinks the owner typed as URLs", async () => {
    expect(await resolveShotTarget("https://example.com/a?b=1", project)).toEqual({ kind: "url", url: "https://example.com/a?b=1" });
    expect(await resolveShotTarget("localhost:3000/login", project)).toEqual({ kind: "url", url: "http://localhost:3000/login" });
    expect(await resolveShotTarget("[https://example.com](https://example.com)", project)).toEqual({ kind: "url", url: "https://example.com/" });
    // Slack autolinked a bare word: what the owner typed is a project path, not a web host.
    await expect(resolveShotTarget("[page.md](http://page.md)", project)).rejects.toThrow("no such file in the project: page.md");
  });
  it.each(["file:///etc/hosts", "ftp://example.com/x", "javascript://x"])("refuses non-http scheme %s", async target => {
    await expect(resolveShotTarget(target, project)).rejects.toThrow(/only http\(s\) URLs/);
  });
  it("resolves relative paths against the project, not the launch dir", async () => {
    expect(await resolveShotTarget("page.html", project)).toEqual({ kind: "file", path: realpathSync(join(project, "page.html")), label: "page.html" });
    expect(await resolveShotTarget(join(project, "sub", "..", "page.html"), project)).toMatchObject({ label: "page.html" });
  });
  it.each(["../outside.html", join(root, "outside.html"), "/etc/hosts", "link.html"])("refuses %s outside the project (symlinks included)", async target => {
    await expect(resolveShotTarget(target, project)).rejects.toThrow("refusing a path outside this thread's project");
  });
  it("explains missing files and directories", async () => {
    await expect(resolveShotTarget("missing.html", project)).rejects.toThrow("no such file in the project: missing.html");
    await expect(resolveShotTarget("sub", project)).rejects.toThrow("not a file: sub");
  });
});

describe("\\shot capture", () => {
  it("screenshots at the phone viewport by default and uploads a PNG without touching the session", async () => {
    const { c, uploads } = ctx();
    const fake = chrome();
    await runShot(c, "http://localhost:3000/login", fake);
    const args = fake.exec.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining(["--window-size=412,892", "--hide-scrollbars"]));
    expect(args.at(-1)).toBe("http://localhost:3000/login");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.filename).toBe("localhost-3000-login.png");
    expect(Buffer.isBuffer(uploads[0]!.content)).toBe(true);
    expect(uploads[0]!.comment).toMatch(/^📸 `http:\/\/localhost:3000\/login` · phone 412×892 · \d+\.\ds$/);
  });
  it("uses desktop size, and prints a project file to PDF in an unbound thread's default project", async () => {
    const desktop = chrome();
    await runShot(ctx().c, "https://example.com desktop", desktop);
    expect(desktop.exec.mock.calls[0]![1]).toContain("--window-size=1440,900");
    const { c, uploads } = ctx(null);
    const pdf = chrome();
    await runShot(c, "page.html pdf", pdf);
    const args = pdf.exec.mock.calls[0]![1];
    expect(args.some(a => a.startsWith("--print-to-pdf="))).toBe(true);
    expect(args.at(-1)).toBe(pathToFileURL(realpathSync(join(project, "page.html"))).href);
    expect(uploads[0]).toMatchObject({ filename: "page.pdf", comment: expect.stringMatching(/^📸 `page\.html` · PDF · /) });
  });
  it("answers a missing Chrome with the SLACKOC_CHROME hint and uploads nothing", async () => {
    const { c, uploads } = ctx();
    await expect(runShot(c, "http://localhost:3000", chrome(false))).rejects.toThrow(/SLACKOC_CHROME/);
    expect(uploads).toEqual([]);
  });
  it("is registered with aliases under Look, and a bare alias reports usage", async () => {
    expect(["shot", "screenshot", "snap"].map(n => getCommand(n)?.name)).toEqual(["shot", "shot", "shot"]);
    expect(HELP_SECTIONS.find(s => s.title === "Look")?.names).toContain("shot");
    const { c, posts, uploads } = ctx();
    await execute({ name: "snap", args: "" }, c);
    expect(posts).toEqual([expect.stringContaining("usage: `\\shot <url|path> [phone|desktop|pdf]`")]);
    expect(uploads).toEqual([]);
  });
});
