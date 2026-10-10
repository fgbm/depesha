// User actions that take letters out of the list (delete, archive, move, spam) and taking
// the last one back with "z". None of them rejects: a failure is a toast, the rows come
// back, and the app goes on as before.

import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, asError } from "./api";
import { t, tn } from "./i18n.svelte";
import { refusalOf } from "./labels";
import type { ListController } from "./list.svelte";
import type { FolderInfo, MessageRow, Moved, OpenedMessage, Settings } from "./types";

/** The toast's words: given, or made from the moves done (when they say where the letters went). */
export type Text = string | ((moved: Moved[]) => string);

export interface Undoable {
  moved: Moved[];
  text: string;
  /** Takes it back otherwise than by moving the letters back: an answer's move to "Waiting for reply". */
  run?: () => Promise<void>;
  /** Set once the move is taken back, by "z" or by the toast's button: a move is taken back once. */
  undone?: boolean;
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
  /** The letters are acted on: their read mark lands at once (#71). */
  markSeen(ids: number[], server?: boolean): void;
  toast(text: string, error?: boolean, action?: { label: string; run: () => void }, ms?: number): void;
  fail(e: unknown, prefix?: string): void;
  /** Opens a folder's properties card (#42): the "no rights" notice leads there. */
  folderProperties?(accountId: string, folder: string): void;
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
  async perform(text: Text, ids: number[], run: (ids: number[], own: number[]) => Promise<Moved[]>, failText: string) {
    if (!ids.length) return;
    const p = this.host.track(this.act(text, ids, run, failText));
    this.pending = p;
    await p;
    if (this.pending === p) this.pending = null;
  }

  private async act(text: Text, ids: number[], run: (ids: number[], own: number[]) => Promise<Moved[]>, failText: string) {
    const { list } = this.host;
    // "z" always means the latest action, never an older one.
    this.lastUndo = null;
    // The rows as they were: their conversations are looked up, and they come back on a failure.
    const before = list.messages;
    const rows = ids.map((id) => before.find((m) => m.id === id) ?? (this.host.opened?.row.id === id ? this.host.opened.row : undefined));
    const hidden = new Set(ids);
    // A letter being dealt with is read now, not after the wait (#71). Locally only:
    // the move sets `\Seen` for these letters only, and a flag between moves would split the series.
    this.host.markSeen(ids, false);
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
      const moved = (await run(all, ids)).filter((m) => m.message_ids.length);
      const said = typeof text === "function" ? text(moved) : text;
      if (this.host.windowOf !== null) {
        // The letter is done with: its window closes, the main window offers the undo.
        if (moved.length) await emitTo("main", "window-moved", { moved, text: said });
        await getCurrentWindow().close();
        return;
      }
      if (moved.length) {
        this.lastUndo = { moved, text: said };
        this.host.toast(said, false, { label: t("undo"), run: () => void this.undo() });
      }
    } catch (e) {
      failed = true;
      this.refused(e, rows, failText);
    } finally {
      // Moved: the cache no longer has them here. Refused: they come back with the error.
      for (const id of hidden) list.leaving.delete(id);
    }
    if (failed) list.restore(before, new Set(ids));
    void this.host.reload();
  }

  /**
   * A failed action says which of three things happened (#42, frame 8): no rights in the
   * folder (the ban is remembered, and the properties are one click away), a server error
   * (retry), or no answer (the letter waits, the tone is not red). Not the plain error
   * toast: the letter came back, and the reason decides what the user does next.
   */
  private refused(e: unknown, rows: (MessageRow | undefined)[], failText: string) {
    const kind = asError(e).kind;
    const what = refusalOf(kind);
    // The folder the rows were in, for the notice's words; the first row names it.
    const row = rows.find((r): r is MessageRow => !!r);
    const folder = row ? (this.host.folders.find((f) => f.account_id === row.account_id && f.name === row.folder)?.display_name ?? row.folder) : "";
    switch (what) {
      case "no-rights": {
        // The ban is already remembered by the backend; the notice leads to the folder.
        const account = row?.account_id;
        this.host.toast(t("refuse.noRights", { folder }), true, {
          label: t("folder.properties"),
          run: () => {
            if (account) this.host.folderProperties?.(account, row!.folder);
          },
        });
        break;
      }
      case "error":
        this.host.toast(t("refuse.error", { folder }), true, { label: t("retry"), run: () => this.host.reload() });
        break;
      case "no-answer":
        // Not a refusal: yellow, not red; the action waits in the background, as all offline work.
        this.host.toast(t("refuse.noAnswer", { folder }), false);
        break;
      default:
        this.host.fail(e, failText);
    }
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

  /**
   * Offers to take back something that is not a move of letters (a merge of people, #104): the
   * toast's button and "z" run `run`, for `ms`, then it is no longer on offer.
   */
  offer(text: string, run: () => Promise<void>, ms = 10_000) {
    const u: Undoable = { moved: [], text, run };
    this.lastUndo = u;
    this.host.toast(text, false, { label: t("undo"), run: () => void this.undo() }, ms);
    setTimeout(() => {
      if (this.lastUndo === u) this.lastUndo = null;
    }, ms);
  }

  /**
   * Makes `run` what "z" takes back for as long as something else counts down (a clearing's wait):
   * "z" always means the latest action. The returned function lets go of it, unless a newer action took the place.
   */
  hold(text: string, run: () => Promise<void>): () => void {
    const u: Undoable = { moved: [], text, run };
    this.lastUndo = u;
    return () => {
      if (this.lastUndo === u) this.lastUndo = null;
    };
  }

  /** Takes back the last move; waits for an action still on its way. */
  async undo() {
    if (!this.lastUndo && this.pending) await this.pending;
    const u = this.lastUndo;
    if (!u) return;
    this.lastUndo = null;
    u.undone = true;
    try {
      await (u.run ? u.run() : api.undo(u.moved));
      this.host.toast(t("done.undone"));
    } catch (e) {
      this.host.fail(e, t("err.undo"));
    }
    void this.host.reload();
  }
}
