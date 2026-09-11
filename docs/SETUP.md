# SlackOC setup guide

End-to-end: from zero to controlling OpenCode from Slack in ~10 minutes.

## 0. Prerequisites

- Node.js ≥ 20 (`node -v`)
- OpenCode ≥ 1.18 installed and authenticated (`opencode --version`, run `opencode serve` successfully once / have providers configured). Check with `slackoc doctor` later.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/matthewsu/SlackOC/main/install.sh | bash
```

The script downloads the repo tarball, builds it, and installs the `slackoc`
CLI into your global npm bin. (npm: `npm i -g slackoc` — coming soon.)

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

## Troubleshooting

| symptom | fix |
|---|---|
| `Config not found` | run `slackoc init` |
| Bot silent | `slackoc doctor` — most likely a token transposition; also confirm you're DMing as the paired owner |
| Bot answers the first @mention but ignores thread replies in a channel | `/invite @SlackOC` in that channel — the bot only hears channel threads it's invited to (DMs always work) |
| A thread goes quiet (outbound posts worked, then nothing inbound) | `\logs` — look for missing `in:` lines + socket warn lines (ping timeouts, reconnects). The catch-up sweep replays missed thread messages within ~1 min automatically; if it's a second bridge elsewhere running with the same app token, Socket Mode splits events between you — stop the other instance |
| No ✅/❌ reactions on your messages | reinstall the app (OAuth & Permissions → Reinstall) so the `reactions:write` scope applies |
| Attachments you send fail with `couldn't attach … HTTP 403` | reinstall the app — inbound files need the `files:read` scope added in the current manifest |
| A run hung at ⏳ forever | `\restart` in the thread restarts that project's opencode server; also check `\logs` for server death lines |
| Answers arrive late in tool-heavy runs | expected — posts are queued ~1/s to dodge Slack 429s; the answer is fetched from the session at completion, so it can't be silently lost |
| Thread went quiet after `\hush` | `\hush` again to re-enable, or just @-mention the bot |
| `slackoc already running` | `slackoc stop`, or delete `~/.config/slackoc/slackoc.pid` if stale |
| OpenCode server won't spawn | run `opencode serve --hostname 127.0.0.1 --port 0` manually in that project dir and read the error |
| Everything else | rerun with verbose server logging: see the bridge's stderr (server output is logged) |

## Where things live

- `~/.config/slackoc/config.json` — tokens + your user id (0600)
- `~/.config/slackoc/state.json` — thread⇄session bindings + known projects (0600)
- `~/.config/slackoc/slackoc.pid` — running bridge pid
