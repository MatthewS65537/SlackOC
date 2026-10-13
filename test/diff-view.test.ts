import { describe, expect, it, vi } from "vitest";
import { DIFF_DOWNLOAD_ACTION, DIFF_DOWNLOAD_MAX_BYTES, diffModal, patchSections, registerDiffActions } from "../src/slack/diff-view.js";
import { VIEW_DIFF_ACTION } from "../src/slack/blocks.js";
import { sessionDiff } from "../src/opencode/client.js";
import { _resetQueueForTests } from "../src/slack/queue.js";

vi.mock("../src/opencode/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/opencode/client.js")>(), sessionDiff: vi.fn() }));

const file = (name: string, patch: string) => ({ file: `/p/${name}`, additions: 1, deletions: 0, patch });
const meta = { s: "ses_1", c: "C1", t: "T1" };

describe("diff browser (D1)", () => {
  it("splits a patch into sections under Slack's section limit", () => {
    const patch = Array.from({ length: 400 }, (_, i) => `+line ${i} ${"x".repeat(40)}`).join("\n");
    const { sections, truncated } = patchSections(patch);
    expect(truncated).toBe(false);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every(s => s.length < 2_900)).toBe(true);
    expect(sections.join("\n")).toBe(patch);
  });

  it("caps a huge file at 40 sections and offers the full download", () => {
    const patch = Array.from({ length: 5_000 }, () => `+${"y".repeat(60)}`).join("\n");
    expect(patchSections(patch)).toMatchObject({ truncated: true });
    const view = diffModal([file("big.ts", patch)], 0, meta) as { blocks: Array<{ type: string; elements?: Array<{ action_id?: string }> }> };
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.blocks.at(-1)?.elements?.[0]?.action_id).toBe("diff_download");
  });

  it("renders the selected file and keeps the dropdown on it", () => {
    const view = diffModal([file("a.ts", "+a"), file("b.ts", "+b")], 1, meta) as { private_metadata: string; blocks: any[] };
    expect(view.blocks[1].elements[0].initial_option.value).toBe("1");
    expect(view.blocks[2].text.text).toContain("b.ts");
    expect(view.blocks[3].text.text).toBe("```+b```");
    expect(JSON.parse(view.private_metadata)).toEqual(meta);
  });
});

describe("diff actions", () => {
  const ROOT = "100.000000";
  function harness(patch: string) {
    _resetQueueForTests();
    vi.mocked(sessionDiff).mockResolvedValue([{ file: "/p/big.ts", additions: 1, deletions: 0, patch } as never]);
    const handlers = new Map<string, any>();
    const client = {
      views: { open: vi.fn(async () => ({ view: { id: "V1" } })), update: vi.fn(async (_a: any) => ({})) },
      filesUploadV2: vi.fn(async (_a: any) => ({})),
      chat: { postEphemeral: vi.fn(async (_a: any) => ({})) },
    };
    const app: any = { action: (id: string, cb: any) => handlers.set(id, cb), view: () => {}, client };
    registerDiffActions(app, { ownerSlackUserId: "U_OWNER", isStopping: () => false,
      state: { findThreadBySession: () => ({ key: `C_TEST:${ROOT}`, thread: { projectDir: "/p" } }) } as never,
      pool: { ensure: async () => ({ client: {} }) } as never });
    const user = { id: "U_OWNER", username: "owner", name: "owner", team_id: "T1" };
    /** Real "View changes" click on a bot reply in a thread: the container carries no thread_ts. */
    const view = (message: Record<string, unknown>, channel = "C_TEST") => handlers.get(VIEW_DIFF_ACTION)({ ack: async () => {}, respond: vi.fn(),
      action: { type: "button", action_id: VIEW_DIFF_ACTION, block_id: "vdiff_ses_1", value: "ses_1", action_ts: "102.000001" },
      body: { type: "block_actions", user, api_app_id: "A1", token: "tok", trigger_id: "1.2.abc", team: { id: "T1", domain: "team" },
        container: { type: "message", message_ts: message.ts, channel_id: channel, is_ephemeral: false },
        channel: { id: channel, name: "dev" }, message: { type: "message", user: "U_BOT", text: "Diff", ...message } } });
    const download = () => {
      const metadata = client.views.update.mock.calls.at(-1)![0].view.private_metadata;
      return handlers.get(DIFF_DOWNLOAD_ACTION)({ ack: async () => {},
        action: { type: "button", action_id: DIFF_DOWNLOAD_ACTION, value: "0", action_ts: "103.000001" },
        body: { type: "block_actions", user, api_app_id: "A1", token: "tok", trigger_id: "1.2.def", team: { id: "T1", domain: "team" },
          container: { type: "view", view_id: "V1" }, view: { id: "V1", type: "modal", private_metadata: metadata } } });
    };
    return { client, view, download };
  }
  // > 40 sections and > 200,000 characters, with multi-byte text and a known final hunk.
  const bigPatch = Array.from({ length: 4_000 }, (_, i) => `+行 ${i} ${"é".repeat(60)}`).join("\n") + "\n@@ -9,1 +9,1 @@\n+FINAL LINE ✓";

  it("uploads the complete patch, byte for byte, into the source thread root", async () => {
    const h = harness(bigPatch);
    expect(bigPatch.length).toBeGreaterThan(200_000);
    await h.view({ ts: "101.000000", thread_ts: ROOT });
    expect(JSON.parse(h.client.views.update.mock.calls[0]![0].view.private_metadata)).toEqual({ s: "ses_1", c: "C_TEST", t: ROOT });
    await h.download();
    const upload = h.client.filesUploadV2.mock.calls[0]![0];
    expect(upload).toMatchObject({ channel_id: "C_TEST", thread_ts: ROOT });
    expect(Buffer.from(upload.content, "utf8").equals(Buffer.from(bigPatch, "utf8"))).toBe(true);
    expect(upload.content.endsWith("+FINAL LINE ✓")).toBe(true);
  });

  it.each([["top-level", "C_TEST"], ["DM", "D_OWNER"]])("uses a %s message's own timestamp", async (_label, channel) => {
    const h = harness(bigPatch);
    await h.view({ ts: "101.000000" }, channel);
    await h.download();
    expect(h.client.filesUploadV2.mock.calls[0]![0]).toMatchObject({ channel_id: channel, thread_ts: "101.000000" });
  });

  it("refuses explicitly above the byte limit, measured in bytes, and uploads nothing", async () => {
    const huge = "é".repeat(DIFF_DOWNLOAD_MAX_BYTES / 2 + 1); // under the limit in characters, over it in bytes
    const h = harness(huge);
    await h.view({ ts: "101.000000", thread_ts: ROOT });
    await h.download();
    expect(h.client.filesUploadV2).not.toHaveBeenCalled();
    expect(h.client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ channel: "C_TEST", user: "U_OWNER", thread_ts: ROOT,
      text: expect.stringMatching(/over the 10 MB download limit — nothing was uploaded/) }));
  });
});
