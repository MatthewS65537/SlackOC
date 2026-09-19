# SlackOC setup guide

End-to-end: from zero to controlling OpenCode from Slack in ~10 minutes.

## 0. Prerequisites

- Node.js ≥ 20 (`node -v`)
- OpenCode ≥ 1.18 installed and authenticated (`opencode --version`, run `opencode serve` successfully once / have providers configured). Check with `slackoc doctor` later.

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

The periodic catch-up timer runs every 60 seconds. Each pass rotates through up
to ten retained threads: normally eight active within the last 12 hours and two
older threads, lending unused slots between those groups. Failures advance the
rotation too. History pagination is bounded to two pages per thread and twenty
pages per pass, so large histories can take multiple passes. Concurrent triggers
are coalesced rather than overlapping.

This is a polling policy, not a one-minute delivery guarantee. Recovery depends
on the machine being awake, network/API availability, retained bindings/history,
queue pressure and the number of candidates. Messages before a migrated history
cursor or in unknown threads may not be recovered. Ambiguous submissions retain
evidence instead of being blindly resubmitted; a crash between remote acceptance
and local persistence still cannot guarantee exactly-once execution.

## Troubleshooting

| symptom | fix |
|---|---|
| `Config not found` | run `slackoc init` |
| Bot silent | `slackoc doctor` — most likely a token transposition; also confirm you're DMing as the paired owner |
| Bot answers the first @mention but ignores thread replies in a channel | `/invite @SlackOC` in that channel — the bot only hears channel threads it's invited to (DMs always work) |
| A thread goes quiet (outbound posts worked, then nothing inbound) | `\logs` — look for missing `in:` lines and socket warnings. History polling fairly rotates a bounded set of retained recent/older threads each pass; API failures, queueing and sleep can delay recovery. It cannot promise every message or exactly-once execution. Stop any second bridge using the same Slack app |
| No ✅/❌ reactions on your messages | reinstall the app (OAuth & Permissions → Reinstall) so the `reactions:write` scope applies |
| Attachments you send fail with `couldn't attach … HTTP 403` | reinstall the app — inbound files need the `files:read` scope added in the current manifest |
| A run hung at ⏳ forever | `\restart` in the thread restarts that project's opencode server; also check `\logs` for server death lines |
| Answers arrive late in tool-heavy runs | Posts share paced per-channel queues. Completion reconciliation attempts to fetch missed output; inspect `\logs` for delivery failures if the answer still does not arrive |
| Thread went quiet after `\hush` | `\hush` again to re-enable, or just @-mention the bot |
| `slackoc already running` | Use `slackoc stop` for the intended config home, then check service status. Do not remove the pidfile while that bridge is alive |
| Service won't start | `slackoc service status`, then inspect its log. Verify saved Node/CLI paths and cwd exist, provider auth is saved, and no manual bridge is running. A GUI login session is required |
| OpenCode server won't spawn | run `opencode serve --hostname 127.0.0.1 --port 0` manually in that project dir and read the error |
| Everything else | rerun with verbose server logging: see the bridge's stderr (server output is logged) |

## Where things live

- `~/.config/slackoc/config.json` — tokens + your user id (0600)
- `~/.config/slackoc/state.json` — thread⇄session bindings + known projects (0600)
- `~/.config/slackoc/slackoc.pid` — running bridge pid
- `~/.config/slackoc/logs/bridge.log` (+ `.1`, `.2`) — managed service logs, bounded to 15 MiB total
- `~/Library/LaunchAgents/com.slackoc.bridge.plist` — macOS service definition

With `SLACKOC_HOME=/some/parent`, config/state/pid/logs live under
`/some/parent/slackoc/`; the LaunchAgent still lives under your user home.
