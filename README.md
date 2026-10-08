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
                                                                      │ authenticated client
                                                                      ▼
                                                     Shared OpenCode V2 service
                                                     (explicit project locations)
```

- **OpenCode V2 shared service**, discovered and authenticated through `@opencode/client`; explicit project locations and a long-lived event connection keep follow-ups warm. SlackOC does not spawn a separate server per project or stop the shared service when it exits.
- **One Slack thread ⇄ one OpenCode session.** New root messages create sessions; thread replies continue them.
- Streams via OpenCode's SSE event stream; Slack-safe rendering (live 1-second status ticker, chunked text, snippet files).

## Features

- **Remote prompting** from Slack DM or mention, with answers streamed into threads
- **Proactive threads with a mute** — once a thread has a session, replies are answered with no @ mention needed; `\hush` quiets the thread (an @ always wakes it)
- **Tool visibility by default** — `\verbose full|on|off`; compact tool batches flush after 1.5 seconds or at a size threshold, and before answers. Paths, commands, and search patterns use inline code; shell descriptions stay concise. `full` adds output snippets. Slack queueing or rate limits may delay delivery
- **Clear progress** — literal ⏳/⌛ characters, elapsed time, waiting-for-answer/permission and connection states; the indicator moves below new content, with bounded retry backoff when Slack is unavailable
- **Live answers** — reply text appears as the model writes it and is edited in place (about every 1.5s), splitting into continuation messages past Slack's length limit. `\stream off` reverts a thread to posting each part once complete
- **Markdown answers render properly** — GFM → Slack mrkdwn conversion (bold, lists, links, headings); fenced code stays code
- **Image support, both ways** — attach a screenshot (or any text/PDF/JSON file ≤8MB) to your message and the model sees it; images over ~1MB are auto-compressed to stay under provider request-size limits; images the model produces are posted back into the thread
- **Agent file delivery** — the global `slackoc_send_file` tool sends PDFs, screenshots, reports and other local files (≤50 MiB) to the agent's current Slack thread. Its session comes from OpenCode, not a guessed destination; there is no separate DM fallback. [Setup](docs/SETUP.md#agent-file-delivery)
- **Approval buttons with text backup** — ✓ Approve once / Always allow / ✕ Deny, independently delivered to the thread and owner DM. Rejected cards fall back to usable text commands; `\permissions` lists pending requests and `\permission <request-id> once|deny|always` answers them. Button/text races share one owner-only responder
- **Notifications that reach you** — failures DM the owner by default; `\notify on` adds a DM when each run finishes (with a one-tap 📄 View diff button); a 3-minute stall pages you once
- **Scheduled reports** — `\schedule add` previews a daily/weekly report before confirmation. Each occurrence uses a fresh, restricted OpenCode session and sends the finished report to your DM or an invited channel; durable records recover work without blindly repeating prompts or posts
- **Self-healing connections** — SlackOC owns Slack Socket Mode reconnection (jittered backoff up to 60s, wake detection), because the library abandons reconnecting after a single network error. Under the macOS service, 10 minutes without Slack exits so launchd restarts a clean process. Outbound calls retry brief network failures (posts only when the request provably never left the machine), and an offline brake pauses catch-up polling and repeated log lines while the network is down. The OpenCode event stream is resubscribed after 45s without keepalives
- **Failure recovery** — reconnects the event stream and reconciles authoritative session, inbox, form, and permission state when events are missed. `\restart` reconnects SlackOC without stopping the shared OpenCode service or resubmitting prompts.
- **Status board in your pocket** — `\status` lists runs in flight (elapsed, queued, thread links); markdown tables from the model render as aligned code blocks
- **Evidence-based restart recovery** — recent, exactly correlated active runs resume observation without another prompt. Completed tasks stay completed; interrupted or uncertain work is held for review. Old or canceled runs are retired silently
- **Receipt acknowledgment** — accepted prompts attempt a 👀 reaction immediately, cleared when ✅/❌ lands; network/API failures can delay acknowledgments
- **Lost-message catch-up, capped at 72 hours** — original owner-message timestamps determine age, never bot/status activity. Bounded polling inspects the recent backlog before execution, honors stop/rebind boundaries, and holds older input overtaken by newer instructions. Old threads can receive fresh replies without reviving old history. `\status` explains held/expired work; `\logs` includes recovery decisions. Connectivity and evidence still constrain recovery; exactly-once execution across crashes is not guaranteed
- **Persistent logs** — managed stdout, stderr and bridge logs share `~/.config/slackoc/logs/bridge.log`, bounded to 5 MiB plus two 5 MiB backups. Foreground logging remains at `~/.config/slackoc/bridge.log`; `\logs --follow` streams the in-memory log from Slack
- **macOS background service** — `slackoc service install` writes a per-user LaunchAgent; `service start` activates it. It starts at login and restarts after crashes while the user is logged in and the Mac is awake. `service stop` disables it until explicitly started again
- **Prioritized `\` commands, even mid-run** — outbound Slack calls ride a per-channel queue where interactive traffic (command answers, approval prompts, acks) jumps ahead of queued background traffic; an in-flight operation or Slack rate limit can still delay a reply
- **Bottom progress placement** — the ⏳ indicator moves below newly emitted content; overlapping moves coalesce, and busy queues or delivery failures can temporarily delay repositioning
- **Multi-project** — not locked to one folder: `\projects`, `\cd /path`, `\new /path`
- **Native command passthrough** — `\cmd <opencode command>`, plus model (`\model <#>`) and agent (`\agent <#|name>`) swaps
- **Owner-only security** — the bot obeys exactly one paired Slack user ID; everyone else is ignored

Backslash commands run inside Slack but are invisible to the workspace — they never collide with Slack slash commands. Full list: send `\help` to the bot after setup.

## Setup (5–10 min)

1. Install (Node ≥ 20): `curl -fsSL https://raw.githubusercontent.com/MatthewS65537/SlackOC/main/install.sh | bash` — and have OpenCode V2 ≥ 2.0.12 on your box.
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
| `\permissions` | pending approvals and thread/DM delivery state |
| `\permission <request-id> once\|deny\|always` | explicit text backup for approval buttons |
| `\project <name\|#>` | swap projects by fuzzy name (`\project cowork`) or listing number — same fresh teardown as `\cd` |
| `\new [dir]` `\cd <dir>` `\projects` | fresh session (previous one kept for `\resume`) / switch by path (`~` OK) / list projects |
| `\sessions [all\|<filter>]` `\resume <#\|id>` | list this project's sessions (or machine-wide with `all`/a filter) + bind a thread using stable picker numbers |
| `\watch <#\|id>` `\unwatch` | read-only mirror of a computer-driven session / stop mirroring; `\resume` enables prompting |
| `\history [n]` `\history <#\|id>` | display recent transcript turns without modifying session context; use `#N` for a picker number |
| `\summary [#\|id]` | opt-in AI catch-up summary using a temporary session; costs a model call, leaves the target context unchanged |
| `\agent <#\|name>` | swap OpenCode agent |
| `\diff` `\cmd …` | diff summary (`\diff full` adds the unified diff, snippet when long) / OpenCode native command passthrough |
| `\notify on\|off` | DM the owner when runs in this thread finish (failures + permission asks always DM) |
| `\schedule` `\schedule add` | list reports/next starts or open guided creation with explicit time-zone, project, prompt and destination confirmation |
| `\schedule pause\|resume\|run\|remove <id>` | manage future occurrences or request a manual run; pause/remove do not cancel active work |
| `\schedule history [id]` `\schedule cancel <run-id>` | inspect run outcomes or stop an owned report occurrence |
| `\logs [filter]` | recent bridge log lines, optionally substring-filtered (`\logs error`) — remote debugging without the console |
| `\logs --follow [filter]` | stream new in-memory log lines into the thread for 30s; managed persistent log: `~/.config/slackoc/logs/bridge.log` |
| `\restart` | rediscover the V2 service and reconnect event observation; retain running sessions |
| `\questions` | recover pending question cards and show their delivery status |

Questions use native Slack choice buttons and, when the form permits custom input,
**Type your own answer** opens a multiline text box. Saved drafts survive bridge
restart; failed card updates retry automatically. `\resume` recovers the selected
session's pending questions with fresh controls. Unconfirmed submissions require
status reconciliation before another send; fixed-choice forms still require a
listed option. Each next question is posted as a fresh card at the bottom of the
thread and owner DM; superseded cards are deleted silently after the new card is
confirmed. Multi-select toggles and choice pages stay in place. `\questions`
brings a buried pending card back down.
While a question is pending, its progress bar updates above it rather than
moving beneath the answer buttons.

### Scheduled reports

Send `\schedule add`, click **Create report**, and select a start time, IANA time
zone (for example `America/Los_Angeles`), days, saved project directory, report
prompt and `dm` or a channel ID. Review the preview and confirm. Selecting every
day makes a daily schedule; a subset makes it weekly. Invite the bot before using
a channel destination. Creating a schedule authorizes future model calls; no job
exists until confirmation.

The scheduled time is when generation **starts**, not a delivery deadline. Your
Mac and bridge must be awake and online. After sleep/restart, only the latest
missed occurrence within two hours can run; older work is skipped rather than
backlogged. One report executes at a time. Pause/resume starts with the next
future occurrence; manual runs use a separate run ID.

Repeated daylight-saving times run once, at the first occurrence. Missing local
times follow the recurrence library: full-hour spring gaps shift forward;
half-hour gaps can skip that day's occurrence. Choose an ordinary daytime time
if you want to avoid these transition-hour edge cases.

Reports can read/search files and fetch/search the web. Session-level permissions
deny shell, edits, subagents, Code Mode, skills and unknown/MCP tools. State your
information sources explicitly; this is not an automatic digest of every Slack
or OpenCode conversation. Sensitive-file/external-directory approval and question
requests route to a private owner-DM context. The runtime limit (default 15 minutes,
maximum 60) includes time waiting for your response. Public channels receive only
the finished report. Reply in the delivered report's thread to continue the session.

Definitions, output and run evidence are saved privately in
`~/.config/slackoc/schedules.json` (or your configured `SLACKOC_HOME`). If prompt
admission or Slack delivery is uncertain, the bridge reconciles available evidence
instead of blindly trying again. Inspect `\schedule history` and `\logs`; corrupt
scheduler state disables scheduled work without stopping ordinary conversations.

## Security model

- Owner-only: exactly one paired Slack user ID is obeyed (checked on every event, including button clicks).
- Tokens + state live at `~/.config/slackoc/`, mode `0600`, never logged.
- SlackOC authenticates to the local OpenCode V2 service; Slack Socket Mode needs no public HTTP endpoint. SlackOC does not expose its own inbound server.
- Unknown `\…` text is rejected as a command, never forwarded to OpenCode as a prompt.
- File sending uses the native current session's unique saved thread binding, with a recheck before Slack shares the upload. Missing/ambiguous/changed bindings fail closed. The native tool respects the `slackoc.send_file` permission action; upload credentials are loaded inside the CLI, never supplied by the model.

## Dev

```bash
npm i
npm test          # unit tests
npm run check
npm run smoke -- --no-model # live V2 forms/permissions in a temporary session
npm run smoke              # also runs two tiny model turns (provider cost)
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
