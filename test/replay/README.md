# Replay tests

`replay.test.ts` pushes a raw OpenCode V2 event log through the real `V2Events` and `SessionView` into a fake Slack
(`fake-slack.ts`, behind the real `createRenderDeps` and Slack queue), on fake timers, and checks the recorded thread:
the answer text equals the transcript, no paragraph is posted twice, the status line is gone at the end, ✅ replaces
👀, and question/permission cards land after the text before them. Each fixture also has a golden timeline
(`fixtures/<name>.golden.json`, status-line traffic left out, ts values replaced by `U1`/`M1`).

`run.ts` stands in for the router, interactions and the OpenCode service in a simplified form (see its header):
prompts come from user `session.inbox.enqueued` events, a `steer` delivery change plays the Steer button, and
`messages()` answers from the durable events applied so far. Faults: `resubscribe {at, lost}`, `dropNth`,
`rateLimitNth`, `latencyMs`.

## Record a session

```sh
npx tsx test/replay/record.ts <name> <sessionID> [childSessionID...]
```

This reads `session.log` from the running local service (read-only) and writes `fixtures/<name>.jsonl` with all
free text scrubbed to same-length placeholder words. Pass subagent session IDs after the parent. The log has durable
events only, so the runner synthesizes text deltas, and permission/question events must be added by hand.

## Add a fixture

1. Drop `<name>.jsonl` (recorded, or hand-built in the event shapes of `@opencode/client`'s `types.d.ts`) in `fixtures/`.
   The first user `session.inbox.enqueued` picks the session that owns the thread.
2. Run `npx vitest run test/replay/replay.test.ts`. A missing golden is written (not under `CI=true`); `-u` rewrites
   existing ones.
3. Read the new golden before committing it: it is only worth keeping if that thread is what a user should see.
