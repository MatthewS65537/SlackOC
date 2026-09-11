import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sweepMissedMessages, type CatchupDeps } from "../src/slack/catchup.js";
import { handleIncomingMessage, type BridgeDeps, type SlackMsg } from "../src/slack/router.js";
import type { RenderDeps } from "../src/slack/render.js";
import type { ServerPool } from "../src/opencode/server.js";
import type { SlackocConfig } from "../src/config.js";
import { StateStore, type ThreadState } from "../src/state.js";

// Test fixtures stay inside the project (never the system tmpdir), in this
// suite's own subdir (parallel suites share the .fixtures root).
const FIXTURES = join(import.meta.dirname ?? __dirname, ".fixtures", "catchup");

afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

const OWNER = "U1";

function tempStore(name: string): StateStore {
  return new StateStore(join(FIXTURES, name, "state.json"));
}

/** setThread bumps lastUsedAt to now — hand-write state when a stale one is needed. */
function storeWithThreads(name: string, threads: Record<string, ThreadState>): StateStore {
  const dir = join(FIXTURES, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ threads, projects: {} }));
  return new StateStore(path);
}

const NOW = Date.now();

function bind(store: StateStore, channel: string, rootTs: string, lastSeenTs: string | undefined): void {
  store.setThread(`${channel}:${rootTs}`, {
    sessionId: "ses_x",
    projectDir: "/p",
    verbose: "on",
    ...(lastSeenTs ? { lastSeenTs } : {}),
    createdAt: NOW,
    lastUsedAt: NOW,
  });
}

/** History-API realism: conversations.replies messages lack `channel` (socket events have it). */
function asApiMessages(msgs: SlackMsg[]): SlackMsg[] {
  return msgs.map((m) => {
    const { channel: _c, ...rest } = m;
    return rest as SlackMsg;
  });
}

/** A minimal harness: fake replies source + recording dispatch. */
function harness(
  store: StateStore,
  replies: Record<string, SlackMsg[]>,
  dispatch?: CatchupDeps["dispatch"],
): { deps: CatchupDeps; dispatched: SlackMsg[]; fetches: string[] } {
  const dispatched: SlackMsg[] = [];
  const fetches: string[] = [];
  return {
    deps: {
      state: store,
      ownerSlackUserId: OWNER,
      fetchReplies: async (channel, rootTs, oldest) => {
        fetches.push(`${channel}:${rootTs}@${oldest}`);
        return asApiMessages(replies[`${channel}:${rootTs}`] ?? []);
      },
      dispatch:
        dispatch ??
        (async (m) => {
          dispatched.push(m);
          store.markThreadSeen(`${m.channel}:${m.thread_ts ?? m.ts}`, m.ts);
        }),
    },
    dispatched,
    fetches,
  };
}

describe("missed-message catch-up sweep", () => {
  it("replays only post-watermark owner messages, skipping parent/bots/subtypes/others", async () => {
    const store = tempStore("cu-filter");
    bind(store, "C9", "9000.000001", "9000.000050");
    const good: SlackMsg = { channel: "C9", user: OWNER, text: "hello", ts: "9000.000051", thread_ts: "9000.000001" };
    const replies = {
      "C9:9000.000001": [
        { channel: "C9", user: OWNER, text: "parent", ts: "9000.000001" }, // parent
        good,
        { channel: "C9", user: "U2", text: "intruder", ts: "9000.000052", thread_ts: "9000.000001" },
        { channel: "C9", user: "U9", bot_id: "B1", text: "bot", ts: "9000.000053", thread_ts: "9000.000001" },
        { channel: "C9", user: OWNER, text: "edited", ts: "9000.000054", thread_ts: "9000.000001", subtype: "message_changed" },
        { channel: "C9", user: OWNER, text: "old", ts: "9000.000049", thread_ts: "9000.000001" }, // pre-watermark
      ] as SlackMsg[],
    };
    const { deps, dispatched } = harness(store, replies);
    const n = await sweepMissedMessages(deps);
    expect(n).toBe(1);
    expect(dispatched).toEqual([good]);
    expect(store.getThread("C9:9000.000001")?.lastSeenTs).toBe("9000.000051");
  });

  it("never sweeps a thread without a watermark (double-run protection for pre-watermark bindings)", async () => {
    const store = tempStore("cu-nowm");
    bind(store, "C9", "9100.000001", undefined);
    const { deps, fetches } = harness(store, { "C9:9100.000001": [{ channel: "C9", user: OWNER, text: "x", ts: "9100.000002" }] });
    const n = await sweepMissedMessages(deps);
    expect(n).toBe(0);
    expect(fetches).toEqual([]);
  });

  it("skips threads idle beyond the 12h window and caps a pass at 10 threads", async () => {
    const mk = (rootTs: string, lastUsedAt: number): ThreadState => ({
      sessionId: "ses_x",
      projectDir: "/p",
      verbose: "on",
      lastSeenTs: "9200.000050",
      createdAt: NOW,
      lastUsedAt,
    });
    const threads: Record<string, ThreadState> = { "C9:9200.000001": mk("9200.000001", NOW - 13 * 60 * 60 * 1000) };
    for (let i = 0; i < 11; i++) threads[`C9:9210.0000${String(i).padStart(2, "0")}`] = mk("x", NOW);
    const store = storeWithThreads("cu-window", threads);
    const { deps, fetches } = harness(store, {});
    await sweepMissedMessages(deps);
    expect(fetches.some((f) => f.startsWith("C9:9200.000001"))).toBe(false); // window excluded it
    expect(fetches.length).toBeLessThanOrEqual(10); // pass cap
  });

  it("a failed replay keeps the watermark and retries on the next pass", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = tempStore("cu-retry");
      bind(store, "C9", "9300.000001", "9300.000050");
      const msg: SlackMsg = { channel: "C9", user: OWNER, text: "again", ts: "9300.000051", thread_ts: "9300.000001" };
      let calls = 0;
      const { deps } = harness(store, { "C9:9300.000001": [msg] }, async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient boom");
        store.markThreadSeen("C9:9300.000001", msg.ts);
      });
      await sweepMissedMessages(deps); // first pass: throws before the watermark moves
      expect(store.getThread("C9:9300.000001")?.lastSeenTs).toBe("9300.000050");
      await sweepMissedMessages(deps); // retry: same message replayed again
      expect(calls).toBe(2);
      expect(store.getThread("C9:9300.000001")?.lastSeenTs).toBe("9300.000051");
    } finally {
      spy.mockRestore();
    }
  });

  it("a fetch failure is tolerated (reported once) and the thread is retried later", async () => {
    const store = tempStore("cu-fetchfail");
    bind(store, "C9", "9400.000001", "9400.000050");
    let fetchCalls = 0;
    const deps: CatchupDeps = {
      state: store,
      ownerSlackUserId: OWNER,
      fetchReplies: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) throw new Error("not_in_channel");
        return [{ channel: "C9", user: OWNER, text: "late", ts: "9400.000051", thread_ts: "9400.000001" }];
      },
      dispatch: async (m) => store.markThreadSeen("C9:9400.000001", m.ts),
    };
    await sweepMissedMessages(deps);
    expect(store.getThread("C9:9400.000001")?.lastSeenTs).toBe("9400.000050");
    await sweepMissedMessages(deps);
    expect(store.getThread("C9:9400.000001")?.lastSeenTs).toBe("9400.000051");
    expect(fetchCalls).toBe(2);
  });

  it("routes a replayed message through the REAL handler (command path proves watermark advance + delivery)", async () => {
    const store = tempStore("cu-real");
    bind(store, "C9", "9500.000001", "9500.000050");
    const posted: string[] = [];
    const render: RenderDeps = {
      post: async (_c, _t, text) => {
        posted.push(text);
        return { ts: "x" };
      },
      update: async () => {},
      delete: async () => {},
      react: async () => {},
      unreact: async () => {},
      upload: async () => {},
    };
    const bridge: BridgeDeps = {
      config: { ownerSlackUserId: OWNER } as SlackocConfig,
      state: store,
      pool: {} as ServerPool, // \help never touches the pool
      render,
      botUserId: "UBOT",
      cwd: "/p",
    };
    const deps: CatchupDeps = {
      state: store,
      ownerSlackUserId: OWNER,
      // channel-less, like the real API — the sweep stamps it back (production bug: unstamped → invalid_arguments)
      fetchReplies: async () => asApiMessages([{ channel: "C9", user: OWNER, text: "\\help", ts: "9500.000051", thread_ts: "9500.000001" }]),
      dispatch: (m) => handleIncomingMessage(m, bridge),
    };
    const n = await sweepMissedMessages(deps);
    expect(n).toBe(1);
    expect(posted.some((p) => p.includes("\\model"))).toBe(true); // the \help listing actually posted
    expect(store.getThread("C9:9500.000001")?.lastSeenTs).toBe("9500.000051");
  });

  it("stamps channel + thread_ts onto channel-less history messages before dispatch", async () => {
    const store = tempStore("cu-stamp");
    bind(store, "C9", "9600.000001", "9600.000050");
    const { deps, dispatched } = harness(store, { "C9:9600.000001": [{ user: OWNER, text: "hi", ts: "9600.000051", thread_ts: "9600.000001" } as SlackMsg] });
    await sweepMissedMessages(deps);
    expect(dispatched[0]?.channel).toBe("C9");
    expect(dispatched[0]?.thread_ts).toBe("9600.000001");
  });

  it("skips a message the socket delivered mid-pass (live watermark advanced after fetch)", async () => {
    const store = tempStore("cu-race");
    bind(store, "C9", "9700.000001", "9700.000000");
    const dispatched: string[] = [];
    const deps: CatchupDeps = {
      state: store,
      ownerSlackUserId: OWNER,
      fetchReplies: async () => asApiMessages([
        { channel: "C9", user: OWNER, text: "first", ts: "9700.000010", thread_ts: "9700.000001" },
        { channel: "C9", user: OWNER, text: "second", ts: "9700.000020", thread_ts: "9700.000001" },
      ]),
      // Simulate the socket delivering "second" while the sweep is between
      // fetch and dispatch — the live watermark jumps past it.
      dispatch: async (m) => {
        if (m.ts === "9700.000010") store.markThreadSeen("C9:9700.000001", "9700.000020");
        dispatched.push(m.ts);
      },
    };
    const n = await sweepMissedMessages(deps);
    expect(dispatched).toEqual(["9700.000010"]); // "second" was already handled live — not double-dispatched
    expect(n).toBe(1);
    expect(store.getThread("C9:9700.000001")?.lastSeenTs).toBe("9700.000020");
  });

  it("sweeps a seeded legacy thread, replaying only post-seed messages", async () => {
    const store = tempStore("cu-legacy");
    bind(store, "C9", "9800.000001", undefined); // pre-watermark binding: no lastSeenTs
    expect(store.seedMissingWatermarks()).toBe(1);
    const wm = store.getThread("C9:9800.000001")?.lastSeenTs;
    expect(wm).toBeDefined();
    // A message from BEFORE the seed (already handled long ago) and one after.
    const sec = Number(wm!.split(".")[0]);
    const { deps, dispatched } = harness(store, {
      "C9:9800.000001": [
        { channel: "C9", user: OWNER, text: "old handled", ts: `${sec - 5}.000500`, thread_ts: "9800.000001" },
        { channel: "C9", user: OWNER, text: "lost while dead", ts: `${sec + 5}.000500`, thread_ts: "9800.000001" },
      ],
    });
    const n = await sweepMissedMessages(deps);
    expect(n).toBe(1);
    expect(dispatched.map((m) => m.text)).toEqual(["lost while dead"]);
    expect(store.getThread("C9:9800.000001")?.lastSeenTs).toBe(`${sec + 5}.000500`);
  });
});
