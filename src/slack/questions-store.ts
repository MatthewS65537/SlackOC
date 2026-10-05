import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { OcQuestionRequest } from "../opencode/api.js";

export interface QuestionRelocation {
  epoch: number;
  oldTs: string;
  status: "new" | "in-flight" | "uncertain" | "rejected";
  attempts: number;
  /** Preserve the original destination/binding when the current session changes. */
  binding?: string;
  generation?: number;
  channel?: string;
  threadTs?: string;
  revision?: number;
  postedTs?: string;
  retryAt?: number;
}

export interface QuestionSnapshot {
  id: string;
  sessionId: string;
  projectDir: string;
  generation: number;
  channel: string;
  threadTs: string;
  req: OcQuestionRequest;
  answers: string[][];
  finalized: boolean[];
  askTs: string | null;
  dmTs: string | null;
  response: "pending" | "answering" | "uncertain" | "resolved";
  ui?: { revision: number; threadApplied: number; dmApplied: number };
  presentation?: number;
  threadPresentation?: number;
  dmPresentation?: number;
  relocation?: Partial<Record<"thread" | "dm", QuestionRelocation>>;
  page?: number;
  draftRevision?: number;
  resolvedText?: string;
  resumeOwnerTs?: string;
  retiredCopies?: Array<{ channel: string; ts: string }>;
  threadDelivery?: { status: "new" | "in-flight" | "delivered" | "rejected" | "uncertain"; attempts: number };
  dmDelivery?: { status: "new" | "in-flight" | "delivered" | "rejected" | "uncertain"; attempts: number };
  updatedAt: number;
}

/** Generations are thread-local; the number alone is never a binding identity. */
export function sameQuestionBinding(a: Pick<QuestionSnapshot, "id" | "sessionId" | "projectDir" | "generation" | "channel" | "threadTs">,
  b: Pick<QuestionSnapshot, "id" | "sessionId" | "projectDir" | "generation" | "channel" | "threadTs">): boolean {
  return a.id === b.id && a.sessionId === b.sessionId && a.projectDir === b.projectDir && a.generation === b.generation &&
    a.channel === b.channel && a.threadTs === b.threadTs;
}

export function questionBindingToken(record: Pick<QuestionSnapshot, "id" | "sessionId" | "projectDir" | "generation" | "channel" | "threadTs">): string {
  return createHash("sha256").update(JSON.stringify([record.id, record.sessionId, record.projectDir, record.channel, record.threadTs, record.generation])).digest("hex").slice(0, 24);
}

function validatePlacement(record: QuestionSnapshot): void {
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const text = (s: unknown): s is string => typeof s === "string" && s.length > 0;
  if ([record.presentation, record.threadPresentation, record.dmPresentation].some(n => n !== undefined && !integer(n))) {
    throw new Error("Invalid question presentation");
  }
  if ((record.threadPresentation ?? 0) > (record.presentation ?? 0) || (record.dmPresentation ?? 0) > (record.presentation ?? 0)) {
    throw new Error("Invalid question presentation");
  }
  if (record.retiredCopies !== undefined && (!Array.isArray(record.retiredCopies) || record.retiredCopies.length > 32 ||
    record.retiredCopies.some(c => !c || !text(c.channel) || !text(c.ts)))) throw new Error("Invalid question retired copies");
  if (record.relocation === undefined) return;
  if (!record.relocation || typeof record.relocation !== "object" || Array.isArray(record.relocation) ||
    Object.keys(record.relocation).some(k => k !== "thread" && k !== "dm")) throw new Error("Invalid question relocation");
  for (const intent of Object.values(record.relocation)) {
    if (!intent || !integer(intent.epoch) || !text(intent.oldTs) || !integer(intent.attempts) || intent.attempts > 3 ||
      !["new", "in-flight", "uncertain", "rejected"].includes(intent.status) ||
      [intent.generation, intent.revision, intent.retryAt].some(n => n !== undefined && !integer(n)) ||
      [intent.channel, intent.threadTs, intent.postedTs].some(s => s !== undefined && !text(s)) ||
      (intent.binding !== undefined && (typeof intent.binding !== "string" || !/^[a-f0-9]{24}$/.test(intent.binding)))) {
      throw new Error("Invalid question relocation");
    }
  }
}

/** Persist answer uncertainty before HTTP, and copy identities before further delivery. */
export class QuestionsStore {
  private records = new Map<string, QuestionSnapshot>();
  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    const disk = JSON.parse(readFileSync(path, "utf8")) as { version: number; records: QuestionSnapshot[] };
    if (disk.version !== 1 || !Array.isArray(disk.records) || disk.records.length > 512) throw new Error("Invalid question store");
    for (const r of disk.records) {
      if (!r.id || r.req?.id !== r.id || r.req.sessionID !== r.sessionId || !Array.isArray(r.answers) || !Array.isArray(r.finalized) || !Number.isSafeInteger(r.generation)) throw new Error("Invalid stored question");
      if (r.ui && ([r.ui.revision, r.ui.threadApplied, r.ui.dmApplied].some(n => !Number.isSafeInteger(n) || n < 0) ||
        r.ui.threadApplied > r.ui.revision || r.ui.dmApplied > r.ui.revision)) throw new Error("Invalid question UI revision");
      if ([r.page, r.draftRevision].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) ||
        (r.resumeOwnerTs !== undefined && !/^\d{1,12}\.\d{1,6}$/.test(r.resumeOwnerTs)) ||
        (r.retiredCopies && (!Array.isArray(r.retiredCopies) || r.retiredCopies.length > 32 || r.retiredCopies.some(c => !c.channel || !c.ts)))) throw new Error("Invalid question UI state");
      validatePlacement(r);
      r.presentation ??= 0; r.threadPresentation ??= 0; r.dmPresentation ??= 0;
      r.ui ??= { revision: 1, threadApplied: 0, dmApplied: 0 };
      if (r.response === "answering") { r.response = "uncertain"; r.ui.revision++; }
      if (r.response === "resolved") r.resolvedText ??= "Question resolved or expired; the previous answer was not confirmed.";
      for (const d of [r.threadDelivery, r.dmDelivery]) if (d?.status === "in-flight") d.status = "uncertain";
      for (const intent of Object.values(r.relocation ?? {})) if (intent.status === "in-flight") intent.status = "uncertain";
      this.records.set(r.id, r);
    }
  }
  get(id: string): QuestionSnapshot | undefined { const r = this.records.get(id); return r && structuredClone(r); }
  list(): QuestionSnapshot[] { return [...this.records.values()].map(r => structuredClone(r)); }
  update(id: string, change: (record: QuestionSnapshot) => void): QuestionSnapshot | undefined {
    const record = this.get(id);
    if (!record) return;
    change(record); this.put(record); return record;
  }
  put(record: QuestionSnapshot): void {
    validatePlacement(record);
    const next = new Map(this.records);
    const saved = structuredClone(record);
    const previous = this.records.get(record.id);
    if (previous && !sameQuestionBinding(previous, saved)) {
      for (const destination of ["thread", "dm"] as const) {
        const intent = previous.relocation?.[destination];
        if (!intent || (!intent.postedTs && intent.status !== "in-flight" && intent.status !== "uncertain")) continue;
        const replacement = saved.relocation?.[destination];
        if (replacement && (replacement.epoch !== intent.epoch || replacement.oldTs !== intent.oldTs ||
          replacement.binding !== intent.binding)) throw new Error("Question placement unresolved; binding replacement refused");
        saved.relocation ??= {};
        saved.relocation[destination] = { ...structuredClone(intent), binding: intent.binding ?? questionBindingToken(previous),
          generation: intent.generation ?? previous.generation,
          ...(destination === "thread" ? { channel: intent.channel ?? previous.channel, threadTs: intent.threadTs ?? previous.threadTs } : {}) };
      }
      for (const copy of previous.retiredCopies ?? []) {
        if (!saved.retiredCopies?.some(c => c.channel === copy.channel && c.ts === copy.ts)) (saved.retiredCopies ??= []).push(structuredClone(copy));
      }
    }
    saved.presentation ??= 0; saved.threadPresentation ??= 0; saved.dmPresentation ??= 0;
    validatePlacement(saved);
    next.set(record.id, saved);
    for (const [id, r] of next) if (id !== record.id && r.response === "resolved" && !r.retiredCopies?.length &&
      !Object.keys(r.relocation ?? {}).length && Date.now() - r.updatedAt > 7 * 86400_000) next.delete(id);
    if (next.size > 512) throw new Error("Question store full; pending answers retained");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, records: [...next.values()] }));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.path); this.records = next;
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
  }
}
