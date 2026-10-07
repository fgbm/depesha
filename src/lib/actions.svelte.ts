// User actions that take letters out of the list (delete, archive, move, spam) and taking
// the last one back with "z". None of them rejects: a failure is a toast, the rows come
// back, and the app goes on as before.

import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { t, tn } from "./i18n.svelte";
import type { ListController } from "./list.svelte";
import type { FolderInfo, MessageRow, Moved, OpenedMessage, Settings } from "./types";

export interface Undoable {
  moved: Moved[];
  text: string;
  /** Takes it back otherwise than by moving the letters back: an answer's move to "Waiting for reply". */
  run?: () => Promise<void>;
}

/** What actions need from the app store. */
export interface ActionHost {
  readonly settings: Settings;
  readonly folders: FolderInfo[];
  /** The letter of a separate message window; null in the main window. */
  readonly windowOf: number | null;
  readonly opened: OpenedMessage | null;
  readonly list: ListController;
  /** Takes rows out of the list and opens the next one. */
  takeOut(ids: number[]): void;
  toast(text: string, error?: boolean, action?: { label: string; run: () => void }): void;
  fail(e: unknown, prefix?: string): void;
  track<T>(p: Promise<T>): Promise<T>;
  reload(): Promise<void>;
}

export class ActionRunner {
  /** The last move that can be taken back with "z". */
  lastUndo = $state<Undoable | null>(null);
  /** The action still talking to the server; "z" pressed meanwhile waits for it. It never rejects. */
  private pending: Promise<void> | null = null;

  constructor(private host: ActionHost) {}

  /** Takes messages out of the list and runs `run`; the moves it returns can be undone. */
  async perform(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    if (!ids.length) return;
    const p = this.host.track(this.act(text, ids, run, failText));
    this.pending = p;
    await p;
    if (this.pending === p) this.pending = null;
  }

  private async act(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    const { list } = this.host;
    // "z" always means the latest action, never an older one.
    this.lastUndo = null;
    // The rows as they were: their conversations are looked up, and they come back on a failure.
    const before = list.messages;
    const rows = ids.map((id) => before.find((m) => m.id === id) ?? (this.host.opened?.row.id === id ? this.host.opened.row : undefined));
    const hidden = new Set(ids);
    for (const id of ids) list.leaving.add(id);
    // Out of sight at once; the server is asked afterwards.
    this.host.takeOut(ids);
    let failed = false;
    try {
      const all = await this.withConversation(ids, rows);
      for (const id of all) {
        hidden.add(id);
        list.leaving.add(id);
      }
      const moved = (await run(all)).filter((m) => m.message_ids.length);
      if (this.host.windowOf !== null) {
        // The letter is done with: its window closes, the main window offers the undo.
        if (moved.length) await emitTo("main", "window-moved", { moved, text });
        await getCurrentWindow().close();
        return;
      }
      if (moved.length) {
        this.lastUndo = { moved, text };
        this.host.toast(text, false, { label: t("undo"), run: () => void this.undo() });
      }
    } catch (e) {
      failed = true;
      this.host.fail(e, failText);
    } finally {
      // Moved: the cache no longer has them here. Refused: they come back with the error.
      for (const id of hidden) list.leaving.delete(id);
    }
    if (failed) list.restore(before, new Set(ids));
    void this.host.reload();
  }

  /** The ids an action applies to: in a grouped list a row stands for its whole conversation. */
  private async withConversation(ids: number[], rows: (MessageRow | undefined)[]): Promise<number[]> {
    // A message window shows one letter, not a row of the list: the action is for it alone.
    if (!this.host.settings.threads || this.host.windowOf !== null) return ids;
    const grouped = rows.filter((r): r is MessageRow => !!r && r.thread_count > 1);
    // Every conversation at once, not one after another.
    const threads = await Promise.all(grouped.map((r) => api.thread(r.id)));
    const out = new Set(ids);
    grouped.forEach((row, i) => {
      for (const m of threads[i]) {
        // Only messages of the same folder: my replies stay in Sent.
        if (m.folder === row.folder && m.account_id === row.account_id) out.add(m.id);
      }
    });
    return [...out];
  }

  remove(ids: number[]) {
    return this.perform(tn("done.deleted", ids.length), ids, api.remove, t("err.delete"));
  }

  moveTo(folder: string, ids: number[]) {
    const name = this.host.folders.find((f) => f.name === folder)?.display_name ?? folder;
    return this.perform(t("done.moved", { folder: name }), ids, (all) => api.move(all, folder), t("err.move"));
  }

  /** "Done": out of the inbox, into the archive. */
  archive(ids: number[]) {
    return this.perform(tn("done.archived", ids.length), ids, api.archive, t("err.archive"));
  }

  spam(ids: number[]) {
    return this.perform(t("done.spam"), ids, api.spam, t("err.spam"));
  }

  /** Takes back the last move; waits for an action still on its way. */
  async undo() {
    if (!this.lastUndo && this.pending) await this.pending;
    const u = this.lastUndo;
    if (!u) return;
    this.lastUndo = null;
    try {
      await (u.run ? u.run() : api.undo(u.moved));
      this.host.toast(t("done.undone"));
    } catch (e) {
      this.host.fail(e, t("err.undo"));
    }
    void this.host.reload();
  }
}
