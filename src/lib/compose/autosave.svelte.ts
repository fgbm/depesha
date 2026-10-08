// A draft saves itself a moment after typing stops, as in Gmail and Yandex Mail: closing
// or folding the window never loses the letter. One save at a time; the content as it was
// last saved tells whether anything changed. The window (Compose.svelte) owns the wording
// of a failed save and the markup, so its `t("…")` stays in a component.

import { onDestroy, untrack } from "svelte";
import { api } from "../api";
import { isDirty } from "../compose";
import type { ComposeWindow } from "../composes.svelte";

/** What keeping the draft needs from the window. */
export interface ComposeAutosaveHost {
  readonly win: ComposeWindow;
  /** A save that failed: the window says so. */
  setError(message: string): void;
  /** A save that worked: the window's error goes. */
  clearError(): void;
  /** The message of a failed save. */
  draftNotSaved(error: string): string;
}

/** Drafts save themselves this long after typing stops. */
const AUTOSAVE_MS = 3000;
/** How often a draft may go to the server; in between, the local copy alone changes. */
export const SERVER_SAVE_MS = 60_000;

/** Whether the draft is due to go to the server now: at most once a minute, unless forced. */
export function serverDue(lastSavedAt: number, now: number, force: boolean): boolean {
  return force || lastSavedAt === 0 || now - lastSavedAt >= SERVER_SAVE_MS;
}

export class ComposeAutosave {
  savingNow = $state(false);
  /** The content as it was last saved; the opening content counts as saved unless it is kept nowhere. */
  private lastSaved: string;
  private saving: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the draft last went to the server, ms; 0 is never. */
  private lastServerAt = 0;

  constructor(private host: ComposeAutosaveHost) {
    const { win } = host;
    this.lastSaved = untrack(() => (win.unsaved ? "" : JSON.stringify($state.snapshot(win.draft))));
    // Any change of the letter restarts the wait; whether it differs from what was saved
    // is told by `save`. Serializing the draft on every key would copy its pictures, megabytes.
    let first = !untrack(() => win.unsaved);
    $effect(() => {
      $state.snapshot(this.host.win.draft);
      this.cancel();
      if (first) first = false;
      else this.timer = setTimeout(() => this.save(false), AUTOSAVE_MS);
    });
    onDestroy(() => this.cancel());
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The letter differs from what was last saved. */
  changed(): boolean {
    return JSON.stringify($state.snapshot(this.host.win.draft)) !== this.lastSaved;
  }

  /** Waits for a save already on its way. */
  async settled() {
    if (this.saving) await this.saving;
  }

  /**
   * Saves the draft on the server unless nothing changed; one save at a time. The autosave
   * holds it back to at most once a minute; closing the window and saving by hand force it.
   */
  async save(force = true): Promise<boolean> {
    this.cancel();
    while (this.saving) await this.saving;
    const { win } = this.host;
    const draft = $state.snapshot(win.draft);
    const text = JSON.stringify(draft);
    if (text === this.lastSaved) return true;
    if (!isDirty(draft) && win.draft_id === null) return true;
    if (!serverDue(this.lastServerAt, Date.now(), force)) {
      // Held back: the server copy follows when the minute is up.
      this.scheduleServer(SERVER_SAVE_MS - (Date.now() - this.lastServerAt));
      return true;
    }
    this.savingNow = true;
    this.saving = (async () => {
      try {
        win.draft_id = await api.draftSave(win.account_id, draft, win.draft_id);
        this.lastSaved = text;
        this.lastServerAt = Date.now();
        win.unsaved = false;
        win.savedAt = Date.now();
        this.host.clearError();
        return true;
      } catch (e) {
        this.host.setError(this.host.draftNotSaved((e as { message: string }).message));
        return false;
      } finally {
        this.saving = null;
        this.savingNow = false;
      }
    })();
    return this.saving;
  }

  /** The held-back save: runs once the minute since the last server save is up. */
  private scheduleServer(ms: number) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save(false);
    }, Math.max(0, ms));
  }
}
