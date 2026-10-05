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

export class ComposeAutosave {
  savingNow = $state(false);
  /** The content as it was last saved; the opening content counts as saved unless it is kept nowhere. */
  private lastSaved: string;
  private saving: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: ComposeAutosaveHost) {
    const { win } = host;
    this.lastSaved = untrack(() => (win.unsaved ? "" : JSON.stringify($state.snapshot(win.draft))));
    $effect(() => {
      const now = JSON.stringify($state.snapshot(this.host.win.draft));
      this.cancel();
      if (now !== this.lastSaved) this.timer = setTimeout(() => this.save(), AUTOSAVE_MS);
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

  /** Saves the draft on the server unless nothing changed; one save at a time. */
  async save(): Promise<boolean> {
    this.cancel();
    while (this.saving) await this.saving;
    const { win } = this.host;
    const draft = $state.snapshot(win.draft);
    const text = JSON.stringify(draft);
    if (text === this.lastSaved) return true;
    if (!isDirty(draft) && win.draft_id === null) return true;
    this.savingNow = true;
    this.saving = (async () => {
      try {
        win.draft_id = await api.draftSave(win.account_id, draft, win.draft_id);
        this.lastSaved = text;
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
}
