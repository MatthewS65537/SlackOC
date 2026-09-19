import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Jimp, JimpMime } from "jimp";
import { claimEvent, hushAction, handleIncomingMessage, type BridgeDeps, type SlackMsg } from "../src/slack/router.js";
import type { RenderDeps } from "../src/slack/render.js";
import type { ServerPool } from "../src/opencode/server.js";
import type { SlackocConfig } from "../src/config.js";
import { MAX_MESSAGE_RECEIPTS, RECOVERY_RECEIPT_RESERVE, StateStore } from "../src/state.js";
import { MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, TARGET_IMAGE_BYTES } from "../src/image.js";
import { deleteView } from "../src/slack/render.js";
import { sweepMissedMessages } from "../src/slack/catchup.js";
import { registerCommand } from "../src/commands/registry.js";

describe("claimEvent (Slack double-delivery dedup)", () => {
  it("claims a channel+ts exactly once", () => {
    expect(claimEvent("C1", "100.001")).toBe(true);
    expect(claimEvent("C1", "100.001")).toBe(false);
    expect(claimEvent("C1", "100.002")).toBe(true);
    expect(claimEvent("C2", "100.001")).toBe(true);
  });
});

describe("hushAction", () => {
  const hushed = { hushed: true };

  it("proceeds when the thread isn't hushed", () => {
    expect(hushAction(null, false, false)).toBe("proceed");
    expect(hushAction({ hushed: false }, false, false)).toBe("proceed");
  });

  it("ignores plain messages in a hushed thread", () => {
    expect(hushAction(hushed, false, false)).toBe("ignore");
  });

  it("always lets \\ commands through", () => {
    expect(hushAction(hushed, false, true)).toBe("proceed");
  });

  it("an explicit @mention wakes a hushed thread", () => {
    expect(hushAction(hushed, true, false)).toBe("unhush");
    expect(hushAction(hushed, true, true)).toBe("unhush");
  });
});

// ---------------------------------------------------------------------------
// Full message-flow tests: fake pool/client/render at the seams, real
// StateStore on a fixture dir (no OpenCode spawned, no Slack calls).
// Owns its own subdir and cleans it: a persisted binding from a passing run
// would otherwise self-poison the NEXT run (e.g. NB3's cold-start path
// silently taking the bound-session branch instead of creating a session).

const FIXTURES = join(import.meta.dirname ?? __dirname, ".fixtures", "router");

afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

interface CallLog {
  posted: string[];
  deleted: string[];
  reacted: Array<[string, string]>;
  dms: string[];
}

function fakeRender(log: CallLog): RenderDeps {
  let n = 0;
  return {
    post: async (_c, _t, text) => {
      log.posted.push(text);
      return { ts: `ts-${++n}` };
    },
    update: async () => {},
    delete: async (_c, ts) => void log.deleted.push(ts),
    react: async (_c, ts, name) => void log.reacted.push([ts, name]),
    unreact: async () => {},
    upload: async () => {},
    dm: async (_c, _t, text) => {
      log.dms.push(text);
      return { ts: "dm-1" };
    },
  };
}

function fakePool(client: Record<string, unknown>): ServerPool {
  const entry = {
    dir: "/p",
    url: "http://127.0.0.1:1",
    baseUrl: "http://127.0.0.1:1",
    client,
    status: "ready",
    ready: Promise.resolve(),
    sseAbort: null,
    proc: null,
  };
  return { ensure: async () => entry, list: () => [], killOne: async () => {} } as unknown as ServerPool;
}

function makeDeps(name: string, pool: ServerPool, render: RenderDeps): BridgeDeps & { state: StateStore } {
  const config = {
    slackBotToken: "xoxb-t",
    slackAppToken: "xapp-t",
    ownerSlackUserId: "U1",
    createdAt: "",
  } as SlackocConfig;
  return { config, state: new StateStore(join(FIXTURES, name, "state.json")), pool, render, botUserId: "UBOT", cwd: "/p" };
}

function ownerMsg(channel: string, ts: string, threadTs: string | undefined, text: string): SlackMsg {
  return { channel, ts, thread_ts: threadTs, user: "U1", text };
}

describe("rebind prompt failure (NB1)", () => {
  it("404 permits one rebind; an ambiguous retry retains evidence and reports uncertainty", async () => {
    let promptCalls = 0;
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1;
          throw new Error(promptCalls === 1 ? "404 not found" : "boom");
        },
        create: async () => ({ data: { id: "sess-new" } }),
        messages: async () => ({ data: [] }),
        get: async () => {
          throw new Error("no summary");
        },
      },
    };
    const log: CallLog = { posted: [], deleted: [], reacted: [], dms: [] };
    const d = makeDeps("router-nb1", fakePool(client), fakeRender(log));
    const msg = ownerMsg("C9", "900.001", undefined, "hello");
    d.state.setThread("C9:900.001", { sessionId: "sess-old", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });

    expect(await handleIncomingMessage(msg, d)).toBe("uncertain");

    expect(promptCalls).toBe(2); // original + the rebind retry
    expect(log.reacted).toEqual([["900.001", "eyes"]]);
    expect(log.posted.some((p) => p.includes("Prompt acceptance is uncertain") && p.includes("boom"))).toBe(true);
    expect(log.deleted.length).toBe(0);
    const t = d.state.getThread("C9:900.001");
    expect(t?.sessionId).toBe("sess-new");
    expect(t?.pendingRun).toBeDefined(); // may still be running; reconciliation owns completion
    expect(d.state.getReceipt("C9:900.001", msg.ts)?.disposition).toBe("uncertain");
    expect(await handleIncomingMessage(msg, d)).toBe("uncertain");
    expect(promptCalls).toBe(2);
    deleteView("sess-new");
  });
});

describe("concurrent cold-start prompts (NB3)", () => {
  it("two quick prompts create exactly one session; the follower queues", async () => {
    let createCalls = 0;
    let promptCalls = 0;
    let releaseCreate!: (v: { data: { id: string } }) => void;
    const createGate = new Promise<{ data: { id: string } }>((res) => {
      releaseCreate = res;
    });
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1;
          return { data: {} };
        },
        create: async () => {
          createCalls += 1;
          return createGate;
        },
        messages: async () => ({ data: [] }),
        get: async () => {
          throw new Error("no summary");
        },
      },
    };
    const log: CallLog = { posted: [], deleted: [], reacted: [], dms: [] };
    const d = makeDeps("router-nb3", fakePool(client), fakeRender(log));

    const first = handleIncomingMessage(ownerMsg("C9", "900.101", "900.100", "run A"), d);
    // Wait until the first prompt is inside session.create (creation lock set).
    await vi.waitFor(() => expect(createCalls).toBe(1));
    const second = handleIncomingMessage(ownerMsg("C9", "900.102", "900.100", "run B"), d);
    releaseCreate({ data: { id: "sess-1" } });
    await Promise.all([first, second]);

    expect(createCalls).toBe(1); // no duplicate session from the race
    expect(promptCalls).toBe(2); // both prompts delivered on the shared session
    expect(log.posted.some((p) => p.includes("Queued — runs after the current task"))).toBe(true);
    expect(d.state.getThread("C9:900.100")?.sessionId).toBe("sess-1");
  });
});

describe("real-router recovery receipts", () => {
  const root = "1200.000000";
  const baseline = "1200.000001";
  const blankLog = (): CallLog => ({ posted: [], deleted: [], reacted: [], dms: [] });
  function setup(name: string, prompt: (args: any) => Promise<unknown>) {
    const log = blankLog();
    const client = { session: { promptAsync: prompt, messages: async () => ({ data: [] }),
      get: async () => ({ data: {} }), create: vi.fn(async () => ({ data: { id: `${name}-new` } })) } };
    const d = makeDeps(name, fakePool(client), fakeRender(log));
    d.state.setThread(`C:${root}`, { sessionId: name, projectDir: "/p", verbose: "on", createdAt: 1,
      lastUsedAt: 1, lastSeenTs: baseline, notify: true });
    const catchup = (messages: SlackMsg[]) => sweepMissedMessages({ state: d.state, ownerSlackUserId: "U1",
      fetchReplies: async () => messages, dispatch: (m) => handleIncomingMessage(m, d) });
    return { d, log, client, catchup };
  }

  it("a newer live submission does not hide an older history gap", async () => {
    const submitted: string[] = [];
    const { d, catchup } = setup("receipt-gap", async (args) => { submitted.push(args.body.parts[0].text); return { data: {} }; });
    try {
      const newer = ownerMsg("C", "1200.000003", root, "newer live");
      const older = ownerMsg("C", "1200.000002", root, "older missed");
      expect(await handleIncomingMessage(newer, d)).toBe("accepted");
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(baseline);
      expect(await catchup([newer, older])).toBe(1);
      expect(submitted).toEqual(["newer live", "older missed"]);
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(newer.ts);
      expect(d.state.recoveryStatus().receipts).toBe(0);
      expect(await handleIncomingMessage(older, d)).toBe("accepted");
      expect(submitted).toHaveLength(2);
    } finally { deleteView("receipt-gap"); }
  });

  it("live/replay overlap neither resubmits nor consumes an in-flight message; lease spans submission", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    const prompt = vi.fn(async () => { await gate; return { data: {} }; });
    const { d, catchup } = setup("receipt-race", prompt);
    const release = vi.fn();
    d.pool.acquire = async (dir) => ({ entry: await d.pool.ensure(dir), release });
    const msg = ownerMsg("C", "1200.000002", root, "once");
    try {
      const live = handleIncomingMessage(msg, d);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(release).not.toHaveBeenCalled();
      expect(await handleIncomingMessage(msg, d)).toBe("processing");
      expect(await catchup([msg])).toBe(0);
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(baseline);
      expect(d.state.getReceipt(`C:${root}`, msg.ts)?.disposition).toBe("processing");
      finish();
      expect(await live).toBe("accepted");
      expect(release).toHaveBeenCalledOnce();
      expect(await catchup([msg])).toBe(0);
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(msg.ts);
      expect(prompt).toHaveBeenCalledOnce();
    } finally { finish(); deleteView("receipt-race"); }
  });

  it("a real pre-submission pool failure releases its claim despite lastSeen moving, then retries", async () => {
    const prompt = vi.fn(async () => ({ data: {} }));
    const { d, catchup } = setup("receipt-retry", prompt);
    const ensure = d.pool.ensure.bind(d.pool);
    let failed = false;
    d.pool.ensure = async (dir) => { if (!failed) { failed = true; throw new Error("health unavailable"); } return ensure(dir); };
    const msg = ownerMsg("C", "1200.000002", root, "retry safe");
    try {
      expect(await catchup([msg])).toBe(0);
      expect(d.state.getThread(`C:${root}`)?.lastSeenTs).toBe(msg.ts);
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(baseline);
      expect(d.state.getReceipt(`C:${root}`, msg.ts)).toBeUndefined();
      expect(prompt).not.toHaveBeenCalled();
      expect(await catchup([msg])).toBe(1);
      expect(prompt).toHaveBeenCalledOnce();
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(msg.ts);
    } finally { deleteView("receipt-retry"); }
  });

  it("timeout (even mentioning 404) is not rebound or replayed after restart", async () => {
    const prompt = vi.fn(async () => { throw new Error("request timed out after 404 ms"); });
    const { d, log, client, catchup } = setup("receipt-timeout", prompt);
    const release = vi.fn();
    d.pool.acquire = async (dir) => ({ entry: await d.pool.ensure(dir), release });
    const msg = ownerMsg("C", "1200.000002", root, "may be running");
    try {
      expect(await handleIncomingMessage(msg, d)).toBe("uncertain");
      expect(release).toHaveBeenCalledOnce();
      expect(client.session.create).not.toHaveBeenCalled();
      expect(log.posted.some((s) => s.includes("will not automatically resubmit"))).toBe(true);
      d.state = new StateStore(join(FIXTURES, "receipt-timeout", "state.json"));
      expect(await handleIncomingMessage(msg, d)).toBe("uncertain");
      expect(await catchup([msg])).toBe(0);
      expect(prompt).toHaveBeenCalledOnce();
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(baseline);
    } finally { deleteView("receipt-timeout"); }
  });

  it("forwards and persists a generated messageID, then resolves a timeout only from its matching user transcript entry", async () => {
    let sentID = "";
    let persistedSubmission: unknown;
    const prompt = vi.fn(async (args) => {
      sentID = args.body.messageID;
      const persisted = new StateStore(join(FIXTURES, "receipt-correlated", "state.json"));
      persistedSubmission = persisted.getReceipt(`C:${root}`, "1200.000002")?.submission;
      throw new Error("HTTP timeout after possible acceptance");
    });
    const { d, catchup } = setup("receipt-correlated", prompt);
    const msg = ownerMsg("C", "1200.000002", root, "correlate this");
    try {
      expect(await handleIncomingMessage(msg, d)).toBe("uncertain");
      expect(sentID).toMatch(/^msg_[0-9a-f]+$/);
      expect(persistedSubmission).toEqual({ projectDir: "/p", sessionId: "receipt-correlated", messageId: sentID });
      d.state = new StateStore(join(FIXTURES, "receipt-correlated", "state.json"));
      expect(d.state.reconcilePromptAcceptance("/p", { id: "msg_later", sessionID: "receipt-correlated", role: "user" })).toEqual([]);
      expect(await catchup([msg])).toBe(0);
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(baseline);
      expect(d.state.reconcilePromptAcceptance("/p", { id: sentID, sessionID: "receipt-correlated", role: "user" })).toHaveLength(1);
      expect(await catchup([msg])).toBe(0); // consumes evidence; no second submission
      expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(msg.ts);
      expect(prompt).toHaveBeenCalledOnce();
    } finally { deleteView("receipt-correlated"); }
  });

  it("SSE acceptance can precede HTTP failure and history cleanup without a false uncertain/rebind outcome", async () => {
    let sentID = "";
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => { fail = resolve; });
    const prompt = vi.fn(async (args) => { sentID = args.body.messageID; await gate; throw new Error("404 not found"); });
    const { d, client, log, catchup } = setup("receipt-evidence-race", prompt);
    const msg = ownerMsg("C", "1200.000002", root, "race with SSE");
    try {
      const live = handleIncomingMessage(msg, d);
      await vi.waitFor(() => expect(sentID).not.toBe(""));
      expect(d.state.reconcilePromptAcceptance("/p", { id: sentID, sessionID: "receipt-evidence-race", role: "user" })).toHaveLength(1);
      await catchup([msg]);
      expect(d.state.getReceipt(`C:${root}`, msg.ts)).toBeUndefined();
      fail();
      expect(await live).toBe("accepted");
      expect(prompt).toHaveBeenCalledOnce();
      expect(client.session.create).not.toHaveBeenCalled();
      expect(log.posted.some((s) => s.includes("acceptance is uncertain"))).toBe(false);
    } finally { fail(); deleteView("receipt-evidence-race"); }
  });

  it("retains a failed command's partial side effect and never repeats it", async () => {
    let effects = 0;
    registerCommand({ name: "receiptpartial", usage: "", summary: "", run: async (ctx) => {
      effects++;
      ctx.state.setThread(ctx.threadKey, { ...ctx.thread!, notify: false });
      throw new Error("failed after mutation");
    } });
    const { d, catchup } = setup("receipt-command", async () => ({ data: {} }));
    const msg = ownerMsg("C", "1200.000002", root, "\\receiptpartial");
    expect(await handleIncomingMessage(msg, d)).toBe("uncertain");
    expect(d.state.getThread(`C:${root}`)?.notify).toBe(false);
    expect(await catchup([msg])).toBe(0);
    expect(effects).toBe(1);
    expect(d.state.getThread(`C:${root}`)?.historyCursorTs).toBe(baseline);
  });

  it("two immediate cold messages share creation even when both await a cold-start ack", async () => {
    const create = vi.fn(async () => ({ data: { id: "receipt-cold" } }));
    const prompt = vi.fn(async () => ({ data: {} }));
    const log = blankLog();
    const pool = fakePool({ session: { create, promptAsync: prompt } });
    const d = makeDeps("receipt-cold", pool, fakeRender(log));
    let held = 0;
    pool.acquire = async (dir) => { held++; return { entry: await pool.ensure(dir), release: () => { held--; } }; };
    try {
      const outcomes = await Promise.all([
        handleIncomingMessage(ownerMsg("C", "1300.000001", "1300.000000", "one"), d),
        handleIncomingMessage(ownerMsg("C", "1300.000002", "1300.000000", "two"), d),
      ]);
      expect(outcomes).toEqual(["accepted", "accepted"]);
      expect(create).toHaveBeenCalledOnce();
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(held).toBe(0);
      expect(log.posted.filter((text) => text.startsWith("⏳ OpenCode"))).toHaveLength(2);
      expect(log.deleted.filter((ts) => ts === "ts-2")).toHaveLength(1); // follower's extra ack was not adopted
    } finally { deleteView("receipt-cold"); }
  });
});

describe("receipt capacity recovery commands", () => {
  function saturated(name: string, count = MAX_MESSAGE_RECEIPTS) {
    const path = join(FIXTURES, name, "state.json");
    mkdirSync(join(FIXTURES, name), { recursive: true });
    const receipts = Object.fromEntries(Array.from({ length: count }, (_, i) => {
      const ts = `1400.${String(i + 1).padStart(6, "0")}`;
      return [`stuck:${ts}`, { threadKey: "stuck:1400.000000", ts, disposition: "uncertain", updatedAt: 1 }];
    }));
    writeFileSync(path, JSON.stringify({ threads: {}, projects: {}, receipts }));
    const log: CallLog = { posted: [], deleted: [], reacted: [], dms: [] };
    const d = makeDeps(name, fakePool({}), fakeRender(log));
    d.cwd = "/capacity-recovery";
    const kill = vi.fn(async () => {});
    d.pool.killOne = kill;
    return { d, log, kill, path };
  }

  it("reserves a durable slot for restart and suppresses its duplicate after a process restart", async () => {
    const { d, kill, path } = saturated("reserve-restart");
    const msg = ownerMsg("recovery", "1500.000001", undefined, "\\restart");
    expect(await handleIncomingMessage(ownerMsg("recovery", "1500.000000", undefined, "a prompt"), d)).toBe("paused");
    expect(await handleIncomingMessage(msg, d)).toBe("accepted");
    expect(kill).toHaveBeenCalledOnce();
    expect(d.state.recoveryStatus().receipts).toBe(MAX_MESSAGE_RECEIPTS + 1);
    d.state = new StateStore(path);
    expect(await handleIncomingMessage(msg, d)).toBe("accepted");
    expect(kill).toHaveBeenCalledOnce();
    expect(d.state.recoveryStatus().uncertain).toBe(MAX_MESSAGE_RECEIPTS);
  });

  it("status stays read-only and available even at the hard limit; restart cannot bypass durable claims", async () => {
    const { d, log, kill, path } = saturated("hard-cap-status", MAX_MESSAGE_RECEIPTS + RECOVERY_RECEIPT_RESERVE);
    const msg = ownerMsg("recovery", "1501.000001", undefined, "\\status");
    expect(await handleIncomingMessage(msg, d)).toBe("accepted");
    expect(log.posted.some((s) => s.includes("*Recovery:* paused"))).toBe(true);
    const posted = log.posted.length;
    expect(await handleIncomingMessage(msg, d)).toBe("ignored");
    expect(log.posted).toHaveLength(posted);
    expect(await handleIncomingMessage(ownerMsg("recovery", "1501.000002", undefined, "\\restart"), d)).toBe("paused");
    expect(kill).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).receipts)).toHaveLength(MAX_MESSAGE_RECEIPTS + RECOVERY_RECEIPT_RESERVE);
    expect(d.state.recoveryStatus().uncertain).toBe(MAX_MESSAGE_RECEIPTS + RECOVERY_RECEIPT_RESERVE);
  });
});

// ---------------------------------------------------------------------------
// Attachments (F1 live bug): newer Slack clients upload images with NO
// subtype at all — gating on `subtype === "file_share"` silently dropped
// them. Attachments now key off the files array's presence.

describe("attachments key off files presence, not subtype", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

  type FullLog = CallLog & { unreacted: Array<[string, string]> };
  const blankLog = (): FullLog => ({ posted: [], deleted: [], reacted: [], dms: [], unreacted: [] });

  function stubDownload(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => PNG_BYTES })),
    );
  }

  /** richer render fake: also records unreacts and returns tracked posts. */
  function fakeRenderFull(log: FullLog): RenderDeps {
    const base = fakeRender(log);
    return { ...base, unreact: async (_c, ts, name) => void log.unreacted.push([ts, name]) };
  }

  function promptCapturingClient(): { client: Record<string, unknown>; bodies: Array<{ parts?: Array<Record<string, unknown>> }> } {
    const bodies: Array<{ parts?: Array<Record<string, unknown>> }> = [];
    const client = {
      session: {
        promptAsync: async (args: { body: { parts?: Array<Record<string, unknown>> } }) => {
          bodies.push(args.body);
          return { data: {} };
        },
        create: async () => ({ data: { id: "sess-att" } }),
        messages: async () => ({ data: [] }),
        get: async () => {
          throw new Error("no summary");
        },
      },
    };
    return { client, bodies };
  }

  function imgMsg(channel: string, ts: string, text: string | undefined, subtype?: string): SlackMsg {
    return {
      channel,
      ts,
      user: "U1",
      text,
      subtype,
      files: [{ mimetype: "image/png", name: "shot.png", url_private_download: "https://files.example/shot.png", size: 4 }],
    };
  }

  it("subtype-absent image upload + caption: model receives the image as a file part", async () => {
    stubDownload();
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-a", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.001", "what is in this screenshot?"), d);

    expect(bodies).toHaveLength(1);
    const parts = bodies[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ type: "text", text: "what is in this screenshot?" });
    const file = parts.find((p) => p.type === "file");
    expect(file).toMatchObject({ type: "file", mime: "image/png", filename: "shot.png" });
    expect(String(file?.url)).toMatch(/^data:image\/png;base64,/);
  });

  it("subtype-absent image with no caption: default caption + file part", async () => {
    stubDownload();
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-b", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.002", undefined, undefined), d);

    const parts = bodies[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ type: "text", text: "look at this attached file" });
    expect(parts.some((p) => p.type === "file")).toBe(true);
  });

  it("classic file_share subtype still attaches (regression of the original gate)", async () => {
    stubDownload();
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-c", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.003", "old-style upload", "file_share"), d);

    expect((bodies[0]?.parts ?? []).some((p) => p.type === "file")).toBe(true);
  });

  it("download failure: warning posted, no file part, no silent swallow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-d", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.004", undefined, undefined), d);

    expect(log.posted.some((p) => p.includes("couldn't attach"))).toBe(true);
    expect(bodies).toHaveLength(0); // caption-less + all downloads failed → abort (no misleading fileless prompt)
  });

  it("oversized image is downscaled to a JPEG and sent (no skip)", async () => {
    // 1900x1750 noise PNG ≈ 9.5MB — over the 1MB image target.
    const img = new Jimp({ width: 1900, height: 1750 });
    let s = 7;
    img.scan(0, 0, 1900, 1750, (_x, _y, i) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img.bitmap.data[i] = s & 0xff;
      img.bitmap.data[i + 1] = (s >> 8) & 0xff;
      img.bitmap.data[i + 2] = (s >> 16) & 0xff;
      img.bitmap.data[i + 3] = 255;
    });
    const big = await img.getBuffer(JimpMime.png);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
      })),
    );
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-big", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.201", "big screenshot"), d);

    const parts = bodies[0]?.parts ?? [];
    const file = parts.find((p) => p.type === "file");
    expect(file).toMatchObject({ type: "file", mime: "image/jpeg" });
    expect(String(file?.url)).toMatch(/^data:image\/jpeg;base64,/);
    expect(log.posted.some((p) => p.includes("compressed"))).toBe(true);
    expect(log.posted.some((p) => p.includes("too large to send"))).toBe(false);
  });

  it("mid-size image (over 1MB target, under 8MB) is now compressed, not passed through", async () => {
    // The 413 regression: a 2MB image is a 2.7MB data URI — under the old 8MB
    // cap (passed through untouched) but over provider gateway body limits.
    const img = new Jimp({ width: 950, height: 850 });
    let s = 13;
    img.scan(0, 0, 950, 850, (_x, _y, i) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img.bitmap.data[i] = s & 0xff;
      img.bitmap.data[i + 1] = (s >> 8) & 0xff;
      img.bitmap.data[i + 2] = (s >> 16) & 0xff;
      img.bitmap.data[i + 3] = 255;
    });
    const mid = await img.getBuffer(JimpMime.png);
    expect(mid.length).toBeGreaterThan(TARGET_IMAGE_BYTES);
    expect(mid.length).toBeLessThan(MAX_ATTACHMENT_BYTES);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => mid.buffer.slice(mid.byteOffset, mid.byteOffset + mid.byteLength),
      })),
    );
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-mid", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.202", "mid-size shot"), d);

    const parts = bodies[0]?.parts ?? [];
    const file = parts.find((p) => p.type === "file");
    expect(file).toMatchObject({ type: "file", mime: "image/jpeg" });
    // data URI stays under the ~1.37MB envelope the target implies
    expect(String(file?.url).length).toBeLessThanOrEqual(Math.ceil((TARGET_IMAGE_BYTES * 4) / 3) + 32);
    expect(log.posted.some((p) => p.includes("compressed"))).toBe(true);
  });

  it("big-pixel image under the byte cap is STILL compressed (the airouter 413 regression)", async () => {
    // 2026-09-13 incident: a 694kB/3024x4032 JPEG receipt passed the 1MB byte
    // gate untouched — but opencode re-encoded it to a 3.67MB PNG for the
    // provider call (5.15MB body) and airouter 413'd. Small-bytes + big
    // pixels here emulates "photo pixels, tiny file": a smooth 2000x2800 PNG
    // is well under TARGET_IMAGE_BYTES yet far over the pixel ceiling.
    // Solid-color compresses tiny under PNG while keeping 2000x2800px.
    const img = new Jimp({ width: 2000, height: 2800, color: 0x336699ff });
    const bigPixels = await img.getBuffer(JimpMime.png);
    expect(bigPixels.length).toBeLessThan(TARGET_IMAGE_BYTES); // byte gate would have passed it
    const decoded = await Jimp.read(bigPixels);
    expect(Math.max(decoded.bitmap.width, decoded.bitmap.height)).toBeGreaterThan(MAX_IMAGE_EDGE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => bigPixels.buffer.slice(bigPixels.byteOffset, bigPixels.byteOffset + bigPixels.byteLength),
      })),
    );
    const log = blankLog();
    const { client, bodies } = promptCapturingClient();
    const d = makeDeps("router-att-pixels", fakePool(client), fakeRenderFull(log));

    await handleIncomingMessage(imgMsg("C10", "910.300", "check this receipt"), d);

    const file = (bodies[0]?.parts ?? []).find((p) => p.type === "file");
    expect(file).toMatchObject({ type: "file", mime: "image/jpeg" }); // re-encoded, not passed through
    expect(log.posted.some((p) => p.includes("compressed"))).toBe(true);
  });
});

describe("eyes liveness ack", () => {
  it("an accepted prompt gets 👀 immediately (removed at finalize by the view)", async () => {
    const log = { posted: [] as string[], deleted: [] as string[], reacted: [] as Array<[string, string]>, dms: [] as string[], unreacted: [] as Array<[string, string]> };
    const base = fakeRender(log);
    const render: RenderDeps = { ...base, unreact: async (_c, ts, name) => void log.unreacted.push([ts, name]) };
    const d = makeDeps("router-eyes", fakePool({
      session: {
        promptAsync: async () => ({ data: {} }),
        create: async () => ({ data: { id: "sess-eyes" } }),
        messages: async () => ({ data: [] }),
        get: async () => {
          throw new Error("no summary");
        },
      },
    }), render);

    await handleIncomingMessage(ownerMsg("C11", "911.001", undefined, "run something"), d);

    expect(log.reacted[0]).toEqual(["911.001", "eyes"]); // first reaction on the message
  });

  it("cold-start failure also clears the 👀 (❌ alone remains)", async () => {
    const log = { posted: [] as string[], deleted: [] as string[], reacted: [] as Array<[string, string]>, dms: [] as string[], unreacted: [] as Array<[string, string]> };
    const base = fakeRender(log);
    const render: RenderDeps = { ...base, unreact: async (_c, ts, name) => void log.unreacted.push([ts, name]) };
    const pool = { ensure: async () => { throw new Error("spawn blew up"); }, list: () => [], killOne: async () => {} } as unknown as ServerPool;
    const d = makeDeps("router-eyes-fail", pool, render);

    await handleIncomingMessage(ownerMsg("C11", "911.010", undefined, "run something"), d);

    expect(log.reacted).toContainEqual(["911.010", "eyes"]);
    expect(log.unreacted).toContainEqual(["911.010", "eyes"]);
    expect(log.reacted[log.reacted.length - 1]).toEqual(["911.010", "x"]);
    expect(log.posted.some((p) => p.includes("spawn blew up"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// \watch gate: a watchOnly thread rejects plain replies (RESUME_SESSIONS phase 3)

describe("watchOnly gate", () => {
  it("rejects plain replies with the takeover hint — no 👀, no prompt, no session create", async () => {
    let prompts = 0;
    let created = 0;
    const client = {
      session: {
        promptAsync: async () => {
          prompts += 1;
          return { data: {} };
        },
        create: async () => {
          created += 1;
          return { data: { id: "sess-new" } };
        },
      },
    };
    const log: CallLog = { posted: [], deleted: [], reacted: [], dms: [] };
    const d = makeDeps("router-watchgate", fakePool(client), fakeRender(log));
    d.state.setThread("C9:960.001", { sessionId: "sess-watch", projectDir: "/p", verbose: "on", watchOnly: true, createdAt: 1, lastUsedAt: 1 });

    await handleIncomingMessage(ownerMsg("C9", "960.002", "960.001", "hello"), d);

    expect(prompts).toBe(0);
    expect(created).toBe(0);
    expect(log.reacted).toEqual([]); // rejected before the liveness ack
    expect(log.posted.join("\n")).toContain("watch-only");
    expect(log.posted.join("\n")).toContain("\\resume");
  });

  it("stops gating once \\resume (or anything) cleared watchOnly", async () => {
    const client = {
      session: {
        promptAsync: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        get: async () => {
          throw new Error("no summary");
        },
      },
    };
    const log: CallLog = { posted: [], deleted: [], reacted: [], dms: [] };
    const d = makeDeps("router-watchgate-off", fakePool(client), fakeRender(log));
    d.state.setThread("C9:970.001", { sessionId: "sess-now-mine", projectDir: "/p", verbose: "on", createdAt: 1, lastUsedAt: 1 });

    await handleIncomingMessage(ownerMsg("C9", "970.002", "970.001", "hello"), d);

    expect(log.posted.join("\n")).not.toContain("watch-only");
    expect(log.reacted).toContainEqual(["970.002", "eyes"]);
  });
});
