import { QuestionsStore, questionBindingToken, sameQuestionBinding, type QuestionRelocation, type QuestionSnapshot } from "./questions-store.js";

type Destination = "thread" | "dm";
type Card = { text: string; blocks: unknown[] };
interface QuestionUiDeps {
  store: QuestionsStore;
  dmChannel(): string | null;
  eligible(snapshot: QuestionSnapshot): boolean;
  render(snapshot: QuestionSnapshot, destination: Destination): Card;
  /** Build inside the Slack queue, not when the operation is enqueued. */
  send(channel: string, ts: string, build: () => Card | undefined): Promise<void>;
  /** Check inside the Slack queue immediately before deleting the old copy. */
  remove(channel: string, ts: string, allowed: () => boolean): Promise<void>;
  post?(channel: string, threadTs: string | undefined, build: () => Card | undefined): Promise<{ ts: string } | undefined>;
  /** The transport must restrict evidence to bot-authored messages with this exact marker. */
  find?(channel: string, threadTs: string | undefined, marker: string): Promise<{ ts: string } | undefined>;
  rejectedPost?(err: unknown): boolean;
  onAdopt?(record: QuestionSnapshot): void;
  stopping(): boolean;
  onError(message: string): void;
}

export function questionPresentationMarker(record: Pick<QuestionSnapshot, "id" | "sessionId" | "projectDir" | "generation" | "channel" | "threadTs" | "presentation">, destination: Destination): string {
  return `slackoc-question:${record.id}:${record.generation}:card:${record.presentation ?? 0}:${destination}:${questionBindingToken(record)}`;
}

const presentationKey = (destination: Destination) => destination === "thread" ? "threadPresentation" : "dmPresentation";
const timestampKey = (destination: Destination) => destination === "thread" ? "askTs" : "dmTs";
const appliedKey = (destination: Destination) => destination === "thread" ? "threadApplied" : "dmApplied";

/** UI retries never submit native answers. Each known Slack message has one writer. */
export class QuestionUiReconciler {
  private flights = new Map<string, Promise<void>>();
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  constructor(private deps: QuestionUiDeps) {}

  refreshAll(force = false): Promise<void> {
    return Promise.all(this.deps.store.list().map(r => this.refresh(r.id, force))).then(() => {});
  }

  refresh(id: string, force = false): Promise<void> {
    const writes = (["thread", "dm"] as const).map(destination => {
      const key = `${id}:${destination}`;
      const existing = this.flights.get(key);
      if (existing) return existing;
      if (!force && (this.failures.get(key)?.retryAt ?? 0) > Date.now()) return;
      const flight = this.run(id, destination).catch(err => {
        const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
        this.failures.set(key, { attempts, retryAt: Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(attempts - 1, 4)) });
        this.deps.onError(`question update (${id} ${destination}): ${String(err)}`);
      }).finally(() => { this.flights.delete(key); });
      this.flights.set(key, flight);
      return flight;
    });
    return Promise.all(writes).then(() => this.retireAll(id, force));
  }

  private retireAll(id: string, force: boolean): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const copy of this.deps.store.get(id)?.retiredCopies ?? []) {
      const key = `${id}:retired:${copy.channel}:${copy.ts}`;
      const existing = this.flights.get(key);
      if (existing) { writes.push(existing); continue; }
      if (!force && (this.failures.get(key)?.retryAt ?? 0) > Date.now()) continue;
      let removed = false;
      let reused = false;
      const flight = this.deps.remove(copy.channel, copy.ts, () => {
        const record = this.deps.store.get(id);
        if (this.deps.stopping() || !record?.retiredCopies?.some(c => c.channel === copy.channel && c.ts === copy.ts)) return false;
        if ((record.channel === copy.channel && record.askTs === copy.ts) ||
          (this.deps.dmChannel() === copy.channel && record.dmTs === copy.ts)) { reused = true; return false; }
        removed = true;
        return true;
      }).then(() => {
        if (this.deps.stopping() || (!removed && !reused)) return;
        this.deps.store.update(id, r => {
          if (reused && !removed && !((r.channel === copy.channel && r.askTs === copy.ts) ||
            (this.deps.dmChannel() === copy.channel && r.dmTs === copy.ts))) return;
          r.retiredCopies = r.retiredCopies?.filter(c => c.channel !== copy.channel || c.ts !== copy.ts);
        });
        this.failures.delete(key);
      }).catch(err => {
        this.failures.set(key, { attempts: 1, retryAt: Date.now() + 60_000 });
        this.deps.onError(`question retired delete (${id}): ${String(err)}`);
      }).finally(() => { this.flights.delete(key); });
      this.flights.set(key, flight);
      writes.push(flight);
    }
    return Promise.all(writes).then(() => {});
  }

  private async run(id: string, destination: Destination): Promise<void> {
    const key = `${id}:${destination}`;
    let relocationError: unknown;
    for (;;) {
      if (this.deps.stopping()) return;
      let record = this.deps.store.get(id);
      if (!record) return;
      if (record.relocation?.[destination] && !relocationError) {
        try {
          if (await this.relocate(record, destination)) continue;
        } catch (err) { relocationError = err; }
        record = this.deps.store.get(id);
        if (!record || this.deps.stopping()) return;
      }
      const channel = destination === "thread" ? record?.channel : this.deps.dmChannel();
      const ts = destination === "thread" ? record?.askTs : record?.dmTs;
      const applied = appliedKey(destination);
      if (!channel || !ts || !this.deps.eligible(record)) {
        if (relocationError) throw relocationError;
        return;
      }
      if (record.response === "pending" && (record.presentation ?? 0) > (record[presentationKey(destination)] ?? 0)) {
        if (relocationError || record.relocation?.[destination]) {
          try { await this.unconfirmed(record, destination, channel, ts); }
          catch (err) { throw new Error(`${relocationError ?? "Question placement unconfirmed"}; old-card notice failed: ${String(err)}`); }
          const current = this.deps.store.get(id);
          if (current && (!sameQuestionBinding(current, record) || current.response !== record.response ||
            current.presentation !== record.presentation || current[timestampKey(destination)] !== ts)) continue;
          if (relocationError) throw relocationError;
          return;
        }
        const failure = !this.deps.post ? "Question placement transport unavailable; current card retained" :
          (record.retiredCopies?.length ?? 0) + Object.keys(record.relocation ?? {}).length >= 32
            ? "Question cleanup full; current card retained until retired copies are cleaned" : undefined;
        if (failure) {
          try { await this.unconfirmed(record, destination, channel, ts); }
          catch (err) { throw new Error(`${failure}; old-card notice failed: ${String(err)}`); }
          throw new Error(failure);
        }
        this.deps.store.update(id, current => {
          current.relocation ??= {};
          current.relocation[destination] = { epoch: record!.presentation ?? 0, oldTs: ts, status: "new", attempts: 0,
            binding: questionBindingToken(record!), generation: record!.generation, channel,
            ...(destination === "thread" ? { threadTs: record!.threadTs } : {}) };
        });
        continue;
      }
      if ((record.ui?.[applied] ?? 0) >= (record.ui?.revision ?? 1)) {
        if (relocationError) throw relocationError;
        return;
      }
      let sent: QuestionSnapshot | undefined;
      const before = record;
      await this.deps.send(channel, ts, () => {
        const current = this.deps.store.get(id);
        if (this.deps.stopping() || !current || !this.deps.eligible(current) ||
          !sameQuestionBinding(current, before) || current[timestampKey(destination)] !== ts ||
          (destination === "dm" && this.deps.dmChannel() !== channel) ||
          (current.response === "pending" && (current.presentation ?? 0) > (current[presentationKey(destination)] ?? 0))) return;
        sent = current;
        // A known old copy must never masquerade as evidence of a replacement post.
        // Keep terminal/retry controls on current state; only the placement marker describes the copy.
        const card = this.deps.render(current, destination);
        const intended = questionPresentationMarker(current, destination);
        const actual = questionPresentationMarker({ ...current, presentation: current[presentationKey(destination)] ?? 0 }, destination);
        return { ...card, text: card.text.split("\n").map(line => line === intended ? actual : line).join("\n") };
      });
      if (!sent) {
        if (relocationError) throw relocationError;
        const current = this.deps.store.get(id);
        if (current && (!sameQuestionBinding(current, before) || current[timestampKey(destination)] !== ts ||
          current.presentation !== before.presentation)) continue;
        return;
      }
      const rendered = sent;
      this.deps.store.update(id, current => {
        if (!sameQuestionBinding(current, rendered) || (destination === "thread" ? current.askTs : current.dmTs) !== ts) return;
        current.ui ??= { revision: 1, threadApplied: 0, dmApplied: 0 };
        current.ui[applied] = rendered.ui?.revision ?? 1;
      });
      this.failures.delete(key);
      if (relocationError) throw relocationError;
    }
  }

  private async unconfirmed(record: QuestionSnapshot, destination: Destination, channel: string, ts: string): Promise<void> {
    await this.deps.send(channel, ts, () => {
      const current = this.deps.store.get(record.id);
      if (this.deps.stopping() || !current || !sameQuestionBinding(current, record) || !this.deps.eligible(current) ||
        current.response !== "pending" || current[timestampKey(destination)] !== ts ||
        (destination === "dm" && this.deps.dmChannel() !== channel) ||
        (current.presentation ?? 0) <= (current[presentationKey(destination)] ?? 0)) return;
      const text = "Question-card delivery unconfirmed — use \\questions to check.";
      return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
    });
  }

  private sameIntent(a: QuestionRelocation | undefined, b: QuestionRelocation): boolean {
    return !!a && a.epoch === b.epoch && a.oldTs === b.oldTs && a.binding === b.binding &&
      a.generation === b.generation && a.channel === b.channel && a.threadTs === b.threadTs;
  }

  private live(record: QuestionSnapshot, destination: Destination, intent: QuestionRelocation): boolean {
    return !this.deps.stopping() && record.response === "pending" && this.deps.eligible(record) &&
      questionBindingToken(record) === intent.binding && (record.presentation ?? 0) === intent.epoch &&
      record[timestampKey(destination)] === intent.oldTs && (record[presentationKey(destination)] ?? 0) < intent.epoch &&
      (destination === "thread" ? record.channel : this.deps.dmChannel()) === intent.channel;
  }

  private clearIntent(id: string, destination: Destination, intent: QuestionRelocation): void {
    this.deps.store.update(id, current => {
      if (this.sameIntent(current.relocation?.[destination], intent)) delete current.relocation![destination];
    });
  }

  private retire(record: QuestionSnapshot, channel: string, ts: string): void {
    if (record.retiredCopies?.some(c => c.channel === channel && c.ts === ts)) return;
    if ((record.retiredCopies?.length ?? 0) >= 32) throw new Error("Question cleanup full; confirmed post retained in relocation intent");
    (record.retiredCopies ??= []).push({ channel, ts });
  }

  private finish(id: string, destination: Destination, intent: QuestionRelocation): void {
    let adopted = false;
    const saved = this.deps.store.update(id, current => {
      if (!intent.postedTs) return;
      if (!this.sameIntent(current.relocation?.[destination], intent)) {
        this.retire(current, intent.channel!, intent.postedTs);
        return;
      }
      if (this.live(current, destination, intent)) {
        if (intent.oldTs !== intent.postedTs) this.retire(current, intent.channel!, intent.oldTs);
        current[timestampKey(destination)] = intent.postedTs;
        current[presentationKey(destination)] = intent.epoch;
        current.ui ??= { revision: 1, threadApplied: 0, dmApplied: 0 };
        current.ui[appliedKey(destination)] = Math.min(intent.revision ?? 0, current.ui.revision);
        adopted = true;
      } else if ((destination === "thread" ? current.channel : this.deps.dmChannel()) !== intent.channel ||
        current[timestampKey(destination)] !== intent.postedTs) {
        this.retire(current, intent.channel!, intent.postedTs);
      }
      delete current.relocation![destination];
    });
    if (adopted && saved) this.deps.onAdopt?.(saved);
  }

  private rememberPost(id: string, destination: Destination, intent: QuestionRelocation, ts: string): void {
    intent.postedTs = ts;
    intent.status = "uncertain";
    this.deps.store.update(id, current => {
      const existing = current.relocation?.[destination];
      if (!existing || this.sameIntent(existing, intent)) {
        current.relocation ??= {};
        current.relocation[destination] = structuredClone(intent);
      } else this.retire(current, intent.channel!, ts);
    });
  }

  private async relocate(record: QuestionSnapshot, destination: Destination): Promise<boolean> {
    const id = record.id;
    const intent = structuredClone(record.relocation![destination]!);
    intent.binding ??= questionBindingToken(record);
    intent.generation ??= record.generation;
    intent.channel ??= destination === "thread" ? record.channel : this.deps.dmChannel() ?? undefined;
    if (destination === "thread") intent.threadTs ??= record.threadTs;
    if (!intent.channel) throw new Error("Question relocation destination unavailable");
    this.deps.store.update(id, current => { current.relocation![destination] = structuredClone(intent); });
    if (intent.postedTs) { this.finish(id, destination, intent); return true; }
    if (intent.status === "uncertain" || intent.status === "in-flight") {
      const marker = `slackoc-question:${record.id}:${intent.generation}:card:${intent.epoch}:${destination}:${intent.binding}`;
      const found = await this.deps.find?.(intent.channel, intent.threadTs, marker);
      if (!found) throw new Error("Question placement uncertain; no matching bot-authored evidence, current card retained");
      if (found.ts === intent.oldTs) throw new Error("Question placement uncertain; evidence names the old copy, not a replacement");
      this.rememberPost(id, destination, intent, found.ts);
      this.finish(id, destination, intent);
      return true;
    }
    if (!this.live(record, destination, intent)) { this.clearIntent(id, destination, intent); return true; }
    if (intent.attempts >= 3) throw new Error("Question placement rejected three times; current card retained");
    if ((intent.retryAt ?? 0) > Date.now()) return false;
    if (!this.deps.post) throw new Error("Question placement transport unavailable; current card retained");
    intent.status = "in-flight"; intent.attempts++;
    this.deps.store.update(id, current => { current.relocation![destination] = structuredClone(intent); });
    let built = false;
    let result: { ts: string } | undefined;
    try {
      result = await this.deps.post(intent.channel, intent.threadTs, () => {
        const current = this.deps.store.get(id);
        if (!current || !this.sameIntent(current.relocation?.[destination], intent) || !this.live(current, destination, intent)) return;
        const card = this.deps.render(current, destination);
        intent.revision = current.ui?.revision ?? 1;
        this.deps.store.update(id, latest => { latest.relocation![destination] = structuredClone(intent); });
        built = true;
        return card;
      });
    } catch (err) {
      intent.status = !built || this.deps.rejectedPost?.(err) ? "rejected" : "uncertain";
      if (intent.status === "rejected") intent.retryAt = Date.now() + 5_000 * 2 ** (intent.attempts - 1);
      this.deps.store.update(id, current => {
        if (this.sameIntent(current.relocation?.[destination], intent)) current.relocation![destination] = structuredClone(intent);
        else if (!current.relocation?.[destination]) (current.relocation ??= {})[destination] = structuredClone(intent);
      });
      throw new Error(`Question placement ${intent.status}; current card retained: ${String(err)}`);
    }
    if (!result?.ts) {
      if (!built) { this.clearIntent(id, destination, intent); return true; }
      intent.status = "uncertain";
      this.deps.store.update(id, current => {
        if (this.sameIntent(current.relocation?.[destination], intent)) current.relocation![destination] = structuredClone(intent);
        else if (!current.relocation?.[destination]) (current.relocation ??= {})[destination] = structuredClone(intent);
      });
      throw new Error("Question post did not confirm a timestamp; current card retained");
    }
    this.rememberPost(id, destination, intent, result.ts);
    this.finish(id, destination, intent);
    return true;
  }
}
