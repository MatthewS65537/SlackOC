---
name: slackoc-send-file
description: Send an actual local file to the Slack thread the OpenCode agent is currently working in through SlackOC. Use whenever the user asks to send, attach, return, or deliver a PDF, report, screenshot, image, spreadsheet, archive, or other file here in Slack or via SlackOC. A filesystem path in an answer is not file delivery.
compatibility: OpenCode V2 with the SlackOC file-send plugin and installed slackoc CLI, configured SlackOC credentials, and an existing session-to-thread binding.
---

# Send a file in the active Slack thread

1. Finish creating the requested file. Use only the intended deliverable, not credentials, unrelated files, or an entire project directory. Use the appropriate document skill when creating a file; this skill only sends existing bytes.
2. Call the native **`slackoc_send_file`** tool with an absolute local file path and an optional short comment:

   ```json
   { "path": "/absolute/path/report.pdf", "comment": "Here's the finished report." }
   ```

   If tools are exposed through Code Mode, discover the registered tool and use its exact catalog signature rather than guessing a namespace.
3. Read the result. A successful receipt has `ok: true`, the current `sessionId`, `channelId`, parent `threadTs`, `fileId`, filename, and byte count. Only then say the file was sent in this thread. Do not return a native file-content part after sending: that can make SlackOC upload it a second time.

## Routing and permissions

The tool gets the real current session ID from OpenCode's executor context. SlackOC resolves that session's uniquely bound channel and parent thread. There is **no separate DM, destination selector, or fallback**. An unbound terminal session cannot send. A session already working in a DM thread sends into that same thread, not a new message elsewhere.

Do not guess a session from recent activity or search unrelated conversations. Do not ask for Slack tokens or read the SlackOC config to obtain credentials. Respect OpenCode permission denials; do not bypass a denied or missing tool with a shell upload or direct Slack API calls.

## Limits and failures

- One readable, nonempty regular local file per call, at most **50 MiB**. Paths must be absolute; URLs and directories are not accepted. Finish writing before sending; files changed during the read are rejected.
- Files are sent unchanged. HTML remains an HTML attachment, not an interactive Slack page or automatically converted PDF. If a PDF is requested, create the PDF first using the PDF skill, then send it.
- Comments are optional and limited to 2000 characters. SlackOC escapes Slack formatting/mentions in them.
- If delivery times out, is canceled, or has an uncertain completion, **do not automatically resend**. The file may already be in the thread. Explain the uncertainty and ask the user to check before authorizing another attempt.
- Missing/ambiguous/changed/stopped thread bindings fail closed. Reestablish the intended Slack session explicitly rather than editing saved state or falling back to a DM.
- Missing `files:write` requires reinstalling the Slack app with the current SlackOC manifest. Respect workspace file-type restrictions.

## Installation troubleshooting

The global files normally live at:

- `~/.config/opencode/plugins/slackoc-files.js` — native tool
- `~/.config/opencode/skills/slackoc-send-file/SKILL.md` — these instructions

The OpenCode service must find the installed `slackoc` command on its PATH and use the same `SLACKOC_HOME` as the bridge when overridden. That variable is a parent directory: SlackOC appends `slackoc/`. Report missing setup instead of installing/restarting services or changing permissions without approval.

The internal upload command is:

```sh
slackoc send-file --file "/absolute/path/report.pdf" --session "<native-current-session-id>"
```

The plugin supplies this ID automatically. This example is for setup/debugging, not a reason for the agent to infer an ID or bypass the native tool.
