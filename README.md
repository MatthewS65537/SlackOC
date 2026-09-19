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
- **Tool visibility by default** — `\verbose full|on|off`; compact tool batches flush after 1.5 seconds or at a size threshold, and before answers. Paths, commands, and search patterns use inline code; shell descriptions stay concise. `full` adds output snippets. Slack queueing or rate limits may delay delivery
- **Clear progress** — literal ⏳/⌛ characters, elapsed time, waiting-for-answer/permission and connection states; the indicator moves below new content, with bounded retry backoff when Slack is unavailable
- **Markdown answers render properly** — GFM → Slack mrkdwn conversion (bold, lists, links, headings); fenced code stays code
- **Image support, both ways** — attach a screenshot (or any text/PDF/JSON file ≤8MB) to your message and the model sees it; images over ~1MB are auto-compressed to stay under provider request-size limits; images the model produces are posted back into the thread
- **Approval buttons** — Approve once / Always allow / Deny, resolving OpenCode's permission requests in place — mirrored to your DMs, so a blocked run pages you on your phone
- **Notifications that reach you** — failures DM the owner by default; `\notify on` adds a DM when each run finishes (with a one-tap 📄 View diff button); a 3-minute stall pages you once
- **Failure recovery** — an `opencode serve` that dies mid-run fails the thread visibly; periodic reconciliation checks polled session state when completion events are lost. Recovery depends on connectivity and evidence of completion; `\restart` rescues a wedged server; idle servers auto-stop after 30 minutes
- **Status board in your pocket** — `\status` lists runs in flight (elapsed, queued, thread links); markdown tables from the model render as aligned code blocks
- **Restart-safe** — a run interrupted by a bridge restart gets its ❌ and a clear notice instead of a frozen "working…" message
- **Receipt acknowledgment** — accepted prompts attempt a 👀 reaction immediately, cleared when ✅/❌ lands; network/API failures can delay acknowledgments
- **Lost-message catch-up** — periodic history polling rotates through retained threads, including older threads, with a bounded per-pass budget. Busy workspaces, API failures, queueing and sleep can delay recovery; unseen threads or messages outside retained history may not be recoverable. Ambiguous submissions are not blindly replayed, and exactly-once execution across crashes is not guaranteed. Socket diagnostics land in `\logs`
- **Persistent logs** — managed stdout, stderr and bridge logs share `~/.config/slackoc/logs/bridge.log`, bounded to 5 MiB plus two 5 MiB backups. Foreground logging remains at `~/.config/slackoc/bridge.log`; `\logs --follow` streams the in-memory log from Slack
- **macOS background service** — `slackoc service install` writes a per-user LaunchAgent; `service start` activates it. It starts at login and restarts after crashes while the user is logged in and the Mac is awake. `service stop` disables it until explicitly started again
- **Prioritized `\` commands, even mid-run** — outbound Slack calls ride a per-channel queue where interactive traffic (command answers, approval prompts, acks) jumps ahead of queued background traffic; an in-flight operation or Slack rate limit can still delay a reply
- **Progress bar pinned to the bottom** — the ⏳ indicator re-homes itself below every streamed message, so a long-running task's live status is always the last thing on screen
- **Multi-project** — not locked to one folder: `\projects`, `\cd /path`, `\new /path`
- **Native command passthrough** — `\cmd <opencode command>`, plus model (`\model <#>`) and agent (`\agent <#|name>`) swaps
- **Owner-only security** — the bot obeys exactly one paired Slack user ID; everyone else is ignored

Backslash commands run inside Slack but are invisible to the workspace — they never collide with Slack slash commands. Full list: send `\help` to the bot after setup.

## Setup (5–10 min)

1. Install (Node ≥ 20): `curl -fsSL https://raw.githubusercontent.com/MatthewS65537/SlackOC/main/install.sh | bash` — and have `opencode` ≥ 1.18 on your box.
2. `slackoc init` — guided: create the Slack app from the bundled manifest, install it, paste the bot token (`xoxb-`) and app-level token (`xapp-`), enter your Slack member ID. Both tokens are validated live against Slack; the member ID is verified (`users:read` scope — already in the manifest). Non-interactive flags for CI: `--bot-token --app-token --owner [--dir]`
3. `slackoc doctor` — sanity check
4. `slackoc start` — bridge online in the foreground. For managed macOS operation, choose a default project directory and use the service commands below
5. Open Slack → DM your bot → prompt

Details & troubleshooting: [docs/SETUP.md](docs/SETUP.md).

### macOS service

```bash
slackoc service install --dir /absolute/default/project  # writes only; defaults to install cwd
slackoc service start
slackoc service status
slackoc service stop       # disables login/crash restart, then unloads
slackoc service uninstall  # also stops; retains config, state and logs
```

Stop an existing foreground bridge before `service start`. Ordinary `slackoc stop`
also disables/unloads a managed bridge. To change the saved directory, PATH, Node/CLI
location or keep-awake option, stop, reinstall, then start the service.

Optional: `slackoc service install --dir /absolute/default/project --keep-awake true`
prevents **idle system sleep** while the bridge runs; `false` is the default.
This does not keep the display on or guarantee availability with a closed lid,
after logout, while offline, or when powered off. Continuous remote use needs an
appropriately configured, awake host.

The service stores only a small environment whitelist; provider credentials that
exist only in your shell need saved OpenCode configuration/auth. Slack tokens stay
in SlackOC's config file. See [service setup details](docs/SETUP.md#macos-background-service).

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
| `\logs --follow [filter]` | stream new in-memory log lines into the thread for 30s; managed persistent log: `~/.config/slackoc/logs/bridge.log` |
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
