// The folder tree of a mailbox, from the hierarchy delimiter of each name: which
// folders have subfolders and which ones a folded branch hides. Pure, covered by folders.test.ts.

export interface TreeFolder {
  name: string;
  delimiter: string | null;
}

/** `child` lies anywhere under `parent`, not only one level down. */
export function isUnder(child: TreeFolder, parent: TreeFolder): boolean {
  const d = parent.delimiter;
  return !!d && child.name.length > parent.name.length && child.name.startsWith(parent.name + d);
}

/** Folders that have at least one subfolder among `all`. */
export function withChildren<T extends TreeFolder>(all: T[]): Set<string> {
  return new Set(all.filter((p) => all.some((c) => isUnder(c, p))).map((p) => p.name));
}

/** What stays in sight: the folders not under a folded one. */
export function unfolded<T extends TreeFolder>(all: T[], folded: (name: string) => boolean): T[] {
  const closed = all.filter((f) => folded(f.name));
  return all.filter((f) => !closed.some((p) => isUnder(f, p)));
}
