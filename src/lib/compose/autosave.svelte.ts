// A draft saves itself a moment after typing stops, as in Gmail and Yandex Mail: closing
// or folding the window never loses the letter. One save at a time; the content as it was
// last saved tells whether anything changed. The window (Compose.svelte) owns the wording
// of a failed save and the markup, so its `t("…")` stays in a component.

import { onDestroy, untrack } from "svelte";
import { api } from "../api";
import { isDirty } from "../compose";
import type { ComposeWindow } from "../composes.svelte";
import type { ComposeDraft } from "../types";

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
  /** Counts the calls-off, so a save waiting its turn knows it was one. */
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the draft last went to the server, ms; 0 is never. */
  private lastServerAt = 0;
  /** A copy of the draft stands in the local cache, a fallback for a crash (#71). */
  private localStored = false;

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
    this.epoch++;
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
   * Every pause also writes a local copy, so a crash loses nothing (#71).
   */
  async save(force = true): Promise<boolean> {
    this.cancel();
    const epoch = this.epoch;
    while (this.saving) await this.saving;
    // Called off while this one waited its turn (sent, discarded, typed on): the autosave does not start.
    if (!force && epoch !== this.epoch) return true;
    const { win } = this.host;
    const draft = $state.snapshot(win.draft);
    const text = JSON.stringify(draft);
    if (text === this.lastSaved) {
      // Nothing new since the server copy: the local fallback has nothing to add.
      await this.forgetLocal();
      return true;
    }
    // An untouched letter (only its signature) is worth neither the server nor a local copy.
    if (!isDirty(draft) && win.draft_id === null) {
      await this.forgetLocal();
      return true;
    }
    // Taken before the first await: a second save, the send and the discard all wait for it.
    this.saving = (async () => {
      try {
        // The local copy keeps the letter across a crash, whatever the server's minute is.
        await this.storeLocal(draft);
        // Called off while the copy was being written (sent, discarded): no server copy now.
        if (!force && epoch !== this.epoch) return true;
        if (!serverDue(this.lastServerAt, Date.now(), force)) {
          // Held back: the server copy follows when the minute is up.
          this.scheduleServer(SERVER_SAVE_MS - (Date.now() - this.lastServerAt));
          return true;
        }
        this.savingNow = true;
        const saved = await api.draftSave(win.account_id, draft, win.draft_id, win.draft_message_id ?? null, win.local_id);
        win.draft_id = saved?.id ?? null;
        win.draft_message_id = saved?.message_id ?? null;
        this.lastSaved = text;
        this.lastServerAt = Date.now();
        win.unsaved = false;
        win.savedAt = Date.now();
        this.host.clearError();
        // The letter is on the server now: the local copy is no longer the last word.
        await this.forgetLocal();
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

  /** Writes the draft to the local cache; a failure is not worth telling — the server copy stays. */
  private async storeLocal(draft: ComposeDraft) {
    // Marked before the write: a drop that comes while it is under way still removes the file.
    this.localStored = true;
    try {
      await api.draftCachePut(this.host.win.local_id, this.host.win.account_id, draft, this.host.win.draft_id, this.host.win.draft_message_id ?? null);
    } catch {
      // Best effort: the next pause, or the server copy, tries again.
    }
  }

  /** Drops the local copy: the draft is on the server now, or was thrown away. */
  async forgetLocal() {
    if (!this.localStored) return;
    this.localStored = false;
    await api.draftCacheDrop(this.host.win.local_id).catch(() => {});
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
