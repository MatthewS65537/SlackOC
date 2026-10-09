import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelOptionGroups, orderedModels, readFavorites } from "../src/opencode/favorites.js";
import type { ProvidersInfo } from "../src/opencode/client.js";

const dir = `${import.meta.dirname}/.fixtures/favorites`;
mkdirSync(dir, { recursive: true });
const file = (name: string, body: string) => { writeFileSync(`${dir}/${name}`, body); return `${dir}/${name}`; };

const info: ProvidersInfo = {
  providers: [
    { id: "anthropic", name: "Anthropic", models: {
      "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet" },
      "claude-opus": { id: "claude-opus", name: "Claude Opus" } } },
    { id: "openai", name: "OpenAI", models: { "gpt-6": { id: "gpt-6", name: "GPT-6" } } },
  ],
  default: {},
};

describe("readFavorites", () => {
  it("reads the TUI's favorite list in file order (newest first)", () => {
    const path = file("model.json", JSON.stringify({
      recent: [{ providerID: "anthropic", modelID: "claude-sonnet" }],
      favorite: [{ providerID: "openai", modelID: "gpt-6" }, { providerID: "anthropic", modelID: "claude-opus" }, { bad: 1 }],
    }));
    expect(readFavorites(path)).toEqual(["openai/gpt-6", "anthropic/claude-opus"]);
  });

  it("returns [] for a missing or malformed file", () => {
    expect(readFavorites(`${dir}/missing.json`)).toEqual([]);
    expect(readFavorites(file("bad.json", "{not json"))).toEqual([]);
  });
});

describe("orderedModels", () => {
  it("puts resolvable favorites first in favorite order, drops ones not in the catalog, never duplicates", () => {
    const models = orderedModels(info, ["openai/gpt-6", "gone/old-model", "anthropic/claude-opus", "openai/gpt-6"]);
    expect(models.map(m => [m.id, m.favorite])).toEqual([
      ["openai/gpt-6", true], ["anthropic/claude-opus", true], ["anthropic/claude-sonnet", false],
    ]);
  });
});

describe("modelOptionGroups", () => {
  const models = orderedModels(info, ["anthropic/claude-opus"]);
  const shown = (groups: any[]) => groups.map(g => [g.label.text, g.options.map((o: any) => o.value)]);

  it("shows ★ Favorites above everything else when the search is empty", () => {
    expect(shown(modelOptionGroups(models, ""))).toEqual([
      ["★ Favorites", ["\\model anthropic/claude-opus"]],
      ["All models", ["\\model anthropic/claude-sonnet", "\\model openai/gpt-6"]],
    ]);
    expect((modelOptionGroups(models, "") as any[])[0].options[0].text.text).toBe("Claude Opus · anthropic");
  });

  it("matches display names and ids, keeping favorites on top", () => {
    expect(shown(modelOptionGroups(models, "claude"))).toEqual([
      ["★ Favorites", ["\\model anthropic/claude-opus"]],
      ["Matches", ["\\model anthropic/claude-sonnet"]],
    ]);
    expect(shown(modelOptionGroups(models, "GPT-6"))).toEqual([["Matches", ["\\model openai/gpt-6"]]]);
    expect(modelOptionGroups(models, "zzz")).toEqual([]);
  });

  it("caps a response at Slack's 100 options", () => {
    const big: ProvidersInfo = { providers: [{ id: "p", name: "P", models: Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`m${i}`, { id: `m${i}`, name: `M${i}` }])) }], default: {} };
    const groups = modelOptionGroups(orderedModels(big, []), "") as any[];
    expect(groups.reduce((n, g) => n + g.options.length, 0)).toBe(100);
  });
});
