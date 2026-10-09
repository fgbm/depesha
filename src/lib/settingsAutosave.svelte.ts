// Saving a setting the moment it is changed (#102, 1.7 Б): every row writes its own keys at
// once, the row says «saved», a toast offers to take the change back, and Ctrl+Z does the
// same for the last one. There is no «Save» and no question on leaving. The window gives the
// host (the app store); a page to come needs nothing here beyond calling `commit`.

import { t } from "./i18n.svelte";

export interface AutosaveHost {
  /** The settings as saved now. */
  settings(): Record<string, unknown>;
  /** Writes only these keys over what is saved. */
  patch(patch: Record<string, unknown>): Promise<void>;
  toast(text: string, action?: { label: string; run: () => void }): number;
  dismiss(id: number): void;
}

/** What a row shows about its last write. */
export type Mark = "saved" | "undone";

interface Change {
  row: string;
  /** The page the row stands on: Ctrl+Z takes back the changes of the page that is open, no other. */
  page: string;
  /** The row's name, for the toast that tells it was taken back. */
  label: string;
  before: Record<string, unknown>;
}

/** How long «Saved» stays at the row. */
const MARK_MS = 2200;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class SettingsAutosave {
  /** Row id → what to say at the row. */
  marks = $state<Record<string, Mark | undefined>>({});

  private stack: Change[] = [];
  private toastId: number | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The writes under way: a page that turns waits for them. */
  private pending = new Set<Promise<unknown>>();

  constructor(private host: AutosaveHost) {}

  /**
   * Writes the patch if it changes anything. `what` is the toast: the row and the change in
   * words («Reminders: 7 days → 14 days»); `label` is the row's name; `page` is the page the row
   * stands on. Returns whether anything was written.
   */
  async commit(row: string, patch: Record<string, unknown>, what: string, label = row, page = ""): Promise<boolean> {
    const saved = this.host.settings();
    const before: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const key of Object.keys(patch)) {
      before[key] = saved[key];
      if (!same(saved[key], patch[key])) changed.push(key);
    }
    if (!changed.length) return false;
    const entry: Change = { row, page, label, before };
    this.stack.push(entry);
    await this.track(this.host.patch(patch));
    // A write the backend refused leaves the window showing what is saved: the keys are back at
    // what they were. Nothing was saved, so there is nothing to say «saved» about and nothing to
    // take back. A key that stands at some other value was written over by a later change, which
    // is not a refusal: that one is judged by its own write.
    const now = this.host.settings();
    if (changed.every((key) => same(now[key], before[key]))) {
      this.drop(entry);
      return false;
    }
    this.mark(row, "saved");
    this.say(what, { label: t("settings.undo"), run: () => void this.undo(page) });
    return true;
  }

  /** The editor of one page: its commits are that page's to take back. */
  forPage(page: string): Pick<SettingsAutosave, "commit"> {
    return { commit: (row, patch, what, label) => this.commit(row, patch, what, label, page) };
  }

  /** Takes the last change back (of the page, when it is named); false when there is nothing to take back. */
  async undo(page?: string): Promise<boolean> {
    const at = this.lastOf(page);
    if (at < 0) return false;
    const [change] = this.stack.splice(at, 1);
    try {
      await this.track(this.host.patch(change.before));
    } catch {
      // Not taken back: the change stands, and stays to be taken back again.
    }
    const now = this.host.settings();
    if (!Object.keys(change.before).every((key) => same(now[key], change.before[key]))) {
      this.stack.splice(Math.min(at, this.stack.length), 0, change);
      return false;
    }
    this.mark(change.row, "undone");
    this.say(t("settings.undone", { name: change.label }));
    return true;
  }

  canUndo(page?: string): boolean {
    return this.lastOf(page) >= 0;
  }

  /** Resolves when every write under way is done. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private lastOf(page?: string): number {
    for (let i = this.stack.length - 1; i >= 0; i--) if (page === undefined || this.stack[i].page === page) return i;
    return -1;
  }

  private drop(entry: Change) {
    const at = this.stack.indexOf(entry);
    if (at >= 0) this.stack.splice(at, 1);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  private say(text: string, action?: { label: string; run: () => void }) {
    if (this.toastId !== null) this.host.dismiss(this.toastId);
    this.toastId = this.host.toast(text, action);
  }

  private mark(row: string, mark: Mark) {
    this.marks[row] = mark;
    clearTimeout(this.timers.get(row));
    this.timers.set(
      row,
      setTimeout(() => {
        this.marks[row] = undefined;
        this.timers.delete(row);
      }, MARK_MS),
    );
  }
}
