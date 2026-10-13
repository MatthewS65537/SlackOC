import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerRetryActions, retryAfterModelPick } from "../src/slack/retry.js";
import { retryPrompt } from "../src/slack/router.js";
import { getView } from "../src/slack/render.js";
import { _resetQueueForTests } from "../src/slack/queue.js";

vi.mock("../src/slack/router.js", () => ({ retryPrompt: vi.fn(async () => "accepted") }));
vi.mock("../src/slack/render.js", () => ({ getView: vi.fn(() => undefined) }));

const OWNER = "U_OWNER";
const ROOT = "1791400000.000100";
const CARD = "1791400050.000200";

function harness(thread: Record<string, unknown> = {}) {
  _resetQueueForTests();
  const handlers: Record<string, any> = {};
  const updates: any[] = [];
  const posts: any[] = [];
  const app: any = {
    action: (id: string, cb: any) => { handlers[id] = cb; },
    client: { chat: { update: async (args: any) => { updates.push(args); return {}; } } },
  };
  const threads: Record<string, any> = { [`C1:${ROOT}`]: { sessionId: "ses_1", projectDir: "/p", lastPrompt: { text: "fix it", ts: "P1", sessionId: "ses_1" }, ...thread } };
  const bridge: any = {
    config: { ownerSlackUserId: OWNER },
    state: { threadKey: (c: string, t: string) => `${c}:${t}`, getThread: (key: string) => threads[key] ?? null },
    render: { post: async (_c: string, _t: string, text: string, blocks: unknown[]) => { posts.push({ text, blocks }); return { ts: "MODEL_CARD" }; } },
  };
  registerRetryActions(app, { bridge, ownerSlackUserId: OWNER, isStopping: () => false });
  /** A block_actions tap on the failed run's card (a threaded bot reply). */
  const click = async (actionId: string, value = "P1", actor = OWNER) => {
    const respond = vi.fn(async (_r: any) => {});
    const body = { type: "block_actions", user: { id: actor }, container: { type: "message", message_ts: CARD, channel_id: "C1" },
      message: { type: "message", ts: CARD, thread_ts: ROOT, text: ":x: upstream closed the socket" } };
    await handlers[actionId]({ ack: async () => {}, body, action: { action_id: actionId, value }, respond });
    return respond;
  };
  return { bridge, threads, updates, posts, click };
}
const said = (respond: ReturnType<typeof vi.fn>) => respond.mock.calls.map(([r]) => (r as { text: string }).text);

beforeEach(() => {
  vi.mocked(retryPrompt).mockReset().mockResolvedValue("accepted");
  vi.mocked(getView).mockReset().mockReturnValue(undefined);
});

describe("↻ Retry (D3)", () => {
  it("resends the stored text through the router, the card standing in for the message, and drops its buttons", async () => {
    const h = harness();
    expect(said(await h.click("run_retry"))).toEqual([]);
    expect(retryPrompt).toHaveBeenCalledWith(h.bridge, "C1", ROOT, CARD, "fix it");
    expect(h.updates).toEqual([expect.objectContaining({ ts: CARD, text: ":x: upstream closed the socket · ↻ retried", blocks: [] })]);
  });

  it.each(["run_retry", "pick_model_retry"])("%s is owner-only", async (action) => {
    const h = harness();
    expect(said(await h.click(action, "P1", "U_OTHER"))).toEqual(["Only the paired owner can use these controls."]);
    expect(retryPrompt).not.toHaveBeenCalled();
    expect([...h.updates, ...h.posts]).toEqual([]);
  });

  it.each(["run_retry", "pick_model_retry"])("%s refuses while the thread has a run in flight", async (action) => {
    const h = harness();
    vi.mocked(getView).mockReturnValue({ isActive: true } as never);
    expect(said(await h.click(action))).toEqual(["A run is in progress. Wait for it, or `\\stop` it first."]);
    expect(retryPrompt).not.toHaveBeenCalled();
    expect([...h.updates, ...h.posts]).toEqual([]);
  });

  it("an old card can't resend a newer prompt", async () => {
    const h = harness({ lastPrompt: { text: "newer", ts: "P2", sessionId: "ses_1" } });
    expect(said(await h.click("run_retry", "P1"))).toEqual(["A newer prompt ran or the thread moved to another session since, so there's nothing to retry here."]);
    expect(retryPrompt).not.toHaveBeenCalled();
  });

  it("a card can't resend after the thread moved to another session (\\resume keeps lastPrompt; \\new/\\cd clear it)", async () => {
    for (const thread of [{ sessionId: "ses_2" }, { sessionId: "ses_2", lastPrompt: undefined }]) {
      const h = harness(thread);
      expect(said(await h.click("run_retry"))).toEqual(["A newer prompt ran or the thread moved to another session since, so there's nothing to retry here."]);
    }
    expect(retryPrompt).not.toHaveBeenCalled();
  });

  it("tells the owner when recovery policy held the resend, and leaves the card's buttons", async () => {
    const h = harness();
    vi.mocked(retryPrompt).mockResolvedValue("held");
    expect(said(await h.click("run_retry"))).toEqual(["Couldn't retry (held). Send the prompt again instead."]);
    expect(h.updates).toEqual([]); // the card keeps its buttons for another try
  });
});

describe("Switch model… (D3)", () => {
  it("posts the \\model search card tagged with the failed prompt; nothing runs yet", async () => {
    const h = harness();
    await h.click("pick_model_retry");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].blocks[0]).toMatchObject({ block_id: "model_retry:P1", accessory: { type: "external_select", action_id: "pick_model" } });
    expect(retryPrompt).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]); // the failure card keeps its buttons until something actually reruns
  });

  it("a pick reruns the prompt only once the thread really uses the picked model", async () => {
    const h = harness();
    expect(await retryAfterModelPick(h.bridge, "C1", ROOT, "MODEL_CARD", "P1", "\\model anthropic/sonnet")).toBe("The model didn't change, so the prompt wasn't retried.");
    expect(retryPrompt).not.toHaveBeenCalled();
    h.threads[`C1:${ROOT}`].model = "anthropic/sonnet";
    expect(await retryAfterModelPick(h.bridge, "C1", ROOT, "MODEL_CARD", "P1", "\\model anthropic/sonnet")).toBeNull();
    expect(retryPrompt).toHaveBeenCalledWith(h.bridge, "C1", ROOT, "MODEL_CARD", "fix it");
  });
});
