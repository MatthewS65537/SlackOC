import { describe, expect, it, vi } from "vitest";
import { registerRunControls } from "../src/slack/run-controls.js";
import { INBOX_STEER_ACTION, REVERT_CLEAR_ACTION, REVERT_KEEP_ACTION } from "../src/slack/blocks.js";
import { _resetQueueForTests } from "../src/slack/queue.js";

const OWNER = "U_OWNER";

function harness(staged: string | undefined) {
  _resetQueueForTests();
  const handlers: Array<{ id: RegExp | string; cb: any }> = [];
  const updates: any[] = [];
  const app: any = {
    action: (id: RegExp | string, cb: any) => handlers.push({ id, cb }),
    client: { chat: { update: async (args: any) => { updates.push(args); return {}; } } },
  };
  const session = {
    get: vi.fn(async () => ({ data: { id: "ses_1", revert: staged ? { messageID: staged } : undefined } })),
    revertCommit: vi.fn(async () => ({})),
    revertClear: vi.fn(async () => ({})),
    inboxUpdate: vi.fn(async () => ({})),
    inboxCancel: vi.fn(async () => ({})),
  };
  const receipts: Record<string, { submission: { sessionId: string; messageId: string } }> = {
    "C1:ROOT|1.1": { submission: { sessionId: "ses_1", messageId: "msg_queued" } },
    "C1:ROOT|1.2": { submission: { sessionId: "ses_old", messageId: "msg_stale" } }, // sent before a rebind
  };
  const state: any = { threadKey: (c: string, t: string) => `${c}:${t}`,
    getThread: (key: string) => key === "C1:ROOT" ? { sessionId: "ses_1", projectDir: "/p" } : null,
    getReceipt: (key: string, ts: string) => receipts[`${key}|${ts}`] };
  registerRunControls(app, { ownerSlackUserId: OWNER, state, pool: { ensure: async () => ({ client: { session } }) } as never, isStopping: () => false });
  const click = async (actionId: string, value: unknown, user = OWNER) => {
    const respond = vi.fn(async () => {});
    const action = { action_id: actionId, value: JSON.stringify(value) };
    const body = { user: { id: user }, container: { channel_id: "C1", message_ts: "CARD" }, message: { ts: "CARD", thread_ts: "ROOT" } };
    const h = handlers.find(h => typeof h.id === "string" ? h.id === actionId : h.id.test(actionId))!;
    await h.cb({ ack: async () => {}, body, action, respond });
    return respond;
  };
  return { session, updates, click };
}

describe("\\undo card", () => {
  it.each([
    [REVERT_KEEP_ACTION, "revertCommit", "kept"],
    [REVERT_CLEAR_ACTION, "revertClear", "Put back"],
  ] as const)("%s: owner-only, acts only on the still-staged boundary", async (actionId, call, edited) => {
    const h = harness("m2");
    const respond = await h.click(actionId, { s: "ses_1", m: "m2", n: 1 }, "U_OTHER");
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: "ephemeral" }));
    expect(h.session.get).not.toHaveBeenCalled();

    await h.click(actionId, { s: "ses_1", m: "m1", n: 2 }); // an older card: the boundary moved since
    expect(h.session.revertCommit).not.toHaveBeenCalled();
    expect(h.session.revertClear).not.toHaveBeenCalled();
    expect(h.updates.at(-1)).toMatchObject({ ts: "CARD", blocks: [], text: expect.stringContaining("Superseded") });

    await h.click(actionId, { s: "ses_1", m: "m2", n: 1 });
    expect(h.session[call]).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_1" } }));
    expect(h.updates.at(-1)).toMatchObject({ ts: "CARD", blocks: [], text: expect.stringContaining(edited) });
  });
});

describe("queued prompt card", () => {
  it("steer resolves the inbox ID from the receipt; a receipt from another session is refused without a client call", async () => {
    const h = harness(undefined);
    await h.click(INBOX_STEER_ACTION, { c: "C1", t: "ROOT", u: "1.2" });
    expect(h.session.inboxUpdate).not.toHaveBeenCalled();
    expect(h.updates.at(-1)).toMatchObject({ blocks: [], text: expect.stringContaining("No longer queued") });

    await h.click(INBOX_STEER_ACTION, { c: "C1", t: "ROOT", u: "1.1" });
    expect(h.session.inboxUpdate).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_1" }, body: { inboxID: "msg_queued", delivery: "steer" } }));
    expect(h.updates.at(-1)).toMatchObject({ ts: "CARD", blocks: [], text: expect.stringContaining("Steered") });
  });
});
