// The order of the palette: the best match first, and among equal matches the command
// used last. In an empty query the commands used recently lead. Recency survives a
// restart in the window's storage, like the sidebar's state: it is how this window is
// used, not a setting.

import { matches, type Command } from "@depesha/plugin-api";

export interface Storage {
  get(): string | null;
  set(value: string): void;
}

/** Commands remembered beyond these are forgotten, the least recent first. */
const KEEP = 100;

export class Recency {
  /** When each command was last run, ms, by id. */
  private used: Record<string, number> = {};

  constructor(private storage: Storage) {
    try {
      const saved = JSON.parse(storage.get() ?? "{}");
      if (saved && typeof saved === "object") {
        for (const [id, at] of Object.entries(saved)) if (typeof at === "number") this.used[id] = at;
      }
    } catch { // A broken saved list starts the ranking afresh.
      this.used = {};
    }
  }

  touch(id: string, now = Date.now()) {
    this.used[id] = now;
    const kept = Object.entries(this.used)
      .sort((a, b) => b[1] - a[1])
      .slice(0, KEEP);
    this.used = Object.fromEntries(kept);
    this.storage.set(JSON.stringify(this.used));
  }

  /** When the command was last run; 0 if never. */
  at(id: string): number {
    return this.used[id] ?? 0;
  }
}

/**
 * How well a title matches: -1 not at all (see `matches`); 1 when every word of the
 * query starts a word of the title; 2 when, besides, the query's first word starts
 * the title's first word ("arch" for "Archive" beats "Move to: Archive").
 */
export function matchQuality(title: string, query: string): number {
  if (!matches(title, query)) return -1;
  const first = query.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const word = title.toLowerCase().split(/[^\p{L}\d]+/u).find(Boolean) ?? "";
  return first && word.startsWith(first) ? 2 : 1;
}

/** `matchQuality` of a command; its synonyms count as more words of the title ("go people" finds «Go: contacts»). */
function commandQuality(c: Command, query: string): number {
  const q = matchQuality(c.title(), query);
  return q < 0 && c.synonyms && matches(`${c.title()} ${c.synonyms()}`, query) ? 1 : q;
}

/** The commands that match, best first, recent first among equals, then in their own order. */
export function rank(commands: Command[], query: string, recency: Pick<Recency, "at">): Command[] {
  return commands
    .map((c, i) => ({ c, i, q: query.trim() ? commandQuality(c, query) : 0, at: recency.at(c.id) }))
    .filter((x) => x.q >= 0)
    .sort((a, b) => b.q - a.q || b.at - a.at || a.i - b.i)
    .map((x) => x.c);
}

const KEY = "depesha.palette.recent";

export const recency = new Recency({
  get: () => (typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)),
  set: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, v);
  },
});
