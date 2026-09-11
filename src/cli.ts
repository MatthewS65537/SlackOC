import { runInit, type InitOptions } from "./init.js";
import { runDoctor } from "./doctor.js";
import { startBridge, stopBridge } from "./start.js";
import { parseFlags } from "./args.js";
import { VERSION } from "./version.js";

const HELP = `slackoc v${VERSION} — control your local OpenCode from Slack

Usage:
  slackoc init              first-time setup (Slack app, tokens, owner pairing)
      --bot-token <xoxb>    non-interactive: bot user OAuth token
      --app-token <xapp>    non-interactive: app-level token (connections:write)
      --owner <U…>          non-interactive: your Slack member ID
      --dir <path>          non-interactive: default project dir
  slackoc start             start the bridge (runs in foreground)
  slackoc stop              SIGTERM the running bridge
  slackoc doctor            sanity-check tokens + OpenCode install
  slackoc help              this text
  slackoc --version

In Slack (DM or @mention):
  <any natural language>    run OpenCode in the bound session
  \\help                    SlackOC command list (invisible to your workspace)
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  switch (cmd) {
    case "init": {
      const flags = parseFlags(rest, ["bot-token", "app-token", "owner", "dir"]);
      const opts: InitOptions = {};
      if (flags["bot-token"]) opts.botToken = flags["bot-token"];
      if (flags["app-token"]) opts.appToken = flags["app-token"];
      if (flags.owner) opts.ownerId = flags.owner;
      if (flags.dir) opts.defaultDir = flags.dir;
      await runInit(opts);
      break;
    }
    case "start":
      parseFlags(rest, []);
      await startBridge({ cwd: process.cwd() });
      break;
    case "stop":
      parseFlags(rest, []);
      await stopBridge();
      break;
    case "doctor":
      parseFlags(rest, []);
      process.exitCode = await runDoctor();
      break;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      console.log(HELP);
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
