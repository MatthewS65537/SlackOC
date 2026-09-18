# SlackOC

Control an [OpenCode](https://opencode.ai) session running on your machine directly from **Slack**. Start it on your dev box, and your OpenCode agent becomes reachable from anywhere — no terminal, SSH, or VPN.

```bash
curl -fsSL https://raw.githubusercontent.com/MatthewS65537/SlackOC/main/install.sh | bash
slackoc init      # one-time: create a Slack app from the bundled manifest, paste tokens
slackoc start     # bridge up
```

Then DM the bot (or `@mention` it in a channel where it's invited) from your phone or desktop:

```
you>  fix the flaky auth test in the login flow
bot>  ⏳ OpenCode is on it…                  (live status line — deleted when done)
      ⎯⎯⎯ tools ⎯⎯⎯
      🔧 npm test                    ← tool calls as compact one-liners (📄 read, ✏️ edit, 🔍 grep, …)
      ⎯⎯⎯ response ⎯⎯⎯
      …the answer, markdown rendered for Slack…
      👀 on your message the moment the bridge sees it, ✅ when done (❌ on error)
      *my-app* · +41/−8 across 2 file(s) · `anthropic/claude-sonnet-4-5` · 12s · $0.041 · 12.0k↑/2.0k↓ · Verbose Tools
```

## How it works

```
Slack (mobile/desktop) ── Socket Mode (outbound, no public URL) ──► slackoc
                                                                      │ spawns per-project
                                                                      ▼
                                                    opencode serve (127.0.0.1, auto port)
```

- **`opencode serve` per project dir**, spawned lazily; sessions persist on disk, so restarts are seamless.
- **One Slack thread ⇄ one OpenCode session.** New root messages create sessions; thread replies continue them.
- Streams via OpenCode's SSE event stream; Slack-safe rendering (live 1-second status ticker, chunked text, snippet files).

## Features

- **Remote prompting** from Slack DM or mention, with answers streamed into threads
- **Proactive threads with a mute** — once a thread has a session, replies are answered with no @ mention needed; `\hush` quiets the thread (an @ always wakes it)
- **Tool visibility by default** — `\verbose full|on|off`; each tool call posts a compact line showing exactly what it's doing (`📄 read src/x.ts`, `🔧 npm test`, `🔍 grep "pattern"`), `full` adds output snippets
- **Markdown answers render properly** — GFM → Slack mrkdwn conversion (bold, lists, links, headings); fenced code stays code
- **Image support, both ways** — attach a screenshot (or any text/PDF/JSON file ≤8MB) to your message and the model sees it; images over ~1MB are auto-compressed to stay under provider request-size limits; images the model produces are posted back into the thread
- **Approval buttons** — Approve once / Always allow / Deny, resolving OpenCode's permission requests in place — mirrored to your DMs, so a blocked run pages you on your phone
- **Notifications that reach you** — failures DM the owner by default; `\notify on` adds a DM when each run finishes (with a one-tap 📄 View diff button); a 3-minute stall pages you once
- **Crash-proof, self-healing threads** — an `opencode serve` that dies mid-run fails the thread loudly instead of hanging silently; a run whose completion events are lost (wifi blip, sleep/wake) is reconciled and finished from polled state within ~2 minutes; `\restart` rescues a wedged server; idle servers auto-stop after 30 minutes
- **Status board in your pocket** — `\status` lists runs in flight (elapsed, queued, thread links); markdown tables from the model render as aligned code blocks
- **Restart-safe** — a run interrupted by a bridge restart gets its ❌ and a clear notice instead of a frozen "working…" message
- **Alive-at-a-glance** — every accepted prompt stamps a 👀 on your message within a second (cleared when ✅/❌ lands), so a dead bridge can never look identical to a slow one
- **Lost-message catch-up** — Slack discards Socket Mode envelopes it can't deliver (restart gap, network flap, zombie connection) without replaying them; every minute the bridge re-reads active threads from `conversations.replies` and routes anything it missed, so a delivery gap costs latency, never the message itself. Socket connect/disconnect/ping-timeout evidence lands in `\logs`
- **Instant `\` commands, even mid-run** — outbound Slack calls ride a per-channel queue where interactive traffic (command answers, approval prompts, acks) jumps ahead of background stream traffic; a busy run never delays `\help` & co.
- **Progress bar pinned to the bottom** — the ⏳ indicator re-homes itself below every streamed message, so a long-running task's live status is always the last thing on screen
- **Multi-project** — not locked to one folder: `\projects`, `\cd /path`, `\new /path`
- **Native command passthrough** — `\cmd <opencode command>`, plus model (`\model <#>`) and agent (`\agent <#|name>`) swaps
- **Owner-only security** — the bot obeys exactly one paired Slack user ID; everyone else is ignored

Backslash commands run inside Slack but are invisible to the workspace — they never collide with Slack slash commands. Full list: send `\help` to the bot after setup.

## Setup (5–10 min)

1. Install (Node ≥ 20): `curl -fsSL https://raw.githubusercontent.com/MatthewS65537/SlackOC/main/install.sh | bash` — and have `opencode` ≥ 1.18 on your box.
2. `slackoc init` — guided: create the Slack app from the bundled manifest, install it, paste the bot token (`xoxb-`) and app-level token (`xapp-`), enter your Slack member ID. Both tokens are validated live against Slack; the member ID is verified (`users:read` scope — already in the manifest). Non-interactive flags for CI: `--bot-token --app-token --owner [--dir]`
3. `slackoc doctor` — sanity check
4. `slackoc start` — bridge online
5. Open Slack → DM your bot → prompt

Details & troubleshooting: [docs/SETUP.md](docs/SETUP.md).

## Command surface

Each thread answers proactively once it has a session — invite the bot to any channel where you want that (`/invite @SlackOC`); DMs always work. `\hush` toggles quiet mode per thread.

| command | effect |
|---|---|
| `\help` `\status` | grouped cheat sheet / project, binding, pool health |
| `\hush` | toggle quiet mode in this thread (@ mention wakes it) |
| `\verbose on\|off\|full` | tool-call visibility — `on` by default, `full` adds output snippets |
| `\model` | numbered `provider/model` list; `\model <#>`, `\model provider/model`, or a filter (`\model sonnet`) to set |
| `\stop` `\abort` | cancel the running task in this thread |
| `\project <name\|#>` | swap projects by fuzzy name (`\project cowork`) or listing number — same fresh teardown as `\cd` |
| `\new [dir]` `\cd <dir>` `\projects` | fresh session (previous one kept for `\resume`) / switch by path (`~` OK) / list projects |
| `\sessions` `\resume <#\|id>` | list + bind threads to sessions |
| `\agent <#\|name>` | swap OpenCode agent |
| `\diff` `\cmd …` | diff summary (`\diff full` adds the unified diff, snippet when long) / OpenCode native command passthrough |
| `\notify on\|off` | DM the owner when runs in this thread finish (failures + permission asks always DM) |
| `\logs [filter]` | recent bridge log lines, optionally substring-filtered (`\logs error`) — remote debugging without the console |
| `\restart` | restart this project's opencode server (wedged-run rescue — threads keep their sessions) |

## Security model

- Owner-only: exactly one paired Slack user ID is obeyed (checked on every event, including button clicks).
- Tokens + state live at `~/.config/slackoc/`, mode `0600`, never logged.
- OpenCode servers bind only `127.0.0.1`; nothing listens on the network.
- Unknown `\…` text is rejected as a command, never forwarded to OpenCode as a prompt.

## Dev

```bash
npm i
npm test          # unit tests
npm run smoke     # integration: spawns real opencode serve (one tiny prompt)
npm run build
```

## Roadmap

- Multi-machine routing (per-machine Slack apps from a manifest template)
- Homebrew tap / single binaries
- Richer diff/file previews
- Improved statusline and other modals (via Slack).
- Expansion to other platforms (i.e. Discord, Telegram) and agents (i.e. Codex)

## License

MIT
