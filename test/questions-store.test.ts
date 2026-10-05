import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { QuestionsStore, questionBindingToken, type QuestionSnapshot } from "../src/slack/questions-store.js";
let dir: string;
beforeEach(() => {
  const root = resolve("test/.fixtures/question-store");
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, "store-"));
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));
it("retains answers and changes interrupted HTTP/delivery attempts into uncertainty on restart", () => {
  const path = join(dir, "questions.json");
  const record: QuestionSnapshot = { id: "f", sessionId: "s", projectDir: "/p", generation: 2, channel: "C", threadTs: "1",
    req: { id: "f", sessionID: "s", questions: [] }, answers: [["value"]], finalized: [true], askTs: "2", dmTs: null,
    response: "answering", threadDelivery: { status: "delivered", attempts: 1 }, dmDelivery: { status: "in-flight", attempts: 1 }, updatedAt: Date.now() };
  new QuestionsStore(path).put(record);
  const loaded = new QuestionsStore(path).get("f")!;
  expect(loaded).toMatchObject({ generation: 2, response: "uncertain", answers: [["value"]], askTs: "2", dmDelivery: { status: "uncertain" } });
  loaded.answers[0]!.push("mutated");
  expect(new QuestionsStore(path).get("f")!.answers).toEqual([["value"]]);
});
const snapshot = (): QuestionSnapshot => ({ id: "f", sessionId: "s", projectDir: "/p", generation: 2, channel: "C", threadTs: "1",
  req: { id: "f", sessionID: "s", questions: [] }, answers: [], finalized: [], askTs: "2", dmTs: "3", response: "pending", updatedAt: Date.now() });
it("loads legacy snapshots dirty and retains restart-safe terminal UI state", () => {
  const path = join(dir, "questions.json");
  writeFileSync(path, JSON.stringify({ version: 1, records: [snapshot()] }));
  const store = new QuestionsStore(path);
  expect(store.get("f")?.ui).toEqual({ revision: 1, threadApplied: 0, dmApplied: 0 });
  expect(store.get("f")).toMatchObject({ presentation: 0, threadPresentation: 0, dmPresentation: 0 });
  store.update("f", r => { r.response = "resolved"; r.resolvedText = "Answer confirmed."; r.ui = { revision: 3, threadApplied: 1, dmApplied: 3 }; });
  expect(new QuestionsStore(path).get("f")).toMatchObject({ response: "resolved", resolvedText: "Answer confirmed.", ui: { revision: 3, threadApplied: 1, dmApplied: 3 } });
  const list = store.list(); list[0]!.ui!.revision = 100;
  expect(store.get("f")?.ui?.revision).toBe(3);
});
it("preserves scoped resume authority and modal draft identity", () => {
  const path = join(dir, "questions.json");
  new QuestionsStore(path).put({ ...snapshot(), resumeOwnerTs: "1791000000.000001", draftRevision: 5, page: 2 });
  expect(new QuestionsStore(path).get("f")).toMatchObject({ resumeOwnerTs: "1791000000.000001", draftRevision: 5, page: 2 });
});
it.each([{ revision: -1, threadApplied: 0, dmApplied: 0 }, { revision: 1, threadApplied: 2, dmApplied: 0 }, { revision: 1 }])("rejects invalid persisted UI revisions %j", ui => {
  const path = join(dir, "questions.json");
  writeFileSync(path, JSON.stringify({ version: 1, records: [{ ...snapshot(), ui }] }));
  expect(() => new QuestionsStore(path)).toThrow("Invalid question UI revision");
});
it("persists independent placement and converts only interrupted relocation posts to uncertainty", () => {
  const path = join(dir, "questions.json");
  const record = snapshot();
  new QuestionsStore(path).put({ ...record, presentation: 3, threadPresentation: 2, dmPresentation: 1,
    relocation: {
      thread: { epoch: 3, oldTs: "2", status: "in-flight", attempts: 1, binding: questionBindingToken(record), generation: 2,
        channel: "C", threadTs: "1", revision: 4, postedTs: "new", retryAt: 100 },
      dm: { epoch: 3, oldTs: "3", status: "rejected", attempts: 2 },
    } });
  expect(new QuestionsStore(path).get("f")).toMatchObject({ presentation: 3, threadPresentation: 2, dmPresentation: 1,
    relocation: { thread: { status: "uncertain", epoch: 3, postedTs: "new", revision: 4, channel: "C", threadTs: "1" },
      dm: { status: "rejected", attempts: 2 } } });
});
it.each([
  { presentation: -1 }, { presentation: 1.5 }, { presentation: null }, { threadPresentation: -1 }, { dmPresentation: "1" },
  { presentation: 1, threadPresentation: 2 }, { presentation: 1, dmPresentation: 2 },
  { relocation: null }, { relocation: [] }, { relocation: { other: { epoch: 1, oldTs: "2", status: "new", attempts: 0 } } },
  ...[{ epoch: -1 }, { epoch: 1.5 }, { oldTs: "" }, { status: "delivered" }, { attempts: -1 }, { attempts: 4 },
    { attempts: 0.5 }, { channel: 1 }, { threadTs: "" }, { binding: "invalid" }, { generation: -1 }, { revision: -1 },
    { postedTs: "" }, { retryAt: -1 }].map(change => ({ relocation: { thread: { epoch: 1, oldTs: "2", status: "new", attempts: 0, ...change } } })),
])("rejects invalid placement on read and write %j", placement => {
  const path = join(dir, "questions.json");
  const invalid = { ...snapshot(), ...placement } as QuestionSnapshot;
  writeFileSync(path, JSON.stringify({ version: 1, records: [invalid] }));
  expect(() => new QuestionsStore(path)).toThrow(/Invalid question (presentation|relocation)/);
  expect(() => new QuestionsStore(join(dir, "fresh.json")).put(invalid)).toThrow(/Invalid question (presentation|relocation)/);
});
it("keeps cleanup and unresolved original binding intent across replacement", () => {
  const store = new QuestionsStore(join(dir, "questions.json"));
  const record = snapshot();
  store.put({ ...record, presentation: 1, relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1 } },
    retiredCopies: [{ channel: "OLD", ts: "old" }] });
  store.put({ ...snapshot(), generation: 3, channel: "NEW", threadTs: "root", askTs: "new" });
  expect(store.get("f")).toMatchObject({ generation: 3, presentation: 0, retiredCopies: [{ channel: "OLD", ts: "old" }],
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", binding: questionBindingToken(record),
      generation: 2, channel: "C", threadTs: "1" } } });
  store.update("f", r => { delete r.relocation!.thread; });
  expect(new QuestionsStore(store.path).get("f")?.relocation?.thread).toBeUndefined();
});
it("refuses to replace attempted intent with a different relocation", () => {
  const store = new QuestionsStore(join(dir, "questions.json"));
  store.put({ ...snapshot(), presentation: 1, relocation: { thread: { epoch: 1, oldTs: "2", status: "in-flight", attempts: 1 } } });
  expect(() => store.put({ ...snapshot(), generation: 3, presentation: 2,
    relocation: { thread: { epoch: 2, oldTs: "different", status: "new", attempts: 0 } } })).toThrow("binding replacement refused");
  expect(store.get("f")?.generation).toBe(2);
});
it("never evicts aged resolved records with unresolved cleanup or placement", () => {
  const store = new QuestionsStore(join(dir, "questions.json"));
  store.put({ ...snapshot(), response: "resolved", updatedAt: 0, retiredCopies: [{ channel: "OLD", ts: "old" }] });
  store.put({ ...snapshot(), id: "g", req: { id: "g", sessionID: "s", questions: [] }, response: "resolved", updatedAt: 0,
    relocation: { thread: { epoch: 1, oldTs: "2", status: "uncertain", attempts: 1 } } });
  store.put({ ...snapshot(), id: "h", req: { id: "h", sessionID: "s", questions: [] } });
  expect(store.list().map(r => r.id)).toEqual(["f", "g", "h"]);
});
it("rejects cleanup overflow rather than discarding unresolved copies", () => {
  const store = new QuestionsStore(join(dir, "questions.json"));
  const copies = Array.from({ length: 32 }, (_, n) => ({ channel: "OLD", ts: String(n) }));
  store.put({ ...snapshot(), retiredCopies: copies });
  expect(() => store.update("f", r => { r.retiredCopies!.push({ channel: "NEW", ts: "overflow" }); })).toThrow("Invalid question retired copies");
  expect(store.get("f")?.retiredCopies).toEqual(copies);
});
