/** Hand-rolled `--flag value` / `--flag=value` parser for the few flags we take. */
export function parseFlags(argv: string[], allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string" || !a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (!allowed.includes(name)) throw new Error(`unknown flag --${name} (see 'slackoc help')`);
    out[name] = eq > 0 ? a.slice(eq + 1) : (argv[++i] ?? "");
    if (!out[name]) throw new Error(`flag --${name} needs a value`);
  }
  return out;
}
