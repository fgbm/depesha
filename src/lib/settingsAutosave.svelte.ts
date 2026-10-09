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

  constructor(private host: AutosaveHost) {}

  /**
   * Writes the patch if it changes anything. `what` is the toast: the row and the change in
   * words («Reminders: 7 days → 14 days»); `label` is the row's name. Returns whether anything was written.
   */
  async commit(row: string, patch: Record<string, unknown>, what: string, label = row): Promise<boolean> {
    const saved = this.host.settings();
    const before: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(patch)) {
      before[key] = saved[key];
      if (!same(saved[key], patch[key])) changed = true;
    }
    if (!changed) return false;
    this.stack.push({ row, label, before });
    await this.host.patch(patch);
    // A write the backend refused leaves the window showing what is saved: nothing was saved, so
    // there is nothing to say «saved» about and nothing to take back.
    const now = this.host.settings();
    if (!Object.keys(patch).every((key) => same(now[key], patch[key]))) {
      this.stack.pop();
      return false;
    }
    this.mark(row, "saved");
    this.say(what, { label: t("settings.undo"), run: () => void this.undo() });
    return true;
  }

  /** Takes the last change back; false when there is nothing to take back. */
  async undo(): Promise<boolean> {
    const change = this.stack.pop();
    if (!change) return false;
    await this.host.patch(change.before);
    this.mark(change.row, "undone");
    this.say(t("settings.undone", { name: change.label }));
    return true;
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
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
