// Favourite folders of each mailbox: a short list shown under the mailbox's name even
// when the mailbox is folded. Kept by account and folder name between launches
// (`depesha.sidebar.favourites`), in the order they were added. A folder is matched by
// its exact name only: a folder renamed or deleted on the server shows as unavailable,
// never as some other folder with a similar name.

/** A favourite as kept: the server name, and how it read when added, for when it is gone.
 *  `kind` tells a folder from a label (#42): a label favourite is its saved search. */
export interface Favourite {
  name: string;
  display: string;
  delimiter: string | null;
  kind?: "folder" | "label";
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
        .filter((f): f is Favourite => !!f && typeof f.name === "string" && !seen.has(`${f.kind ?? "folder"}\u0000${f.name}`) && !!seen.add(`${f.kind ?? "folder"}\u0000${f.name}`))
        .map((f) => ({
          name: f.name,
          display: typeof f.display === "string" ? f.display : f.name,
          delimiter: f.delimiter ?? null,
          kind: f.kind === "label" ? "label" : "folder",
        }));
    }
    return out;
  } catch {
    // A broken stored list is read as empty.
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

const key = (account: string, kind: "folder" | "label", name: string) => `${account}\u0000${kind}\u0000${name}`;

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
  has(account: string, name: string, kind: "folder" | "label" = "folder"): boolean {
    return !this.leaving[key(account, kind, name)] && this.of(account).some((f) => f.name === name && (f.kind ?? "folder") === kind);
  }

  isLeaving(account: string, name: string, kind: "folder" | "label" = "folder"): boolean {
    return !!this.leaving[key(account, kind, name)];
  }

  add(account: string, folder: Favourite) {
    const kind = folder.kind ?? "folder";
    const k = key(account, kind, folder.name);
    if (this.leaving[k]) {
      this.cancel(k);
      this.save();
      return;
    }
    if (this.of(account).some((f) => f.name === folder.name && (f.kind ?? "folder") === kind)) return;
    this.all[account] = [...this.of(account), { name: folder.name, display: folder.display, delimiter: folder.delimiter, kind }];
    this.save();
  }

  /** Wherever unstarred, the row of the block stays and fades, so neither the rows after it nor
   *  the tree below slide under the pointer; starring it again meanwhile keeps it. The unstar is
   *  saved at once: were the window closed mid-fade, the folder must not be back next launch. */
  remove(account: string, name: string, kind: "folder" | "label" = "folder") {
    const k = key(account, kind, name);
    if (!this.of(account).some((f) => f.name === name && (f.kind ?? "folder") === kind)) return;
    if (this.leaving[k]) return;
    this.leaving[k] = true;
    this.save();
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        delete this.leaving[k];
        this.drop(account, name, kind);
      }, FADE_MS),
    );
  }

  /** The star: adds, removes, and a second press on a fading row keeps it. */
  toggle(account: string, folder: Favourite) {
    const kind = folder.kind ?? "folder";
    if (this.has(account, folder.name, kind)) this.remove(account, folder.name, kind);
    else this.add(account, folder);
  }

  private cancel(k: string) {
    const timer = this.timers.get(k);
    if (timer) clearTimeout(timer);
    this.timers.delete(k);
    delete this.leaving[k];
  }

  private drop(account: string, name: string, kind: "folder" | "label" = "folder") {
    this.onleave?.(account, name);
    const rest = this.of(account).filter((f) => !(f.name === name && (f.kind ?? "folder") === kind));
    if (rest.length) this.all[account] = rest;
    else delete this.all[account];
    this.save();
  }

  /** The favourites as kept, without the rows fading out: an unstar is saved the moment it
   *  is made, so closing the window mid-fade cannot bring the folder back. */
  private save() {
    const kept: Record<string, Favourite[]> = {};
    for (const [account, list] of Object.entries(this.all)) {
      const rest = list.filter((f) => !this.leaving[key(account, f.kind ?? "folder", f.name)]);
      if (rest.length) kept[account] = rest;
    }
    this.storage.set(JSON.stringify(kept));
  }
}

const KEY = "depesha.sidebar.favourites";

export const favourites = new Favourites({
  get: () => (typeof localStorage === "undefined" ? null : localStorage.getItem(KEY)),
  set: (v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, v);
  },
});
