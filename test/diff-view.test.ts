import { describe, expect, it } from "vitest";
import { diffModal, patchSections } from "../src/slack/diff-view.js";

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
