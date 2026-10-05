import { registerCommand } from "./registry.js";

registerCommand({
  name: "schedule",
  usage: "\\schedule [add|pause|resume|run|history|remove|cancel] [id]",
  summary: "Manage daily/weekly reports",
  detail: "Creation previews the project, prompt, destination and time zone before confirmation.",
  async run(ctx, args) {
    if (!ctx.schedules) throw new Error("scheduled reports are unavailable — check bridge logs");
    await ctx.schedules.run(ctx, args);
  },
});
