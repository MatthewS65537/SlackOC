import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MSG_FILE, parseStatusZ, planShip, runShip, shipResultText, type ExecFileFn, type ShipInput } from "../src/ship.js";
import { registerDiffActions, SHIP_SUBMIT } from "../src/slack/diff-view.js";
import { SHIP_OPEN_ACTION } from "../src/slack/blocks.js";
import { shipCommand } from "../src/commands/ship.js";
import { getView } from "../src/slack/render.js";
import { sessionDiff, sessionGet, vcsBranch } from "../src/opencode/client.js";
import { _resetQueueForTests } from "../src/slack/queue.js";

vi.mock("../src/opencode/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/opencode/client.js")>(), sessionDiff: vi.fn(), sessionGet: vi.fn(), vcsBranch: vi.fn() }));
vi.mock("../src/slack/render.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/slack/render.js")>(), getView: vi.fn() }));

const base: ShipInput = { current: "feature", branch: "current", newBranch: "", files: [{ path: "a.ts" }], message: "Fix it\n\nBody line",
  push: false, pr: false, allowMainPush: false };
const plan = (over: Partial<ShipInput>) => planShip({ ...base, ...over });

describe("planShip", () => {
  it.each<[string, Partial<ShipInput>, string[][]]>([
    ["commits on the current branch", {}, [["git", "add", "--", "a.ts"], ["git", "commit", "-F", MSG_FILE, "--", "a.ts"]]],
    ["creates a new branch first", { branch: "new", newBranch: "agent/fix" },
      [["git", "switch", "-c", "agent/fix"], ["git", "add", "--", "a.ts"], ["git", "commit", "-F", MSG_FILE, "--", "a.ts"]]],
    ["pushes the target branch when ticked", { branch: "new", newBranch: "agent/fix", push: true },
      [["git", "switch", "-c", "agent/fix"], ["git", "add", "--", "a.ts"], ["git", "commit", "-F", MSG_FILE, "--", "a.ts"],
        ["git", "push", "-u", "origin", "refs/heads/agent/fix:refs/heads/agent/fix"]]],
    ["opens a draft PR titled by the first line", { push: true, pr: true },
      [["git", "add", "--", "a.ts"], ["git", "commit", "-F", MSG_FILE, "--", "a.ts"], ["git", "push", "-u", "origin", "refs/heads/feature:refs/heads/feature"],
        ["gh", "pr", "create", "--draft", "--title=Fix it", "--body=Body line", "--head=feature"]]],
    ["keeps odd names whole, after --", { files: [{ path: "my file.ts" }, { path: "-rf" }, { path: "ünï/cødé.ts" }] },
      [["git", "add", "--", "my file.ts", "-rf", "ünï/cødé.ts"], ["git", "commit", "-F", MSG_FILE, "--", "my file.ts", "-rf", "ünï/cødé.ts"]]],
    ["commits a staged deletion and a rename's source without adding them", { files: [{ path: "gone.ts", removed: true }, { path: "new.ts", orig: "old.ts" }] },
      [["git", "add", "--", "new.ts"], ["git", "commit", "-F", MSG_FILE, "--", "gone.ts", "new.ts", "old.ts"]]],
    ["commits locally on main (only pushing is guarded)", { current: "main" }, [["git", "add", "--", "a.ts"], ["git", "commit", "-F", MSG_FILE, "--", "a.ts"]]],
  ])("%s", (_name, over, steps) => {
    const result = plan(over);
    expect(result).toEqual({ steps, branch: over.branch === "new" ? over.newBranch : over.current ?? "feature" });
    expect(JSON.stringify(result)).not.toContain("--force");
  });

  it.each<[string, Partial<ShipInput>, string, string]>([
    ["empty selection", { files: [] }, "files", "Select at least one file."],
    ["detached HEAD", { current: null }, "branch", "HEAD is detached. Check out a branch first."],
    ["PR without push", { pr: true }, "publish", "A draft PR needs Push ticked too."],
    ["push to main", { current: "main", push: true }, "branch", "Pushing to main is off. Pick a new branch, or set ship.allowMainPush in the SlackOC config."],
    ["a new branch named master", { branch: "new", newBranch: "master", push: true }, "branch", "Pushing to master is off. Pick a new branch, or set ship.allowMainPush in the SlackOC config."],
    ["a .. segment", { files: [{ path: "src/../../etc/passwd" }] }, "files", "Refusing a path outside the repo: src/../../etc/passwd"],
    ["an absolute path", { files: [{ path: "/etc/passwd" }] }, "files", "Refusing a path outside the repo: /etc/passwd"],
    ["a rename source outside the repo", { files: [{ path: "x.ts", orig: "../x.ts" }] }, "files", "Refusing a path outside the repo: ../x.ts"],
    ["an empty message", { message: "  \n " }, "message", "Write a commit message."],
    ["a missing branch name", { branch: "new", newBranch: " " }, "branch_name", "Name the new branch."],
    ["a dash-led branch name", { branch: "new", newBranch: "-f" }, "branch_name", "-f isn't a valid branch name."],
    ["a branch name git rejects", { branch: "new", newBranch: "a..b" }, "branch_name", "a..b isn't a valid branch name."],
    // git accepts both, but as a push refspec `+main` force-pushes main and `refs/heads/main` dodges the main check.
    ["a +-led branch name", { branch: "new", newBranch: "+main", push: true }, "branch_name", "+main isn't a valid branch name."],
    ["a refs/ branch name", { branch: "new", newBranch: "refs/heads/main", push: true }, "branch_name", "refs/heads/main isn't a valid branch name."],
    ["shipping from a checked-out +main", { current: "+main", push: true }, "branch", "Can't ship from branch +main."],
  ])("refuses %s", (_name, over, field, refusal) => {
    expect(plan(over)).toEqual({ refusal, field });
  });

  it("pushes to main/master only with allowMainPush", () => {
    expect(plan({ current: "master", push: true, allowMainPush: true })).toMatchObject({ branch: "master",
      steps: expect.arrayContaining([["git", "push", "-u", "origin", "refs/heads/master:refs/heads/master"]]) });
  });

  it("keeps `..` inside a file name (not a segment)", () => {
    expect(plan({ files: [{ path: "notes..md" }] })).toHaveProperty("steps");
  });
});

describe("parseStatusZ", () => {
  it("reads renames (new path first), deletions, untracked and odd names without quoting", () => {
    const out = " M a.txt\0D  gone.txt\0R  new name.txt\0old.txt\0?? -dash.txt\0?? quo\"te.txt\0?? ünï cødé.txt\0C  copy.txt\0src.txt\0MM both.txt\0";
    expect(parseStatusZ(out)).toEqual([
      { code: " M", path: "a.txt" },
      { code: "D ", path: "gone.txt", removed: true },
      { code: "R ", path: "new name.txt", orig: "old.txt" },
      { code: "??", path: "-dash.txt" },
      { code: "??", path: "quo\"te.txt" },
      { code: "??", path: "ünï cødé.txt" },
      { code: "C ", path: "copy.txt" },
      { code: "MM", path: "both.txt" },
    ]);
  });

  it("returns nothing for a clean tree", () => {
    expect(parseStatusZ("")).toEqual([]);
  });
});

describe("runShip", () => {
  const steps = [["git", "add", "--", "a.ts"], ["git", "commit", "-F", MSG_FILE, "--", "a.ts"], ["git", "push", "-u", "origin", "x"]];

  it("feeds the message through a private temp file, and removes it afterwards", async () => {
    let msgFile = "";
    const exec = vi.fn<ExecFileFn>(async (_file, args) => {
      if (args[0] === "commit") {
        msgFile = args[2]!;
        expect(readFileSync(msgFile, "utf8")).toBe("Fix `it` $(rm -rf ~) 'quoted'\n");
        return { stdout: "[x 1a2b3c4] Fix", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const run = await runShip(steps, { cwd: "/repo", message: "Fix `it` $(rm -rf ~) 'quoted'\n", exec });
    expect(run.ok).toBe(true);
    expect(exec.mock.calls.map(c => [c[0], ...c[1]])[1]).toEqual(["git", "commit", "-F", msgFile, "--", "a.ts"]);
    expect(exec.mock.calls.every(c => c[2].cwd === "/repo" && c[2].timeout === 60_000)).toBe(true);
    expect(msgFile).not.toBe(MSG_FILE);
    expect(existsSync(msgFile)).toBe(false);
    expect(shipResultText("x", run)).toBe("🚀 Committed `1a2b3c4` on `x` · pushed");
  });

  it("stops at the first failure and reports the last 20 lines of stderr", async () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `hook line ${i}`).join("\n");
    const exec = vi.fn<ExecFileFn>(async (_file, args) => {
      if (args[0] === "commit") throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr });
      return { stdout: "", stderr: "" };
    });
    const run = await runShip(steps, { cwd: "/repo", message: "m", exec });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ ok: false, failed: steps[1] });
    const tail = (run as { tail: string }).tail.split("\n");
    expect(tail).toHaveLength(20);
    expect(tail[0]).toBe("hook line 10");
    expect(tail.at(-1)).toBe("hook line 29");
    expect(shipResultText("x", run)).toMatch(/^:x: Ship stopped at `git commit -F &lt;msgfile&gt; -- a.ts`\n```\nhook line 10\n/);
  });

  it("redacts credentials a failing push echoes before they reach Slack", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const stderr = `fatal: unable to access 'https://bot:${token}@github.com/o/r.git/': 403\nremote: token ${token} lacks scope`;
    const exec = vi.fn<ExecFileFn>(async (_file, args) => {
      if (args[0] === "push") throw Object.assign(new Error("Command failed"), { code: 128, stdout: "", stderr });
      return { stdout: "", stderr: "" };
    });
    const run = await runShip(steps, { cwd: "/repo", message: "m", exec });
    expect((run as { tail: string }).tail).toBe("fatal: unable to access 'https://***@github.com/o/r.git/': 403\nremote: token *** lacks scope");
  });

  it("names the step that failed after the commit landed, and explains a missing gh", async () => {
    const exec = vi.fn<ExecFileFn>(async (file, args) => {
      if (file === "gh") throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      return { stdout: args[0] === "commit" ? "[x (root-commit) abcdef0] m" : "", stderr: "" };
    });
    const run = await runShip([...steps, ["gh", "pr", "create", "--draft"]], { cwd: "/repo", message: "m", exec });
    expect(shipResultText("x", run)).toBe(
      ":x: Ship stopped at `gh pr create --draft` (committed `abcdef0` on `x` already; nothing was undone)\n```\ngh isn't installed (or isn't on the bridge's PATH).\n```");
  });
});

describe("Ship panel (Slack)", () => {
  const OWNER = "U_OWNER";
  const user = (id = OWNER) => ({ id, username: "u", name: "u", team_id: "T1" });

  function harness(opts: { current?: string; status?: string; allowMainPush?: boolean } = {}) {
    _resetQueueForTests();
    vi.mocked(getView).mockReturnValue(undefined);
    vi.mocked(vcsBranch).mockRejectedValue(new Error("no vcs"));
    vi.mocked(sessionDiff).mockResolvedValue([{ file: "src/a.ts", additions: 2, deletions: 1, patch: "" }]);
    vi.mocked(sessionGet).mockResolvedValue({ id: "ses_1", title: "Fix the flaky test" } as never);
    let current = opts.current ?? "main";
    const ran: string[][] = [];
    const exec = vi.fn<ExecFileFn>(async (file, args) => {
      if (args[0] === "rev-parse") return { stdout: "/repo\n\n", stderr: "" };
      if (args[0] === "symbolic-ref") return { stdout: `${current}\n`, stderr: "" };
      if (args[0] === "status") return { stdout: opts.status ?? " M src/a.ts\0?? notes.txt\0", stderr: "" };
      ran.push([file, ...args]);
      return { stdout: args[0] === "commit" ? "[agent/fix-the-flaky-test 1234abc] Fix" : file === "gh" ? "https://github.com/o/r/pull/7\n" : "", stderr: "" };
    });
    const actions = new Map<string, any>(), views = new Map<string, any>();
    const client = {
      views: { open: vi.fn(async () => ({ view: { id: "V1" } })), push: vi.fn(async () => ({ view: { id: "V2" } })), update: vi.fn(async (_a: any) => ({})) },
      chat: { postMessage: vi.fn(async (_a: any) => ({ ts: "9.9" })) },
    };
    const app: any = { action: (id: string, cb: any) => actions.set(id, cb), view: (id: string, cb: any) => views.set(id, cb), client };
    registerDiffActions(app, { ownerSlackUserId: OWNER, isStopping: () => false, shipExec: exec, allowMainPush: () => opts.allowMainPush ?? false,
      state: { findThreadBySession: () => ({ key: "C_TEST:100.000000", thread: { projectDir: "/repo" } }) } as never,
      pool: { ensure: async () => ({ client: {} }) } as never });
    /** Tap 🚀 Ship… on a DM copy; returns the panel the modal was updated with. */
    const open = async () => {
      await actions.get(SHIP_OPEN_ACTION)({ ack: async () => {}, respond: vi.fn(async () => {}),
        action: { type: "button", action_id: SHIP_OPEN_ACTION, value: "ses_1", action_ts: "1.1" },
        body: { type: "block_actions", user: user(), trigger_id: "1.2.abc", container: { type: "message", message_ts: "5.5", channel_id: "D_OWNER" },
          message: { ts: "5.5", text: "done" } } });
      return client.views.update.mock.calls.at(-1)![0].view;
    };
    const submit = async (modal: any, values: Record<string, unknown>, by = OWNER) => {
      const ack = vi.fn(async (_r?: unknown) => {});
      await views.get(SHIP_SUBMIT)({ ack, body: { type: "view_submission", user: user(by) },
        view: { id: "V1", private_metadata: modal.private_metadata, state: { values } } });
      return ack;
    };
    const setBranch = (b: string) => { current = b; };
    return { client, exec, ran, open, submit, setBranch };
  }

  const values = (over: Record<string, unknown> = {}) => ({
    branch: { v: { selected_option: { value: "new" } } }, branch_name: { v: { value: "agent/fix-the-flaky-test" } },
    files_session: { v: { selected_options: [{ value: "s0" }] } }, files_other: { v: { selected_options: [] } },
    message: { v: { value: "Fix the flaky test\n\nDetails" } }, publish: { v: { selected_options: [{ value: "push" }, { value: "pr" }] } }, ...over });

  beforeEach(() => vi.clearAllMocks());

  it("prefills the panel: new branch on main, session files ticked, others not, publish off", async () => {
    const h = harness();
    const modal = await h.open();
    const blocks = Object.fromEntries(modal.blocks.filter((b: any) => b.block_id).map((b: any) => [b.block_id, b.element]));
    expect(blocks.branch.initial_option.value).toBe("new");
    expect(blocks.branch_name.initial_value).toBe("agent/fix-the-flaky-test");
    expect(blocks.files_session.initial_options.map((o: any) => o.text.text)).toEqual(["M src/a.ts"]);
    expect(blocks.files_other.initial_options).toBeUndefined();
    expect(blocks.publish.initial_options).toBeUndefined();
    expect(blocks.message.initial_value).toBe("Fix the flaky test\n\n+2/-1 across 1 file(s).\n\nMade with SlackOC + OpenCode (ses_1)");
    expect(modal.blocks.at(-1).elements[0].text).toContain("`git switch -c agent/fix-the-flaky-test`");
  });

  it("runs the plan after closing the modal and posts the result in the bound thread", async () => {
    const h = harness();
    const ack = await h.submit(await h.open(), values());
    expect(ack).toHaveBeenCalledWith({ response_action: "clear" });
    await vi.waitFor(() => expect(h.client.chat.postMessage).toHaveBeenCalled(), { timeout: 5_000 });
    expect(h.ran.map(a => a.slice(0, 3))).toEqual([["git", "switch", "-c"], ["git", "add", "--"], ["git", "commit", "-F"],
      ["git", "push", "-u"], ["gh", "pr", "create"]]);
    expect(h.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C_TEST", thread_ts: "100.000000",
      text: "🚀 Committed `1234abc` on `agent/fix-the-flaky-test` · pushed · draft PR <https://github.com/o/r/pull/7>" }));
  });

  it("answers planner refusals as field errors and runs nothing", async () => {
    const h = harness();
    const ack = await h.submit(await h.open(), values({ branch: { v: { selected_option: { value: "current" } } } }));
    expect(ack).toHaveBeenCalledWith({ response_action: "errors",
      errors: { branch: "Pushing to main is off. Pick a new branch, or set ship.allowMainPush in the SlackOC config." } });
    const none = await h.submit(await h.open(), values({ files_session: { v: { selected_options: [] } } }));
    expect(none).toHaveBeenCalledWith({ response_action: "errors", errors: { files_session: "Select at least one file." } });
    expect(h.ran).toEqual([]);
  });

  it("refuses while a run is active in the thread", async () => {
    const h = harness();
    const modal = await h.open();
    vi.mocked(getView).mockReturnValue({} as never);
    const ack = await h.submit(modal, values());
    expect(ack).toHaveBeenCalledWith({ response_action: "errors", errors: { publish: "A run is active in this thread. Ship after it finishes." } });
    expect(h.ran).toEqual([]);
  });

  it("ignores a submission from anyone but the owner", async () => {
    const h = harness();
    const ack = await h.submit(await h.open(), values(), "U_INTRUDER");
    expect(ack).toHaveBeenCalledWith();
    await new Promise(r => setTimeout(r, 20));
    expect(h.ran).toEqual([]);
    expect(h.client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("runs nothing when HEAD moved since the panel opened", async () => {
    const h = harness({ current: "feature" });
    const modal = await h.open();
    h.setBranch("main");
    await h.submit(modal, values({ publish: { v: { selected_options: [] } } }));
    await vi.waitFor(() => expect(h.client.chat.postMessage).toHaveBeenCalled(), { timeout: 5_000 });
    expect(h.ran).toEqual([]);
    expect(h.client.chat.postMessage.mock.calls[0]![0].text).toBe(
      ":x: Ship didn't run: the branch changed to `main` since the panel opened. Tap 🚀 Ship… again.");
  });
});

describe("\\ship", () => {
  const ctx = (thread: unknown) => {
    const posts: Array<{ text: string; blocks?: unknown[] }> = [];
    return { posts, c: { thread, postToThread: async (text: string, blocks?: unknown[]) => { posts.push({ text, blocks }); } } as never };
  };

  it("posts a card whose button opens the Ship panel for this thread's session", async () => {
    vi.mocked(getView).mockReturnValue(undefined);
    const { c, posts } = ctx({ sessionId: "ses_9", projectDir: "/repo" });
    await shipCommand.run(c, "");
    expect(posts[0]!.blocks).toContainEqual(expect.objectContaining({ elements: [expect.objectContaining({ action_id: SHIP_OPEN_ACTION, value: "ses_9" })] }));
  });

  it("refuses while a run is active, and in an unbound thread", async () => {
    vi.mocked(getView).mockReturnValue({} as never);
    await expect(shipCommand.run(ctx({ sessionId: "ses_9", projectDir: "/repo" }).c, "")).rejects.toThrow(/a run is active/);
    await expect(shipCommand.run(ctx(null).c, "")).rejects.toThrow(/no session bound/);
  });
});
