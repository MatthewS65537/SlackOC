/**
 * D1: saved prompts in prompts.json beside state.json. Kept out of state.json
 * so the send-file contract there doesn't widen. One writer (the bridge);
 * atomic 0600 writes, the same as permissions.json.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./util.js";

export interface SavedPrompt { text: string; createdAt: number }

/** Lowercased on save and lookup, so names are case-insensitive. */
export const PROMPT_NAME = /^[a-z0-9_-]{1,32}$/;

export class PromptStore {
  // A Map, not an object: "__proto__" is a valid name.
  private prompts = new Map<string, SavedPrompt>();
  /** Called after every write (the Home tab's quick actions refresh on it). */
  onChange?: () => void;

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; prompts?: unknown };
    if (data?.version !== 1 || !data.prompts || typeof data.prompts !== "object") throw new Error("unsupported prompts.json");
    for (const [name, p] of Object.entries(data.prompts as Record<string, SavedPrompt>)) {
      if (PROMPT_NAME.test(name) && typeof p?.text === "string") this.prompts.set(name, { text: p.text, createdAt: Number(p.createdAt) || 0 });
    }
  }

  get(name: string): SavedPrompt | undefined {
    return this.prompts.get(name.toLowerCase());
  }

  /** Sorted by name. */
  list(): Array<SavedPrompt & { name: string }> {
    return [...this.prompts].sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) => ({ name, ...p }));
  }

  /** Caller validates the name against PROMPT_NAME. Overwriting keeps the original createdAt. */
  set(name: string, text: string): "created" | "updated" {
    const key = name.toLowerCase();
    const prior = this.prompts.get(key);
    this.save(new Map(this.prompts).set(key, { text, createdAt: prior?.createdAt ?? Date.now() }));
    return prior ? "updated" : "created";
  }

  delete(name: string): boolean {
    const next = new Map(this.prompts);
    if (!next.delete(name.toLowerCase())) return false;
    this.save(next);
    return true;
  }

  /** Memory changes only after the file is written, so a failed write leaves both unchanged. */
  private save(next: Map<string, SavedPrompt>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path, JSON.stringify({ version: 1, prompts: Object.fromEntries(next) }, null, 2), 0o600);
    this.prompts = next;
    this.onChange?.();
  }
}
