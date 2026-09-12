import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Jimp, JimpMime } from "jimp";
import { claimEvent, hushAction, handleIncomingMessage, type BridgeDeps, type SlackMsg } from "../src/slack/router.js";
import type { RenderDeps } from "../src/slack/render.js";
import type { ServerPool } from "../src/opencode/server.js";
import type { SlackocConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { MAX_ATTACHMENT_BYTES, TARGET_IMAGE_BYTES } from "../src/image.js";

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
  it("a failed retry finalizes: ❌, error line, status removed, failure DM", async () => {
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

    await handleIncomingMessage(msg, d);

    expect(promptCalls).toBe(2); // original + the rebind retry
    expect(log.reacted).toEqual([
      ["900.001", "eyes"], // liveness ack on dispatch
      ["900.001", "x"],
    ]);
    expect(log.posted.some((p) => p.includes("prompt failed after rebind: boom"))).toBe(true);
    expect(log.deleted.length).toBe(1); // live status/ack removed
    expect(log.dms.some((m) => m.includes("failed"))).toBe(true); // pager fired
    const t = d.state.getThread("C9:900.001");
    expect(t?.sessionId).toBe("sess-new");
    expect(t?.pendingRun).toBeUndefined(); // finalize cleared the tombstone
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