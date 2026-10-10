// The searches the user ran last, newest first: "Recent" in the search box suggestions.
// They take the place of saved searches: a ready query or a recent one is one click away
// and its text stays editable. Kept in the window's storage, like the sidebar's state.

export interface Storage {
  get(): string | null;
  set(value: string): void;
}

export const RECENT_MAX = 5;

export class RecentSearches {
  list = $state<string[]>([]);

  constructor(private storage: Storage) {
    try {
      const saved = JSON.parse(storage.get() ?? "[]");
      if (Array.isArray(saved)) this.list = saved.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX);
    } catch { // A broken stored list starts empty.
      this.list = [];
    }
  }

  /** The search was run on purpose (Enter, a suggestion, a result opened): it goes on top. */
  remember(text: string) {
    const t = text.trim().replace(/\s+/g, " ");
    if (!t) return;
    this.list = [t, ...this.list.filter((s) => s !== t)].slice(0, RECENT_MAX);
    this.storage.set(JSON.stringify(this.list));
  }
}

const KEY = "depesha.search.recent";

export const recentSearches = new RecentSearches({
  get: () => (typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)),
  set: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, v);
  },
});
