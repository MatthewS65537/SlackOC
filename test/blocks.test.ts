import { describe, expect, it } from "vitest";
import { appendSectionSuffix, boundedSection, permissionBlocks, permissionFallbackText, permissionResultText, QUESTION_ACTION_PATTERN, questionBlocks, type QuestionActionValue, type QuestionButtonValue } from "../src/slack/blocks.js";
import { normalizePermission, type OcPermission, type OcQuestionRequest } from "../src/opencode/api.js";

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
    expect(actions.elements[0]!.action_id).toBe("question_0_0");
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

  it("shows one question at a time and advances after an answer", () => {
    const req = makeReq({
      questions: [
        { question: "Q one?", header: "First", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
        { question: "Q two?", header: "Second", options: [{ label: "X", description: "" }, { label: "Y", description: "" }, { label: "Z", description: "" }] },
      ],
    });
    const blocks = questionBlocks(req, []);
    // header + q1 section + q1 actions + q2 section + q2 actions + skip = 6
    expect(blocks.length).toBe(4);
    const q1 = (blocks[1] as { text: { text: string } }).text.text;
    const q2 = (questionBlocks(req, [["A"], []])[2] as { text: { text: string } }).text.text;
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

// ─── questionBlocks: multi-select + free-text (D6) ───────────────────────────

type El = { type: string; text?: { text: string }; action_id?: string; value?: string; style?: string };
type Block = { type: string; block_id?: string; elements?: El[] };
const rows = (blocks: unknown[]) => blocks.filter((b) => (b as Block).type === "actions") as Block[];

/** Reject the actual incident fixture instead of accepting any JSON-shaped blocks. */
function assertSlackContract(blocks: unknown[]): void {
  expect(blocks.length).toBeLessThanOrEqual(50);
  for (const raw of blocks) {
    const b = raw as Block & { text?: { text: string } };
    if (b.block_id) expect(b.block_id.length).toBeLessThanOrEqual(255);
    if (b.type === "section") {
      expect(b.text!.text.length).toBeGreaterThan(0);
      expect(b.text!.text.length).toBeLessThanOrEqual(3000);
    }
    if (b.type !== "actions") continue;
    const ids = b.elements!.map(e => e.action_id);
    if (new Set(ids).size !== ids.length) throw new Error("invalid_blocks: duplicate action_id");
    for (const e of b.elements!) {
      expect(e.action_id!.length).toBeLessThanOrEqual(255);
      expect(e.value!.length).toBeLessThanOrEqual(2000);
      expect(e.text!.text.length).toBeGreaterThan(0);
      expect(e.text!.text.length).toBeLessThanOrEqual(75);
    }
  }
}

const permission = (overrides: Partial<OcPermission> = {}): OcPermission => ({
  id: "per_test", sessionID: "ses_test", type: "bash", title: "Run npm test", metadata: { command: "npm test" }, ...overrides,
});

describe("permission and question Slack contract", () => {
  it("rejects the incident fixture and accepts all three unique permission decisions", () => {
    const blocks = permissionBlocks(permission(), 7);
    assertSlackContract(blocks);
    const buttons = rows(blocks)[0]!.elements!;
    expect(buttons.map(b => b.action_id)).toEqual(["perm_once", "perm_always", "perm_reject"]);
    expect(buttons.map(b => JSON.parse(b.value!))).toEqual(["once", "always", "reject"].map(r => ({ s: "ses_test", p: "per_test", r, g: 7 })));
    const broken = structuredClone(blocks);
    rows(broken)[0]!.elements!.forEach(b => { b.action_id = "perm"; });
    expect(() => assertSlackContract(broken)).toThrow("invalid_blocks: duplicate action_id");
  });

  it("bounds escaped payloads and the appended DM link while retaining exact backup commands", () => {
    const p = permission({ title: "<&>".repeat(5000), type: "&".repeat(3000), metadata: { filePath: "/".repeat(8000) }, id: "p".repeat(255), sessionID: "s".repeat(255) });
    const blocks = permissionBlocks(p);
    const suffix = "\n<https://example.com/thread|View thread>";
    const dm = appendSectionSuffix(blocks, suffix);
    assertSlackContract(dm);
    expect((dm[0] as { text: { text: string } }).text.text.endsWith(suffix)).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain("View thread"); // original thread copy unmodified
    const fallback = permissionFallbackText(p, "https://example.com/thread");
    expect(fallback.length).toBeLessThanOrEqual(3000);
    for (const verb of ["once", "deny", "always"]) expect(fallback).toContain(`\\permission ${p.id} ${verb}`);
    expect(fallback).toContain("\\permissions");
  });

  it("keeps fallback summaries readable and never claims a denied task resumed", () => {
    const text = permissionFallbackText(permission());
    expect(text).toContain("Run npm test");
    expect(text).toContain("npm test");
    expect(text).toContain("\\permission per_test deny");
    expect(permissionResultText("reject", "OWNER")).toContain("Denied");
    expect(permissionResultText("reject", "OWNER")).not.toMatch(/continuing|resumed|Approved/);
  });

  it("fails card construction rather than truncating executable identities", () => {
    expect(() => permissionBlocks(permission({ id: "bad id" }))).toThrow("identity");
    expect(() => permissionBlocks(permission({ sessionID: "s".repeat(2000) }))).toThrow("identity");
    expect(permissionFallbackText(permission({ id: "bad id" }))).not.toContain("\\permission bad id");
    expect(() => questionBlocks(makeReq({ sessionID: "s".repeat(2000) }), [])).toThrow("2000");
  });

  it("validates question options, skip, multi-select rerenders, long labels and finalized answers", () => {
    const req = makeReq({ questions: [{ header: "&".repeat(4000), question: "x".repeat(4000), multiple: true,
      options: Array.from({ length: 9 }, (_, i) => ({ label: `${i} ${"x".repeat(100)}`, description: "<".repeat(4000) })) }] });
    for (const [answers, done] of [[[], [false]], [[req.questions[0]!.options[0]!.label], [false]], [["z".repeat(5000)], [true]]] as [string[], boolean[]][]) {
      const blocks = questionBlocks(req, [answers], done);
      assertSlackContract(blocks);
      for (const row of rows(blocks)) for (const e of row.elements!) {
        if (["qsubmit", "qretry", "qedit"].includes(e.action_id!)) continue;
        expect(QUESTION_ACTION_PATTERN.test(e.action_id!)).toBe(true);
        const v = JSON.parse(e.value!) as QuestionButtonValue;
        expect(e.action_id).toBe(v.a === -1 ? "question_skip" : `question_${v.i}_${v.a}`);
      }
    }
    expect(QUESTION_ACTION_PATTERN.test("question_bad" )).toBe(false);
    expect(QUESTION_ACTION_PATTERN.test("question_0_1_extra")).toBe(false);
    expect(QUESTION_ACTION_PATTERN.test("question")).toBe(true);
  });

  it("bounds large forms by showing one question and truncates without split entities/Unicode", () => {
    assertSlackContract(questionBlocks(makeReq({ questions: Array.from({ length: 50 }, () => makeReq().questions[0]!) }), []));
    expect(boundedSection("abc&amp;rest", 7)).toBe("abc…");
    expect(boundedSection("abc😀rest", 5)).toBe("abc…");
  });
});

describe("questionBlocks generation and submission state", () => {
  const pagedReq = () => {
    const options = Array.from({ length: 45 }, (_, i) => ({ label: `Choice ${i + 1}`, value: `choice-${i}`, description: "" }));
    return makeReq({ questions: [
      { question: "Already saved?", header: "Saved", options: [{ label: "Yes", description: "" }] },
      { question: "Choose <&> toppings?", header: "Toppings", multiple: true, custom: true, options,
        field: { key: "toppings", type: "multiselect", options, default: ["choice-21"] } },
    ] });
  };

  it.each([0, 7, Number.MAX_SAFE_INTEGER])("puts generation %s on every question action type", (generation) => {
    const req = pagedReq();
    const answers = [["Yes"], ["choice-21"]];
    const open = questionBlocks(req, answers, [true, false], 1, { generation, response: "pending" });
    assertSlackContract(open);
    const buttons = rows(open).flatMap(row => row.elements!);
    expect(buttons.map(button => button.action_id)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `question_1_${i + 20}`),
      "qsubmit", "qpage_prev", "qpage_next", "qtext", "qomit", "question_skip",
    ]);
    for (const button of buttons) {
      const value = JSON.parse(button.value!) as QuestionActionValue;
      expect(value).toMatchObject({ s: "sess-1", q: "q-1", g: generation, i: button.action_id === "question_skip" ? 0 : 1 });
    }
    expect(JSON.parse(buttons.find(button => button.action_id === "question_1_21")!.value!)).toEqual({ s: "sess-1", q: "q-1", i: 1, a: 21, g: generation });
    expect(buttons.find(button => button.action_id === "question_1_21")!.style).toBe("primary");
    for (const [action, page] of [["qpage_prev", 0], ["qpage_next", 2]] as const) {
      expect(JSON.parse(buttons.find(button => button.action_id === action)!.value!)).toEqual({ s: "sess-1", q: "q-1", i: 1, page, g: generation });
    }
    expect(JSON.parse(buttons.find(button => button.action_id === "question_skip")!.value!)).toEqual({ s: "sess-1", q: "q-1", i: 0, a: -1, g: generation });
    expect(JSON.stringify(open)).toContain("Choose &lt;&amp;&gt; toppings?");

    const ready = questionBlocks(req, answers, [true, true], 1, { generation, response: "pending" });
    assertSlackContract(ready);
    const readyButtons = rows(ready).flatMap(row => row.elements!);
    expect(readyButtons.map(button => button.action_id)).toEqual(["qretry", "qedit"]);
    expect(readyButtons.map(button => JSON.parse(button.value!))).toEqual([
      { s: "sess-1", q: "q-1", i: 0, g: generation },
      { s: "sess-1", q: "q-1", i: 0, g: generation },
    ]);
  });

  it("preserves legacy payloads and the pending wizard when generation is omitted", () => {
    const req = pagedReq();
    for (const finalized of [[true, false], [true, true]]) {
      const legacy = questionBlocks(req, [["Yes"], ["choice-21"]], finalized, 1);
      expect(questionBlocks(req, [["Yes"], ["choice-21"]], finalized, 1, {})).toEqual(legacy);
      expect(questionBlocks(req, [["Yes"], ["choice-21"]], finalized, 1, { response: "pending" })).toEqual(legacy);
      for (const button of rows(legacy).flatMap(row => row.elements!)) expect(JSON.parse(button.value!)).not.toHaveProperty("g");
    }
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid generation %s before rendering any response state", (generation) => {
    for (const response of ["pending", "answering", "uncertain", "resolved"] as const) {
      expect(() => questionBlocks(makeReq(), [], undefined, 0, { generation, response })).toThrow("Invalid question generation");
    }
  });

  it("carries the presentation identity on every active question control", () => {
    const req = makeReq({ questions: [{ ...makeReq().questions[0]!, multiple: true, custom: true,
      options: Array.from({ length: 21 }, (_, i) => ({ label: `Choice ${i}`, description: "" })) }] });
    const blocks = questionBlocks(req, [], [false], 0, { generation: 7, binding: "binding", presentation: 3 });
    assertSlackContract(blocks);
    const controls = rows(blocks).flatMap(row => row.elements ?? []);
    expect(controls.map(button => button.action_id)).toEqual(expect.arrayContaining(["qsubmit", "qtext", "qpage_next", "question_skip"]));
    for (const button of controls) expect(JSON.parse(button.value!)).toMatchObject({ g: 7, b: "binding", c: 3 });
    for (const presentation of [-1, 0.5, Infinity]) {
      expect(() => questionBlocks(req, [], [false], 0, { presentation })).toThrow("Invalid question presentation");
    }
  });

  it.each([false, true])("shows sending without decisions when finalized is %s", (finalized) => {
    const blocks = questionBlocks(pagedReq(), [["Yes"], ["choice-21"]], [true, finalized], 1, { generation: 7, response: "answering" });
    assertSlackContract(blocks);
    expect(rows(blocks)).toEqual([]);
    const text = JSON.stringify(blocks);
    expect(text).toContain("Sending your response");
    expect(text).toContain("Waiting for confirmation");
    expect(text).not.toMatch(/continuing|resumed|Answer confirmed|Answers ready/);
  });

  it.each([false, true])("offers only reconciliation for an unconfirmed submission when finalized is %s", (finalized) => {
    const blocks = questionBlocks(pagedReq(), [["Yes"], ["choice-21"]], [true, finalized], 1, { generation: 7, response: "uncertain" });
    assertSlackContract(blocks);
    const buttons = rows(blocks).flatMap(row => row.elements!);
    expect(buttons.map(button => button.action_id)).toEqual(["qretry"]);
    expect(buttons[0]!.text!.text).toContain("Check submission");
    expect(JSON.parse(buttons[0]!.value!) as QuestionActionValue).toEqual({ s: "sess-1", q: "q-1", i: 0, g: 7 });
    const text = JSON.stringify(blocks);
    expect(text).toContain("Submission unconfirmed");
    expect(text).toContain("may already have been received");
    expect(text).not.toMatch(/continuing|resumed|Answer confirmed|Answers ready/);
  });

  it("does not invent an answer or continuation for a resolved form", () => {
    const blocks = questionBlocks(makeReq(), [], undefined, 0, { response: "resolved" });
    assertSlackContract(blocks);
    expect(rows(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).toContain("no longer pending");
    expect(JSON.stringify(blocks)).not.toMatch(/continuing|resumed|Answer confirmed/);
  });

  it("keeps hidden fields and caller-finalized conditional fields out of the wizard", () => {
    const req = makeReq({ questions: [
      { question: "Hidden", header: "Hidden", options: [], custom: true, field: { key: "hidden", type: "string", hidden: true } },
      { question: "Conditional", header: "Conditional", options: [], custom: true,
        field: { key: "conditional", type: "string", when: [{ key: "choice", op: "eq", value: "yes" }] } },
      { question: "Required number", header: "Count", options: [], custom: true, field: { key: "count", type: "integer", required: true } },
    ] });
    const blocks = questionBlocks(req, [], [false, true, false], 0, { generation: 7, response: "pending" });
    assertSlackContract(blocks);
    const buttons = rows(blocks).flatMap(row => row.elements!);
    expect(buttons.map(button => button.action_id)).toEqual(["qtext", "question_skip"]);
    expect(JSON.parse(buttons[0]!.value!)).toEqual({ s: "sess-1", q: "q-1", i: 2, g: 7 });
    expect(JSON.stringify(blocks)).toContain("Required number");
    expect(JSON.stringify(blocks)).not.toMatch(/Hidden|Conditional|qomit/);
  });
});

describe("questionBlocks multi-select", () => {
  const multiReq = () =>
    makeReq({ questions: [{ question: "Pick toppings?", header: "Toppings", multiple: true, options: [{ label: "Pepperoni", description: "" }, { label: "Mushroom", description: "" }, { label: "Olives", description: "" }] }] });

  it("renders option buttons plus a 'Submit selection' row (qsubmit)", () => {
    const blocks = questionBlocks(multiReq(), []);
    const actionRows = rows(blocks);
    // 3 options in one row + a submit row + skip row = 3 action rows
    expect(actionRows.length).toBe(3);
    const submit = actionRows.find((r) => r.block_id === "ques_submit_q-1_0");
    expect(submit).toBeDefined();
    expect(submit!.elements![0]!.text!.text).toBe("Submit selection");
    expect(submit!.elements![0]!.action_id).toBe("qsubmit");
    const sv = JSON.parse(submit!.elements![0]!.value!) as { s: string; q: string; i: number };
    expect(sv).toEqual({ s: "sess-1", q: "q-1", i: 0 });
    // Each option has a unique routable action ID within its row.
    const optRow = actionRows.find((r) => r.block_id === "ques_q-1_0_0");
    expect(optRow!.elements!.map((e) => e.action_id)).toEqual(["question_0_0", "question_0_1", "question_0_2"]);
  });

  it("highlights toggled options (primary) but stays open until finalized", () => {
    const blocks = questionBlocks(multiReq(), [["Pepperoni", "Olives"]], [false]);
    const optRow = rows(blocks).find((r) => r.block_id === "ques_q-1_0_0")!;
    const byLabel = (l: string) => optRow.elements!.find((e) => e.text!.text === l)!;
    expect(byLabel("Pepperoni").style).toBe("primary");
    expect(byLabel("Olives").style).toBe("primary");
    expect(byLabel("Mushroom").style).toBeUndefined();
    // Not finalized → still shows the submit row and the skip row.
    expect(rows(blocks).some((r) => r.block_id === "ques_submit_q-1_0")).toBe(true);
    expect(rows(blocks).some((r) => r.block_id === "ques_skip_q-1")).toBe(true);
  });

  it("collapses to a ✅ line once finalized (even with a partial selection)", () => {
    const blocks = questionBlocks(multiReq(), [["Pepperoni"]], [true]);
    expect(blocks.length).toBe(3); // header + answer summary + retry/edit controls
    const done = (blocks[1] as { text: { text: string } }).text.text;
    expect(done).toContain("✅");
    expect(done).toContain("Pepperoni");
  });
});

describe("questionBlocks free-text", () => {
  const customReq = () =>
    makeReq({ questions: [{ question: "Any notes for the reviewer?", header: "Notes", custom: true, options: [] }] });

  it("renders a 'Type your own answer' button (qtext) with no option buttons", () => {
    const blocks = questionBlocks(customReq(), []);
    const actionRows = rows(blocks);
    // qtext row + skip row = 2 (no option buttons — options is empty)
    expect(actionRows.length).toBe(2);
    const textRow = actionRows.find((r) => r.block_id === "ques_text_q-1_0");
    expect(textRow).toBeDefined();
    expect(textRow!.elements![0]!.text!.text).toBe("Type your own answer");
    expect(textRow!.elements![0]!.action_id).toBe("qtext");
    const tv = JSON.parse(textRow!.elements![0]!.value!) as { s: string; q: string; i: number };
    expect(tv).toEqual({ s: "sess-1", q: "q-1", i: 0 });
  });

  it("collapses once finalized with the typed answer", () => {
    const blocks = questionBlocks(customReq(), [["ship it"]], [true]);
    const done = (blocks[1] as { text: { text: string } }).text.text;
    expect(done).toContain("✅");
    expect(done).toContain("ship it");
  });
});
