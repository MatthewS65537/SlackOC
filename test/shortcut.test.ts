import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { registerShortcut, shortcutModal, shortcutPrompt } from "../src/slack/shortcut.js";
import { StateStore } from "../src/state.js";
import { deleteView } from "../src/slack/render.js";
import { timestampFromMs } from "../src/slack/recovery-policy.js";

describe("Send to OpenCode shortcut (C3)", () => {
  it("puts instructions before the quoted message and its link", () => {
    expect(shortcutPrompt("Find the cause", "CI failed\non main", "https://x/p1"))
      .toBe("Find the cause\n\nSlack message (https://x/p1):\n\n> CI failed\n> on main");
    expect(shortcutPrompt("", "", undefined)).toBe("Slack message:\n\n> (no text; see attachments)");
  });

  it("defaults to the current project and the message's own thread", () => {
    const view = shortcutModal(["/code/a", "/code/b"], "id-1") as { private_metadata: string; blocks: any[] };
    expect(view.private_metadata).toBe("id-1");
    expect(view.blocks[0].element.initial_option.value).toBe("/code/a");
    expect(view.blocks[2].element.initial_option.value).toBe("thread");
  });
});

describe("Send to OpenCode: chosen project vs. a bound source thread (#11)", () => {
  const FIXTURES = join(import.meta.dirname, ".fixtures", "shortcut");
  afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));
  afterEach(() => { for (const id of ["ses_A", "ses_new"]) deleteView(id); });
  const root = timestampFromMs(Date.now() - 60_000);
  const key = `C:${root}`;

  /** Real modal → shortcut → router path; only Slack and the OpenCode SDK are faked. */
  function rig(name: string) {
    const state = new StateStore(join(FIXTURES, name, "state.json"));
    state.setCurrentProject("/proj/a");
    const submissions: Array<{ dir: string; session: string }> = [];
    const posts: Array<{ channel: string; text: string }> = [];
    let n = 0;
    const pool = { acquire: async (dir: string) => ({ release() {}, entry: { client: { session: {
      create: async () => ({ data: { id: "ses_new" } }),
      promptAsync: async (args: any) => { submissions.push({ dir, session: args.path.id }); return { data: {} }; },
      messages: async () => ({ data: [] }), get: async () => { throw new Error("no summary"); },
    } } } }) };
    const render = { react: async () => {}, unreact: async () => {}, update: async () => {}, delete: async () => {}, upload: async () => {},
      post: async (channel: string, _root: string, text: string) => { posts.push({ channel, text }); return { ts: timestampFromMs(Date.now() - 30_000 + ++n) }; } };
    const bridge = { state, config: { ownerSlackUserId: "U1" }, cwd: "/proj/a", botUserId: "BOT", render, pool };
    let open: any, submit: any, view: any;
    const app = {
      shortcut: (_id: string, cb: any) => { open = cb; },
      view: (_id: string, cb: any) => { submit = cb; },
      client: { views: { open: async (args: any) => { view = args.view; } },
        chat: { getPermalink: async () => ({ permalink: "https://example.invalid/m" }) },
        conversations: { history: async () => ({ messages: [] }) } },
    };
    registerShortcut(app as never, { bridge: bridge as never, ownerSlackUserId: "U1", dmChannel: () => "D", isStopping: () => false });
    const acks: unknown[] = [];
    const send = async (project: string, dest: "thread" | "dm") => {
      if (!view) await open({ ack: async () => {}, respond: async () => {}, shortcut: { type: "message_action", user: { id: "U1" },
        channel: { id: "C" }, trigger_id: "t", message: { ts: root, text: "Change the source file" } } });
      await submit({ ack: async (r?: unknown) => { acks.push(r); }, body: { user: { id: "U1" } }, view: {
        private_metadata: view.private_metadata, state: { values: { project: { v: { selected_option: { value: project } } },
          instructions: { v: { value: "Edit it" } }, dest: { v: { selected_option: { value: dest } } } } } } });
    };
    const bind = () => state.setThread(key, { sessionId: "ses_A", projectDir: "/proj/a", verbose: "on", createdAt: 1, lastUsedAt: 1,
      lastSeenTs: root, historyCursorTs: root });
    return { state, app, submissions, posts, acks, send, bind, modal: () => view };
  }

  it("rejects a different project in the modal, then the same project reuses the bound session", async () => {
    const { submissions, posts, acks, send, bind } = rig("conflict");
    bind();
    await send("/proj/b", "thread");
    expect(acks).toEqual([{ response_action: "errors", errors: { project: expect.stringContaining("/proj/a") } }]);
    expect(posts).toEqual([]);
    expect(submissions).toEqual([]);
    await send("/proj/a", "thread"); // the modal stayed open: same submission, corrected
    expect(submissions).toEqual([{ dir: "/proj/a", session: "ses_A" }]);
  });

  it("a thread bound to another project after submission is refused by the router, visibly", async () => {
    const { app, submissions, posts, acks, send, bind } = rig("race");
    app.client.chat.getPermalink = async () => { bind(); return { permalink: "https://example.invalid/m" }; };
    await send("/proj/b", "thread");
    expect(acks).toEqual([undefined]);
    expect(submissions).toEqual([]);
    expect(posts.at(-1)?.text).toMatch(/Not sent: this thread runs in `\/proj\/a`.*`\/proj\/b`/);
  });

  it("a pinned channel preselects its pin and refuses other projects for a new thread", async () => {
    const { state, submissions, acks, send, modal } = rig("pinned");
    state.setChannelProject("C", "/proj/b");
    await send("/proj/a", "thread");
    expect(modal().blocks[0].element.initial_option.value).toBe("/proj/b");
    expect(acks).toEqual([{ response_action: "errors", errors: { project: expect.stringContaining("pinned to /proj/b") } }]);
    await send("/proj/b", "thread");
    expect(submissions).toEqual([{ dir: "/proj/b", session: "ses_new" }]);
  });

  it("a DM destination still creates a fresh session in the chosen project", async () => {
    const { state, submissions, send, bind } = rig("dm");
    bind();
    await send("/proj/b", "dm");
    expect(submissions).toEqual([{ dir: "/proj/b", session: "ses_new" }]);
    expect(state.getThread(key)?.sessionId).toBe("ses_A");
  });
});

