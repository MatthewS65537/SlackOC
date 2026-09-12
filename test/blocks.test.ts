import { describe, expect, it } from "vitest";
import { questionBlocks, type QuestionButtonValue } from "../src/slack/blocks.js";
import { normalizePermission, type OcQuestionRequest } from "../src/opencode/api.js";

// ─── normalizePermission (PA) ────────────────────────────────────────────────

describe("normalizePermission", () => {
  it("maps the new permission.asked shape onto legacy OcPermission", () => {
    const out = normalizePermission({
      id: "perm-1",
      sessionID: "sess-1",
      permission: "bash",
      patterns: ["npm test", "npm run build"],
      metadata: { title: "Run npm test", command: "npm test" },
      always: ["npm test"],
      tool: { messageID: "msg-1", callID: "call-1" },
    });
    expect(out.id).toBe("perm-1");
    expect(out.sessionID).toBe("sess-1");
    expect(out.type).toBe("bash");
    expect(out.pattern).toEqual(["npm test", "npm run build"]);
    expect(out.title).toBe("Run npm test");
    expect(out.messageID).toBe("msg-1");
    expect(out.callID).toBe("call-1");
    expect(out.metadata).toEqual({ title: "Run npm test", command: "npm test" });
  });

  it("falls back to the permission name as title when metadata.title is absent", () => {
    const out = normalizePermission({
      id: "perm-2",
      sessionID: "sess-2",
      permission: "edit",
      patterns: ["src/**"],
      metadata: {},
    });
    expect(out.type).toBe("edit");
    expect(out.title).toBe("edit");
    expect(out.pattern).toEqual(["src/**"]);
    expect(out.messageID).toBeUndefined();
    expect(out.callID).toBeUndefined();
  });

  it("handles missing patterns (non-array) as undefined", () => {
    const out = normalizePermission({
      id: "perm-3",
      sessionID: "sess-3",
      permission: "webfetch",
      metadata: { title: "Fetch URL" },
    });
    expect(out.pattern).toBeUndefined();
  });

  it("passes legacy permission.updated payloads through untouched", () => {
    const legacy = {
      id: "perm-4",
      sessionID: "sess-4",
      messageID: "msg-4",
      callID: "call-4",
      type: "bash",
      pattern: "ls -la",
      title: "Run ls",
      metadata: { command: "ls -la" },
    };
    expect(normalizePermission(legacy)).toBe(legacy);
  });
});

// ─── questionBlocks (#2) ─────────────────────────────────────────────────────

function makeReq(overrides: Partial<OcQuestionRequest> = {}): OcQuestionRequest {
  return {
    id: "q-1",
    sessionID: "sess-1",
    questions: [
      {
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "Component-based" },
          { label: "Vue", description: "Progressive" },
          { label: "Svelte", description: "Compile-time" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("questionBlocks", () => {
  it("renders a single question with numbered options and a skip row", () => {
    const blocks = questionBlocks(makeReq(), []);
    // [header section, question section, actions row, skip row]
    expect(blocks.length).toBe(4);

    const header = blocks[0] as { type: string; text: { type: string; text: string } };
    expect(header.type).toBe("section");
    expect(header.text.text).toContain("OpenCode has a question");

    const qSection = blocks[1] as { type: string; text: { type: string; text: string } };
    expect(qSection.text.text).toContain("Q1/1");
    expect(qSection.text.text).toContain("Framework");
    expect(qSection.text.text).toContain("Which framework?");
    expect(qSection.text.text).toContain("1. React");
    expect(qSection.text.text).toContain("2. Vue");
    expect(qSection.text.text).toContain("3. Svelte");

    const actions = blocks[2] as { type: string; elements: Array<{ type: string; text: { type: string; text: string }; action_id: string; value: string }> };
    expect(actions.type).toBe("actions");
    expect(actions.elements.length).toBe(3);
    expect(actions.elements[0]!.text.text).toBe("React");
    expect(actions.elements[0]!.action_id).toBe("question");
    const v0 = JSON.parse(actions.elements[0]!.value) as QuestionButtonValue;
    expect(v0.s).toBe("sess-1");
    expect(v0.q).toBe("q-1");
    expect(v0.i).toBe(0);
    expect(v0.a).toBe(0);

    // Skip row
    const skip = blocks[3] as { type: string; elements: Array<{ text: { text: string }; value: string }> };
    expect(skip.type).toBe("actions");
    expect(skip.elements[0]!.text.text).toBe("Skip (reject)");
    const skipVal = JSON.parse(skip.elements[0]!.value) as QuestionButtonValue;
    expect(skipVal.a).toBe(-1);
  });

  it("renders multi-question with per-question sections", () => {
    const req = makeReq({
      questions: [
        { question: "Q one?", header: "First", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
        { question: "Q two?", header: "Second", options: [{ label: "X", description: "" }, { label: "Y", description: "" }, { label: "Z", description: "" }] },
      ],
    });
    const blocks = questionBlocks(req, []);
    // header + q1 section + q1 actions + q2 section + q2 actions + skip = 6
    expect(blocks.length).toBe(6);
    const q1 = (blocks[1] as { text: { text: string } }).text.text;
    const q2 = (blocks[3] as { text: { text: string } }).text.text;
    expect(q1).toContain("Q1/2");
    expect(q2).toContain("Q2/2");
  });

  it("collapses answered questions to a ✅ line and hides their buttons", () => {
    const req = makeReq({
      questions: [
        { question: "Q one?", header: "First", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
        { question: "Q two?", header: "Second", options: [{ label: "X", description: "" }, { label: "Y", description: "" }] },
      ],
    });
    const blocks = questionBlocks(req, [["A"], []]);
    // header + q1 ✅ + q2 section + q2 actions + skip = 5
    expect(blocks.length).toBe(5);
    const q1 = (blocks[1] as { text: { text: string } }).text.text;
    expect(q1).toContain("✅");
    expect(q1).toContain("A");
    // No buttons for Q1
    const q1Actions = blocks.find(
      (b) => (b as { block_id?: string }).block_id?.startsWith("ques_q-1_0"),
    );
    expect(q1Actions).toBeUndefined();
  });

  it("hides the skip row when all questions are answered", () => {
    const req = makeReq({
      questions: [
        { question: "Q one?", header: "First", options: [{ label: "A", description: "" }] },
        { question: "Q two?", header: "Second", options: [{ label: "X", description: "" }] },
      ],
    });
    const blocks = questionBlocks(req, [["A"], ["X"]]);
    // header + q1 ✅ + q2 ✅ = 3 (no skip, no buttons)
    expect(blocks.length).toBe(3);
    const hasSkip = blocks.some((b) => (b as { block_id?: string }).block_id === "ques_skip_q-1");
    expect(hasSkip).toBe(false);
  });

  it("chunks >5 options into multiple action rows (Slack's 5-button cap)", () => {
    const opts = Array.from({ length: 7 }, (_, i) => ({ label: `Opt ${i + 1}`, description: "" }));
    const req = makeReq({ questions: [{ question: "Pick?", header: "Pick", options: opts }] });
    const blocks = questionBlocks(req, []);
    // header + section + 2 action rows (5+2) + skip = 5
    expect(blocks.length).toBe(5);
    const row1 = blocks[2] as { elements: unknown[] };
    const row2 = blocks[3] as { elements: unknown[] };
    expect(row1.elements.length).toBe(5);
    expect(row2.elements.length).toBe(2);
  });

  it("option descriptions appear inline after an em-dash", () => {
    const blocks = questionBlocks(makeReq(), []);
    const qSection = (blocks[1] as { text: { text: string } }).text.text;
    expect(qSection).toContain("React — Component-based");
    expect(qSection).toContain("Vue — Progressive");
  });
});
