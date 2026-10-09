/**
 * Favorited models, read from the file the OpenCode TUI writes when you press
 * ctrl+f in its model dialog: `<state>/opencode/model.json` →
 * `{ favorite: [{ providerID, modelID }], … }`. Newest favorite first. The
 * server API doesn't expose favorites, so we read the file on every call (a
 * few KB), and stars added in the TUI show up immediately. Like the TUI,
 * favorites that don't resolve against the live catalog are dropped.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProvidersInfo } from "./client.js";
import { truncate } from "../util.js";

export interface CatalogModel {
  /** "provider/model" — what `\model` takes. */
  id: string;
  name: string;
  provider: string;
  favorite: boolean;
}

export function favoritesPath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "model.json");
}

/** "provider/model" ids in file order; [] when the file is missing or malformed. */
export function readFavorites(path = favoritesPath()): string[] {
  try {
    const fav = (JSON.parse(readFileSync(path, "utf8")) as { favorite?: unknown }).favorite;
    if (!Array.isArray(fav)) return [];
    return fav.flatMap((f: { providerID?: unknown; modelID?: unknown }) =>
      typeof f?.providerID === "string" && typeof f.modelID === "string" ? [`${f.providerID}/${f.modelID}`] : []);
  } catch {
    return [];
  }
}

/** The catalog with favorites first (favorites file order), then everything else in catalog order. */
export function orderedModels(info: ProvidersInfo, favorites: string[]): CatalogModel[] {
  const all = info.providers.flatMap(p => Object.entries(p.models).map(([mid, m]) =>
    ({ id: `${p.id}/${mid}`, name: m.name || mid, provider: p.id, favorite: false })));
  const byId = new Map(all.map(m => [m.id, m]));
  const favs = [...new Set(favorites)].flatMap(id => {
    const m = byId.get(id);
    return m ? [{ ...m, favorite: true }] : [];
  });
  const favIds = new Set(favs.map(m => m.id));
  return [...favs, ...all.filter(m => !favIds.has(m.id))];
}

/** Slack's limit on options per external_select response. */
const MAX_OPTIONS = 100;

/**
 * external_select `option_groups` for the `\model` search card. Case-insensitive
 * match on the "provider/model" id and the display name; ★ Favorites first.
 */
export function modelOptionGroups(models: CatalogModel[], query: string): unknown[] {
  const q = query.trim().toLowerCase();
  const hits = models
    .filter(m => m.id.length <= 142) // option values cap at 150 chars; one bad option fails the whole response
    .filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .slice(0, MAX_OPTIONS);
  const groups = [
    { label: "★ Favorites", models: hits.filter(m => m.favorite) },
    { label: q ? "Matches" : "All models", models: hits.filter(m => !m.favorite) },
  ];
  return groups.filter(g => g.models.length).map(g => ({
    label: { type: "plain_text", text: g.label },
    options: g.models.map(modelOption),
  }));
}

/** One option: "Name · provider" → `\model provider/model`. */
export function modelOption(m: Pick<CatalogModel, "id" | "name" | "provider">): unknown {
  return { text: { type: "plain_text", text: truncate(`${m.name} · ${m.provider}`, 75) }, value: `\\model ${m.id}` };
}
