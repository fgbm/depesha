// Favourite folders of each mailbox: a short list shown under the mailbox's name even
// when the mailbox is folded. Kept by account and folder name between launches
// (`depesha.sidebar.favourites`), in the order they were added. A folder is matched by
// its exact name only: a folder renamed or deleted on the server shows as unavailable,
// never as some other folder with a similar name.

/** A favourite as kept: the server name, and how it read when added, for when it is gone. */
export interface Favourite {
  name: string;
  display: string;
  delimiter: string | null;
}

/** How long an unstarred row of the favourites stays in place, fading, before it goes. */
export const FADE_MS = 700;

type Storage = { get(): string | null; set(v: string): void };

export function readFavourites(raw: string | null): Record<string, Favourite[]> {
  try {
    const saved = JSON.parse(raw ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const out: Record<string, Favourite[]> = {};
    for (const [account, list] of Object.entries(saved)) {
      if (!Array.isArray(list)) continue;
      const seen = new Set<string>();
      out[account] = list
        .filter((f): f is Favourite => !!f && typeof f.name === "string" && !seen.has(f.name) && !!seen.add(f.name))
        .map((f) => ({ name: f.name, display: typeof f.display === "string" ? f.display : f.name, delimiter: f.delimiter ?? null }));
    }
    return out;
  } catch {
    return {};
  }
}

/** The folder's own name and the path above it, for a favourite shown out of its tree. */
export function splitPath(display: string, delimiter: string | null): { leaf: string; path: string } {
  if (!delimiter) return { leaf: display, path: "" };
  const parts = display.split(delimiter);
  // Children of INBOX on Dovecot-style servers sit under the mailbox itself in the tree.
  if (parts.length > 1 && parts[0].toUpperCase() === "INBOX") parts.shift();
  const leaf = parts.pop() ?? display;
  return { leaf, path: parts.join(" / ") };
}

/** Where focus goes when the row at `i` leaves a list: the next row, else the one before. */
export function neighbour<T>(list: T[], i: number): T | null {
  return list[i + 1] ?? list[i - 1] ?? null;
}

const key = (account: string, name: string) => `${account}\u0000${name}`;

export class Favourites {
  private all = $state<Record<string, Favourite[]>>({});
  /** Unstarred, still in the favourites block until their timer runs out. */
  private leaving = $state<Record<string, true>>({});
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Called right before a row leaves the block, while it is still in the page. */
  onleave: ((account: string, name: string) => void) | null = null;

  constructor(private storage: Storage) {
    this.all = readFavourites(storage.get());
  }

  /** The mailbox's favourites in the order added, rows still fading out included. */
  of(account: string): Favourite[] {
    return this.all[account] ?? [];
  }

  /** Starred: a row fading out of the block already shows an empty star. */
  has(account: string, name: string): boolean {
    return !this.leaving[key(account, name)] && this.of(account).some((f) => f.name === name);
  }

  isLeaving(account: string, name: string): boolean {
    return !!this.leaving[key(account, name)];
  }

  add(account: string, folder: Favourite) {
    const k = key(account, folder.name);
    if (this.leaving[k]) {
      this.cancel(k);
      return;
    }
    if (this.of(account).some((f) => f.name === folder.name)) return;
    this.all[account] = [...this.of(account), { name: folder.name, display: folder.display, delimiter: folder.delimiter }];
    this.save();
  }

  /** Wherever unstarred, the row of the block stays and fades, so neither the rows after it nor
   *  the tree below slide under the pointer; starring it again meanwhile keeps it. */
  remove(account: string, name: string) {
    const k = key(account, name);
    if (!this.of(account).some((f) => f.name === name)) return;
    if (this.leaving[k]) return;
    this.leaving[k] = true;
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        delete this.leaving[k];
        this.drop(account, name);
      }, FADE_MS),
    );
  }

  /** The star: adds, removes, and a second press on a fading row keeps it. */
  toggle(account: string, folder: Favourite) {
    if (this.has(account, folder.name)) this.remove(account, folder.name);
    else this.add(account, folder);
  }

  private cancel(k: string) {
    const timer = this.timers.get(k);
    if (timer) clearTimeout(timer);
    this.timers.delete(k);
    delete this.leaving[k];
  }

  private drop(account: string, name: string) {
    this.onleave?.(account, name);
    const rest = this.of(account).filter((f) => f.name !== name);
    if (rest.length) this.all[account] = rest;
    else delete this.all[account];
    this.save();
  }

  private save() {
    this.storage.set(JSON.stringify(this.all));
  }
}

const KEY = "depesha.sidebar.favourites";

export const favourites = new Favourites({
  get: () => (typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)),
  set: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, v);
  },
});
