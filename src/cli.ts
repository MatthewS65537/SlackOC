import type { InitOptions } from "./init.js";
import { runServiceCommand } from "./service.js";
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
  slackoc stop              stop the running bridge (disable its service if managed)
  slackoc service install   write a macOS LaunchAgent (does not start it)
      --dir </abs/path>     saved default project (default: install cwd)
      --keep-awake <bool>   explicit true/false; prevent idle sleep (default: false)
  slackoc service start     enable and load the installed service
  slackoc service stop      disable and unload the service
  slackoc service status    installation, process, cwd and log diagnostics
  slackoc service uninstall stop and remove only the service definition
  slackoc daemon install    legacy: systemd on Linux; alias for service on macOS
      --dir <path>          project dir the service binds (default: cwd)
  slackoc daemon status     is the service loaded/active?
  slackoc daemon uninstall  remove the service
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
      const { runInit } = await import("./init.js");
      const opts: InitOptions = {};
      if (flags["bot-token"]) opts.botToken = flags["bot-token"];
      if (flags["app-token"]) opts.appToken = flags["app-token"];
      if (flags.owner) opts.ownerId = flags.owner;
      if (flags.dir) opts.defaultDir = flags.dir;
      await runInit(opts);
      break;
    }
    case "start": {
      parseFlags(rest, []);
      const { startBridge } = await import("./start.js");
      await startBridge({ cwd: process.cwd() });
      break;
    }
    case "stop": {
      parseFlags(rest, []);
      const { stopBridge } = await import("./start.js");
      await stopBridge();
      break;
    }
    case "service":
      await runServiceCommand(rest);
      break;
    case "daemon": {
      if (process.platform === "darwin") {
        console.error("On macOS, daemon is a legacy alias for service; install only writes configuration. Use service start to activate.");
        await runServiceCommand(rest);
        break;
      }
      const sub = rest[0];
      const flags = parseFlags(rest.slice(1), ["dir"]);
      const { daemonInstall, daemonStatus, daemonUninstall, installedWorkdir } = await import("./daemon.js");
      if (sub === "install") {
        process.exitCode = await daemonInstall(flags.dir ?? process.cwd());
      } else if (sub === "uninstall") {
        process.exitCode = await daemonUninstall();
      } else if (sub === "status") {
        const wd = installedWorkdir();
        if (wd) console.log(`workdir: ${wd}`);
        process.exitCode = await daemonStatus();
      } else {
        console.error("usage: slackoc daemon install [--dir <path>] | status | uninstall");
        process.exitCode = 2;
      }
      break;
    }
    case "doctor": {
      parseFlags(rest, []);
      const { runDoctor } = await import("./doctor.js");
      process.exitCode = await runDoctor();
      break;
    }
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
