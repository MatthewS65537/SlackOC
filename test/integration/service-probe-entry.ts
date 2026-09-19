// Harmless launchd probe. This entry NEVER imports start.ts or connects to Slack.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../../src/config.js";
import { boundedShutdown, startManagedRuntime, superviseBridge } from "../../src/service.js";

if (process.argv[2] === "service") {
  await superviseBridge();
} else {
  writeFileSync(join(CONFIG_DIR, "slackoc.pid"), String(process.pid));
  const keepAwake = startManagedRuntime();
  console.log(`probe stdout ${process.pid}`);
  console.error(`probe stderr ${process.pid}`);
  appendFileSync(join(CONFIG_DIR, "probe-starts.log"), `${process.pid}\n`);
  const timer = setInterval(() => {}, 1_000);
  const stop = boundedShutdown(async () => { clearInterval(timer); keepAwake.close(); }, code => process.exit(code));
  process.on("SIGTERM", () => { void stop(); });
}
