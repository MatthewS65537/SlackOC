import { describe, expect, it } from "vitest";
import { shortcutModal, shortcutPrompt } from "../src/slack/shortcut.js";

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
