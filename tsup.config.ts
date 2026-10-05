import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "file-plugin": "src/opencode/file-plugin.ts" },
  format: ["esm"],
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
});
