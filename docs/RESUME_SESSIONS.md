# Design: Resume & Monitor Sessions Started on the Computer

Feature request: resume sessions started on the computer (TUI) directly in Slack — with
history viewing, an optional AI catch-up summary, live monitoring of ongoing sessions,
and the usual `\command <#>` switching schema with a smart cap.

Most of the plumbing already exists; this doc maps the gaps to concrete changes.

## What exists today

| Capability | Where | Gap for this feature |
|---|---|---|
| List sessions | `\sessions` (`src/commands/handlers.ts:460`) → `sessionList()` | Current project only; fixed cap of 10; no filter; no running/idle marker |
| Bind existing session to a thread | `\resume <#\|id>` (`handlers.ts:481`) | Numbers re-resolved by re-querying + re-sorting (drift between list and pick); same project-only scope |
| Transcript access | `sessionMessages()` (`src/opencode/client.ts:40`) — already used by the finalize backstop (`src/slack/render.ts:947`) and the stale-run reconciler (`render.ts:310`) | No user-facing way to read it |
| Live rendering of a session's events | `SessionView` (`src/slack/render.ts`) keyed by sessionId in a registry (`render.ts:38`); fed from the SSE pipe in `src/start.ts:243-272` | Events for sessions without a view are dropped (`start.ts:265-268`); views are only created by `runPrompt`/`beginPrompt`, which assume SlackOC started the run |
| Cross-project dirs | `knownProjectDirs()` (`handlers.ts:382`): state-known projects + pool | Not wired into `\sessions`/`\resume` |

Key structural fact: **`SessionView` doesn't care who created the session.** It renders
any sessionId's SSE stream into a thread; "resume/watch" is mostly about constructing and
gating views correctly, not new transport.

## 1. Session picker: machine-wide listing, stable numbers, smart cap

New module `src/commands/picker.ts`, shared by `\sessions`, `\resume`, `\watch`, `\summary`:

```ts
interface SessionRef {
  sessionId: string;
  projectDir: string;      // from OcSession.directory (src/opencode/api.ts:9)
  title: string;
  updated: number;
  summary?: { additions: number; deletions: number };
  running: boolean;        // see below
  boundThreadKey?: string; // state.findThreadBySession()
}
```

- **Scope.** `\sessions` keeps current-project scope; `\sessions all` (and `\resume`/`\watch`
  resolution) uses machine scope: candidate dirs from `knownProjectDirs()` sorted by
  state recency, fan-out capped (`MAX_DIRS = 6`) since each dir needs a live
  `opencode serve` (`pool.ensure()`), then merge + sort by `time.updated` desc.
- **Running marker.** Two signals, both cheap:
  1. In `onPoolEvent` (`start.ts:243`), record `session.status` busy/idle into a
     process-wide activity map *before* the `getView()` lookup (events for view-less
     sessions are currently dropped — keep them for the map).
  2. Recency fallback: `time.updated` < ~90s ⇒ "active?" (markers: `▶ running`, `· idle`,
     `? active?`), so TUI-driven sessions that just started on a fresh server still show.
- **Stable `#` numbers.** Cache the last rendered list per threadKey
  (`Map<threadKey, { refs; at }>`, ~10 min TTL, one entry per thread). `\resume <#>`
  resolves against what the user actually saw; expired/missing ⇒ re-list and ask to pick
  again. Id-substring matching (`handlers.ts:494`) stays as fallback.
- **Smart cap.** `SESSION_LIST_CAP = 10` most-recent, plus an optional filter arg
  (`\sessions auth`), and a trailing `(+N older — \sessions <filter> or \sessions all)`
  hint. This addresses the "lots of items in history" concern: nothing floods, and the
  cap is beatable by narrowing, not by paging.

## 2. Chat history + optional AI summary

**`\history [n|#|id]`** — pure display, zero context pollution:
- Pull `sessionMessages()` for the thread's session (or a picker target), render a digest:
  `*you*` first line (truncated) / `*agent*` first ~6 lines or first paragraph, tool calls
  summarized as a count. Tail `n` turns (default 10).
- Size-bounded via `chunkText()` (`src/util.ts:185`); oversized digests go out as a
  snippet upload, the same way `\logs` and `\diff full` behave (`handlers.ts:270`,
  `handlers.ts:588`).
- Never sent to OpenCode — the resumed session's context is untouched by reading it.

**`\summary [#|id]`** — the opt-in AI catch-up, built entirely from existing patterns:
- Snapshot the transcript from `sessionMessages()` (user + assistant text parts only,
  budget-capped, e.g. 30k chars).
- Create a **throwaway session** on the same server: `sessionCreate` → `promptAsync`
  with a fixed summarizer prompt + the transcript → poll for the assistant text with a
  `time.completed` completion check — the exact probe pattern `detectDefaultModel` uses
  (`client.ts:139-166`) — then `sessionAbort` + `sessionDelete` the throwaway.
- Post the summary **to the Slack thread only**. The target session never sees it,
  satisfying "not injected into chat context" without any state work.
- Model: the thread's `\model` override, else the server default
  (`configGet`/`detectDefaultModel`, already cached per dir).
- Guards: refuse while the target session is mid-run (snapshot semantics would be
  confusing mid-stream); note the cost (one extra model call) in `\help`.

Why not summarize inside the resumed session (`\cmd`-style)? It would pollute exactly the
context the issue wants kept clean, and the summary would be indistinguishable from
conversation.

## 3. Live monitoring of ongoing sessions (`\watch` / `\unwatch`)

`\watch <#|id>` attaches a view to a session **not driven by Slack** (TUI/IDE on the
computer); replies in the thread stay read-only until the owner takes over.

- `SessionView.attach()` (new, alongside `beginPrompt` at `render.ts:392`):
  - posts `👀 watching <shortId> — driven on the computer…` as the status line, starts
    the 1s ticker so tool lines stream in live;
  - does **not** write the `pendingRun` tombstone (otherwise the boot interrupt sweep,
    `src/start.ts:711-738`, would ❌ unrelated Slack messages) and no 👀/✅ user-message
    lifecycle;
  - sets `runStartedAt = attach time`, so finalize's delivery backstop
    (`render.ts:947-965`) only posts content created after attaching — history is
    `\history`'s job, not the watcher's;
  - on idle → finalize posts the usual stats line and drops the view; `\watch` again to
    re-attach (sticky auto-reattach on next activity is a possible v2).
- **`ThreadState.watchOnly`** + a gate at the top of `runPrompt` (`src/slack/router.ts:313`):
  plain replies in a watching thread are rejected with
  "`\resume` to take this session over from your computer, `\unwatch` to stop".
  `\ commands still work; `\resume` from the watching thread is the natural takeover path
  (it just rebinds + swaps the gate off).
- **Exclusivity for free:** the view registry is keyed by sessionId (`render.ts:38`), so a
  session has at most one view ⇒ one watching/bound thread; the same
  `findThreadBySession` guard `\resume` already enforces (`handlers.ts:502-505`) covers
  conflicts.
- **Deliberate feature:** permission and question asks route via
  `state.findThreadBySession` (`start.ts:281`, `start.ts:342`), so a watched TUI run that
  hits a permission gate surfaces in Slack *with working buttons* — approve from your
  phone while the computer keeps driving. Opt-in by virtue of watching.

### Spikes to run before phase 3 (and one that may simplify phase 1)

1. **TUI→serve event propagation.** SlackOC's `opencode serve` (`src/opencode/server.ts:186`)
   and a user's TUI are separate processes sharing per-project on-disk storage. Verify a
   TUI-driven session's activity actually arrives on the serve process's `GET /event`
   bus. If it doesn't, the fallback is a poll loop per watched session (delta
   `sessionMessages` every 2–4s, feeding the same part-posting path) — more moving parts,
   so verify first.
2. **List scope.** Check whether `GET /session` on a server rooted at dir X returns only
   X's sessions or all local ones. If it's effectively global, machine scope collapses to
   a single call and the `MAX_DIRS` fan-out disappears.

### Spike results (run 2026-09-16, opencode 1.18.31) — both resolved

1. **Cross-process SSE does NOT propagate.** Two `opencode serve` processes (different
   roots, shared storage): a session driven through process B produced a full event
   stream on B's `/event` bus and *nothing* on A's (only `server.connected`/heartbeat).
   ⇒ `\watch` uses the polling fallback: a 3s `sessionMessages` delta per watched
   session feeding the same part-posting path (`SessionView.pollTranscript`). Reading
   IS cross-process (A's `GET /session/:id/message` returned B's full transcript), which
   is what makes polling viable.
2. **`GET /session` is machine-global.** A server rooted at dir A listed a session
   created under dir B; `?directory=` scopes it. ⇒ machine scope is a single call —
   no `MAX_DIRS` fan-out, and `\sessions` bare scopes via the directory filter.
   Note: no `status` field on `GET /session/:id` — running detection is the activity
   map + recency, not a polled flag.

## Command surface after the feature

| command | change |
|---|---|
| `\sessions [all\|<filter>]` | picker list: running/idle markers, bound marker, cap + "(+N more)" hint |
| `\resume <#\|id>` | unchanged UX; `#` resolves against the last rendered (cached) list; machine-wide targets rebind `projectDir` (already handled, `handlers.ts:510`) |
| `\history [n]` | new — transcript digest of this thread's session (or a picker target) |
| `\summary [#\|id]` | new — opt-in AI catch-up summary via throwaway session, thread-only |
| `\watch <#\|id>` / `\unwatch` | new — live read-only mirror of a computer-driven session |

`HELP_SECTIONS` (`handlers.ts:96`) gains a "Monitoring" group (watch/unwatch/history/summary).

## Phasing

1. **Picker** (`picker.ts` + `\sessions`/`\resume` updates) — self-contained, unit-testable
   (`test/commands.test.ts` patterns); biggest UX win per line of code.
2. **`\history` + `\summary`** — both reuse existing client helpers; no state changes.
3. **Watch mode** — `SessionView.attach()` + `watchOnly` gate + the two spikes.

## Risks / open questions

- Server spawn fan-out for machine scope (bounded by `MAX_DIRS`; idle reaper cleans up
  after 30 min, `src/start.ts:31`).
- Picker cache staleness vs. re-query drift — cache wins because numbers must match what
  was shown; id-substring fallback covers expiry.
- Summary cost + model choice (thread override vs server default) — documented in help.
- Watch-mode edge: TUI session dies / server reaped mid-watch ⇒ finalize with a visible
  reason (existing death hook path, `start.ts:187-193`).
- Discovering project dirs never used with SlackOC would require reading OpenCode's
  internal on-disk storage layout — deliberately out of scope (fragile); `\cd`-then-`\sessions`
  covers it.
