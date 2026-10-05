# SlackOC setup guide

End-to-end: from zero to controlling OpenCode from Slack in ~10 minutes.

## 0. Prerequisites

- Node.js ≥ 20 (`node -v`)
- OpenCode V2 ≥ 2.0.12 installed and authenticated (`opencode --version`, `opencode service status`, and providers configured). SlackOC uses the shared background service. Check with `slackoc doctor` later.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/MatthewS65537/SlackOC/main/install.sh | bash
```

The script downloads the repo tarball, builds it, and installs the `slackoc`
CLI into your global npm bin.

## 2. Create your Slack app (one time)

1. Go to <https://api.slack.com/apps> → **Create New App → From a manifest**
2. Choose your workspace.
3. Paste the JSON between the markers that `slackoc init` prints (also at
   `manifest/slack-app-manifest.json` in the repo/package). Feel free to
   rename the app and set an icon — it's *your* app.
4. **Install the app to your workspace in OAuth & Permissions.**
5. Under **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).
6. Under **Basic Information → App-Level Tokens → Generate Token and Scopes**:
   add scope **`connections:write`**, name it anything, copy the token (`xapp-…`).

> Why two tokens? The bot token calls the Slack API. The app-level token opens
> the Socket Mode connection that receives events — outbound-only, so no
> webhook URL, no tunnels.

## 3. Pair yourself as owner

Slack → open **your profile** → **⋯ (More)** → **Copy member ID** (`U…`).
This is the *only* user the bot will obey.

## 4. Run init & doctor

```bash
slackoc init            # guided: validates BOTH tokens live and verifies your member ID
slackoc doctor          # all checks should pass
```

Non-interactive (CI / scripted setup):

```bash
slackoc init \
  --bot-token xoxb-… --app-token xapp-… --owner U… [--dir /abs/project]
```

## 5. Start

```bash
slackoc start
```

Then in Slack: DM the bot anything, or `@mention` it in a channel where it's
invited (`/invite @slackoc`). The first message in a thread starts a session in
the *current project*; replies continue it.

Multiple projects: `\cd /abs/path`, or bind one thread via `\new /abs/path`.

### macOS background service

Run these commands as your normal logged-in user, without `sudo`:

```bash
slackoc service install --dir /absolute/default/project
slackoc service start
slackoc service status
```

Installation **writes configuration only**. If `--dir` is omitted, the install
command's current directory is saved. Paths containing spaces must be quoted.
Choose the directory deliberately: it becomes the default project at every boot.
The service uses absolute Node/CLI paths and a saved PATH to find `opencode`.
Install from the built CLI, not `npm run dev`.

The per-user LaunchAgent is `~/Library/LaunchAgents/com.slackoc.bridge.plist`.
Once started, it runs at subsequent GUI logins and launchd restarts it after exits,
with throttling. Closing the terminal does not stop it. This requires an awake,
logged-in Mac with network access; it does not run through logout.

```bash
slackoc service stop        # disable persistently, then unload (no restart loop)
slackoc service uninstall   # stop and remove this definition; keep data and logs
```

Ordinary `slackoc stop` recognizes managed ownership and takes the service-stop
path. Stop a manual bridge before activating the service; a live or incomplete
pidfile blocks activation. The bridge also claims its pidfile before connecting to
Slack. Use the same `SLACKOC_HOME` for all commands: its value is a **parent**
directory, with `slackoc/` appended. Separate config homes or machines with the
same Slack app can still compete for Socket Mode events; local pidfiles cannot
detect every such instance.

To change options, run `service stop`, then `service install` with the new options,
then `service start`. Reinstall after moving the CLI or changing Node/PATH. Repeated
start on a loaded job does not restart it. Status distinguishes installed, loaded,
and running; it shows the bridge and supervisor PIDs, saved cwd, log location,
keep-awake option, Node/CLI paths and config directory. A live PID does not prove
Slack connectivity: inspect the log for startup/authentication failures.

Only `HOME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, and an explicit `SLACKOC_HOME`
override are preserved. Slack tokens remain in `config.json`. If OpenCode providers
depend on shell-only environment variables, move that setup into OpenCode's saved
configuration/auth before starting; the installer reports this limitation.

Optional idle-sleep prevention (explicit boolean value required):

```bash
slackoc service install --dir "/absolute/default project" --keep-awake true
```

The default is `--keep-awake false`. Enabled mode runs `caffeinate -i -w <bridge-pid>`;
its assertion ends on shutdown or a bridge crash. It prevents idle system sleep,
not display sleep, lid-closed sleep, logout, power loss or loss of connectivity.

Managed stdout/stderr and bridge logs are captured by a supervisor in
`CONFIG_DIR/logs/bridge.log` (normally `~/.config/slackoc/logs/bridge.log`). Files
are mode `0600` and the log directory is `0700`. Rotation is bounded during the
run: the active file plus `.1` and `.2`, each at most 5 MiB. Oldest bytes are
discarded as logs rotate. The supervisor is launchd's process; the bridge PID is
reported separately. Foreground mode retains its existing `CONFIG_DIR/bridge.log`.

**Legacy daemon migration:** on macOS, `daemon` is now an alias for `service`,
including install's write-only behavior. Both use the same label. Stop the old job
before installing the new definition; do not install a second consumer. The legacy
Linux systemd commands remain available as `slackoc daemon …`; the new `service`
commands are macOS-only.

### Recovery timing

The periodic catch-up timer requests a scan every 10 seconds; live Socket Mode
messages are handled immediately without waiting for this timer. Each pass rotates
through up to ten retained threads: normally eight with recent owner activity and two dormant
threads, lending unused slots between groups. All history reads are clamped to the
last **72 hours**. Dormant-thread reads discover fresh owner replies; bot chatter
and status updates do not reactivate a conversation. History pagination is bounded
to two pages per thread and twenty pages per pass. Recovery inspects the complete
bounded window before executing anything, so a later stop instruction suppresses
earlier backlog even when it appears on another page. Concurrent triggers coalesce.

History request starts are spaced at least 1.5 seconds apart across channels,
including retries (at most 40 starts/minute in steady state), independently of
outgoing messages and other API methods. Slack's `Retry-After` can extend that
wait. This targets internal customer-built apps' Tier 3 allowance; apps subject
to Slack's separate commercial one-request/minute limit remain constrained by
that limit. Boot and reconnect request recovery immediately.

Messages older than 72 hours are never automatically submitted, including delayed
Socket Mode deliveries. A recent missing prompt can recover once; accepted prompts
are not resubmitted, and stopped/rebound work is retired. A newer accepted prompt
overtaking an older missing message makes that older message ambiguous and holds it.
Historical state-changing commands and old approval replies are not automatically
executed. Send a fresh instruction after inspecting `\status` and the session.

This is a polling policy, not a ten-second delivery guarantee for every thread.
Recovery depends on the machine being awake, network/API availability, retained
bindings/history, queue pressure, acceptance reconciliation, and the number of
candidates. Messages before a migrated history cursor or in unknown threads may
not be recovered. Ambiguous submissions retain
evidence instead of being blindly resubmitted; a crash between remote acceptance
and local persistence still cannot guarantee exactly-once execution.

### Permission requests

Native approval buttons are the primary UI, delivered to the original thread and
your owner DM independently. If Slack rejects the card payload, the bridge sends
a separate text-only request with exact commands:

```
\permissions
\permission <request-id> once
\permission <request-id> deny
\permission <request-id> always
```

Only the paired owner can respond. In a thread, the ID must belong to that thread;
the owner DM can address a unique tracked request across projects. Ordinary “yes”
messages and reactions do not approve tools. The original request is checked
against OpenCode before responding, and concurrent button/text answers are locked.
After an uncertain reply, the next attempt reconciles the server state first and
may ask for a fresh explicit decision rather than sending a duplicate.

Pending-interaction polling runs independently every 30 seconds and on reconnect.
Delivery errors and unconfirmed replies appear in `\permissions`. Unknown post
outcomes are reconciled from bot-authored history; a bounded duplicate notice is
possible when that history is unavailable. Full Slack outages prevent immediate
delivery, but pending requests are retained. This UI fix needs no app reinstall.

## Question cards

Each next question gets a fresh card at the bottom of its session thread and
owner-DM mirror. Superseded cards are deleted silently after the replacement is
confirmed; selecting multiple options and paging through choices update the
current card without moving the buttons.
When allowed by the form, **Type your own answer** opens a multiline popup.
Use `\questions` to bring a buried pending question back to the bottom.

New-card posts use durable presentation identities. If Slack might have accepted
a post but its response was lost, the bridge checks bot-authored history instead
of blindly posting again. Old buttons and popups cannot answer a later card.
Progress keeps updating in place above pending questions, then resumes normal
bottom placement when they clear. This does not continuously chase every new
thread message or force Slack's viewport to scroll.

## Scheduled reports

1. In Slack, send `\schedule add` and click **Create report**.
2. Set the 24-hour start time, explicit IANA time zone, selected weekdays, saved
   project, prompt/sources, and destination (`dm` or an invited channel ID).
3. Review the preview, then **Create schedule**. This authorizes recurring model
   calls; merely opening or previewing the form creates nothing.

Use `\schedule` to list IDs and next starts, `\schedule pause <id>` / `resume <id>`
for future work, and `\schedule run <id>` for an explicit manual occurrence.
`\schedule history [id]` shows run IDs and outcomes. Cancel one occurrence with
`\schedule cancel <run-id>` or `\stop` in its private approval-context thread.
Removing a definition with `\schedule remove <id>` retains run history and does
not cancel active work. Create a replacement definition to change its settings.

The start time triggers generation, not guaranteed delivery. Keep the Mac and
bridge awake; see the managed-service section for optional idle-sleep prevention.
Only the latest missed occurrence within two hours is eligible after downtime,
and overlapping occurrences are skipped rather than queued indefinitely. New and
resumed schedules begin in the future. One scheduled report executes at a time.
Repeated DST times use the first occurrence only. The recurrence library shifts
full-hour spring-gap times forward; half-hour gaps can skip an occurrence.

Reports use a fresh session with restrictive session permissions: shell, edits,
subagents, skills, Code Mode and unknown/MCP tools are denied. File/web reads and
searches are supported; .env/external-directory approval and questions remain
interactive in your owner DM. A private status message provides that context;
public destinations receive final report content only. Runtime limits (1–60
minutes, default 15) include waiting for answers. The reported session remains
available for follow-up replies and transcript inspection.

Scheduled question cards use the same recoverable UI and private bottom-placement
behavior. If a card's delivery remains unconfirmed, use `\questions` to check its
evidence, inspect history/logs, or cancel the occurrence; the runtime deadline
also bounds waiting.

The versioned `schedules.json` file alongside `state.json` stores definitions,
bounded completed output and durable execution/delivery evidence with mode 0600.
Do not delete it to clear an uncertain run: an external effect may already have
happened. Inspect history/session evidence and cancel the owned run if appropriate.
Ambiguous delivery is not automatically reposted. Corrupt scheduler state fails
closed while ordinary Slack interaction remains available; consult `\logs`.

## Agent file delivery

Install the standalone tool and its global skill from the SlackOC installation
directory (the folder containing `package.json`, `dist/` and `skills/`). Check for
existing destination files first; do not overwrite customized plugins or skills:

```bash
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/skills/slackoc-send-file
cp -n dist/file-plugin.js ~/.config/opencode/plugins/slackoc-files.js
cp -n skills/slackoc-send-file/SKILL.md ~/.config/opencode/skills/slackoc-send-file/SKILL.md
```

OpenCode V2 discovers both global directories automatically. Watched configuration
changes can reload them without restarting the service. If the tool is not listed,
check OpenCode's plugin diagnostics before considering a separately approved restart.
The OpenCode service's PATH must include the installed `slackoc` CLI, and its
`SLACKOC_HOME` must match the bridge when overridden.

Ask the agent **“Send this report here”**. The global `slackoc-send-file` skill
directs it to call `slackoc_send_file` with an absolute path and optional comment.
OpenCode supplies the actual executor session ID; the tool does not accept a
destination or session argument from the model. SlackOC sends only to that
session's existing Slack thread, including the same thread if the conversation
is already in a DM. **No new DM is opened and there is no DM fallback.**

The CLI backend is also available for explicit debugging:

```bash
slackoc send-file --file "/absolute/path/report.pdf" --session "ses_exact_session_id" \
  --comment "Here's the finished report."
```

Both `--file` and `--session` are mandatory. The command rejects missing, invalid,
stopped or ambiguous bindings and rechecks binding generation/intent before Slack
shares the uploaded file. It reads state without modifying it. A concurrent rebind
after the final check is not transactional with Slack; this is not an exactly-once
delivery guarantee.

One nonempty regular local file, at most **50 MiB**, is sent unchanged per call.
HTML is an HTML attachment, not an interactive page or an automatic PDF conversion.
Comments are limited to 2000 characters and escaped against Slack formatting and
mentions. Workspace file-type restrictions still apply. The upload budget is
120 seconds. Success prints a JSON receipt with `ok`, session, channel, parent
thread, Slack file ID, filename and byte count; failures exit nonzero.

The native tool uses the `slackoc.send_file` permission action. Do not bypass a
denied tool through a shell call or change global permissions just to send a file.
Restricted scheduled-report sessions keep their existing deny-by-default policy.
The CLI loads saved credentials internally, so the agent does not need tokens.
Missing `files:write` requires reinstalling the app with the current manifest.
Timeout/cancellation or uncertain completion may mean Slack already received the
file: **check the thread before authorizing another send**. Whole uploads are not
automatically retried.

## Troubleshooting

| symptom | fix |
|---|---|
| `Config not found` | run `slackoc init` |
| Bot silent | `slackoc doctor` — most likely a token transposition; also confirm you're DMing as the paired owner |
| Bot answers the first @mention but ignores thread replies in a channel | `/invite @SlackOC` in that channel — the bot only hears channel threads it's invited to (DMs always work) |
| A thread goes quiet (outbound posts worked, then nothing inbound) | `\logs` — look for missing `in:` lines and socket warnings. History polling fairly rotates a bounded set of retained recent/older threads each pass; API failures, queueing and sleep can delay recovery. It cannot promise every message or exactly-once execution. Stop any second bridge using the same Slack app |
| No ✅/❌ reactions on your messages | reinstall the app (OAuth & Permissions → Reinstall) so the `reactions:write` scope applies |
| Attachments you send fail with `couldn't attach … HTTP 403` | reinstall the app — inbound files need the `files:read` scope added in the current manifest |
| A run hung at ⏳ forever | Inspect `\status` and `\logs`. `\restart` rediscovers the shared V2 service and reconnects observation without stopping sessions or resubmitting prompts. It does not cancel a stuck model/tool; use `\stop` to cancel intentionally |
| Waiting for permission but no card | Send `\permissions` in that thread or your owner DM; answer using the exact request ID. Inspect `\logs permission` for access or delivery errors. Rejected cards should fall back to text |
| Old chat was unexpectedly resumed | Update and restart the bridge on the fixed build. Recovery has a hard 72-hour original-message ceiling; `\status` explains held/expired input. A fresh owner reply does not authorize replaying old backlog |
| Answers arrive late in tool-heavy runs | Posts share paced per-channel queues. Completion reconciliation attempts to fetch missed output; inspect `\logs` for delivery failures if the answer still does not arrive |
| Thread went quiet after `\hush` | `\hush` again to re-enable, or just @-mention the bot |
| `slackoc already running` | Use `slackoc stop` for the intended config home, then check service status. Do not remove the pidfile while that bridge is alive |
| Service won't start | `slackoc service status`, then inspect its log. Verify saved Node/CLI paths and cwd exist, provider auth is saved, and no manual bridge is running. A GUI login session is required |
| OpenCode service unavailable | Check `opencode --version` (V2 ≥2.0.12), `opencode service status`, and `opencode api get /api/info`; inspect OpenCode's own logs. SlackOC uses the shared service, not per-project child servers |
| File-send tool missing or CLI not found | Check the global plugin/skill paths above and the OpenCode service's PATH. Install the built files; do not guess another session or open a DM |
| File-send outcome uncertain | Check the active thread before retrying; the upload may have completed before its confirmation was lost |
| Everything else | Inspect `\logs` and the bridge log below; use `slackoc doctor` to check local prerequisites and Slack access. A failed or inconclusive scope probe is not proof that access is granted |

## Where things live

- `~/.config/slackoc/config.json` — tokens + your user id (0600)
- `~/.config/slackoc/state.json` — thread⇄session bindings + known projects (0600)
- `~/.config/slackoc/state.json.pre-recovery-v1` — one-time pre-migration state backup (0600), when upgrading legacy state
- `~/.config/slackoc/permissions.json` — durable approval delivery/response records (0600); preserves uncertain responses across restart
- `~/.config/slackoc/questions.json` — durable question drafts, delivery/UI revisions, resume identity and uncertain submissions (0600)
- `~/.config/slackoc/slackoc.pid` — running bridge pid
- `~/.config/slackoc/logs/bridge.log` (+ `.1`, `.2`) — managed service logs, bounded to 15 MiB total
- `~/.config/slackoc/bridge.log` — foreground bridge log
- `~/Library/LaunchAgents/com.slackoc.bridge.plist` — macOS service definition
- `~/.config/opencode/plugins/slackoc-files.js` — optional native current-session file-send tool
- `~/.config/opencode/skills/slackoc-send-file/SKILL.md` — optional globally discoverable sending instructions

With `SLACKOC_HOME=/some/parent`, config/state/pid/logs live under
`/some/parent/slackoc/`; the LaunchAgent still lives under your user home.
