// User actions that take letters out of the list (delete, archive, move, spam) and taking
// the last one back with "z". None of them rejects: a failure is a toast, the rows come
// back, and the app goes on as before.

import type { MailboxController } from "./mailboxes.svelte";
import type { SettingsController } from "./settings.svelte";
import type { Reader } from "./reader.svelte";
import type { UiController } from "./ui.svelte";
import type { SelectionController } from "./selection.svelte";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, asError } from "./api";
import { t, tn } from "./i18n.svelte";
import { refusalOf } from "./labels";
import { labels } from "./labels.svelte";
import type { ListController } from "./list.svelte";
import type { MessageRow, Moved } from "./types";

/** The toast's words: given, or made from the moves done (when they say where the letters went). */
export type Text = string | ((moved: Moved[]) => string);

/** An action on more letters than this asks first: a slip of «select all» must not take them (#196). */
export const BULK_LIMIT = 10;

/** The question before an action on many letters: its title in the letters counted, and the button that agrees. */
export interface Ask {
  title: (n: number) => string;
  okLabel: string;
  /** Words under the title; without them the dialog offers the undo, which most actions have. */
  note?: string;
  /** The action loses something: the dialog puts the focus on Cancel. */
  danger?: boolean;
}

export interface Undoable {
  moved: Moved[];
  text: string;
  /** Takes it back otherwise than by moving the letters back: an answer's move to "Waiting for reply". */
  run?: () => Promise<void>;
  /** The folders the letters of a thread wore before this move renamed them (#180): written back
   *  when the move is taken back, so the rows name their folders again. */
  renamed?: Map<number, string>;
  /** Set once the move is taken back, by "z" or by the toast's button: a move is taken back once. */
  undone?: boolean;
  /** Set when the offer's time ran out: it is no longer on offer, nor given back by a `hold` that let go. */
  expired?: boolean;
  /** The same actions done before this one and merged with it into one toast, oldest first: taken back after it. */
  earlier?: Undoable[];
}

/** Equal toasts in a row stand as one: the key of the action, the steps done, the letters counted, the toast. */
interface Group {
  key: string;
  steps: Undoable[];
  total: number;
  toast: number;
  /** `ActionRunner.breaks` when the group last grew: a later count means something came between. */
  breaks: number;
}

/** What actions need from the app store. */
export interface ActionHost {
  readonly mailboxes: Pick<MailboxController, "folders">;
  readonly settingsCtl: Pick<SettingsController, "settings">;
  readonly reader: Pick<Reader, "conversation" | "dropFromConversation" | "opened" | "renameInConversation" | "saw">;
  readonly ui: Pick<UiController, "confirm" | "fail" | "restate" | "toast" | "toasts" | "track">;
  readonly selection: Pick<SelectionController, "reload" | "selectedIds" | "takeOut">;
  /** The letter of a separate message window; null in the main window. */
  readonly windowOf: number | null;
  readonly list: ListController;
}

export class ActionRunner {
  /** The last move that can be taken back with "z". */
  lastUndo = $state<Undoable | null>(null);
  /** The action still talking to the server; "z" pressed meanwhile waits for it. It never rejects. */
  private pending: Promise<void> | null = null;
  /** The toast the last equal actions share, while it is on the screen and still the latest. */
  private group: Group | null = null;
  /** Counts what ends a run of equal actions: an undo, an offer, a failure, an action that moved nothing. */
  private breaks = 0;

  constructor(private host: ActionHost) {}

  /**
   * Takes messages out of the list and runs `run`; the moves it returns can be undone.
   * `single`: the action is about these letters alone — a letter unfolded in the conversation
   * (0.8.4, #180) is dealt with on its own, its thread is not carried along with it.
   * `ask`: the question put first when the action would take out more than `BULK_LIMIT` letters.
   */
  async perform(
    text: Text,
    ids: number[],
    run: (ids: number[], own: number[]) => Promise<Moved[]>,
    failText: string,
    single = false,
    count?: (n: number) => string,
    ask?: Ask,
  ) {
    if (!ids.length) return;
    const p = this.act(text, ids, run, failText, single, count, ask);
    this.pending = p;
    await p;
    if (this.pending === p) this.pending = null;
  }

  private async act(
    text: Text,
    ids: number[],
    run: (ids: number[], own: number[]) => Promise<Moved[]>,
    failText: string,
    single = false,
    count?: (n: number) => string,
    ask?: Ask,
  ) {
    const { list } = this.host;
    const { before, rows, threadLetter, threaded } = this.startOf(ids, single);
    const grouped = this.conversations(rows, single);
    // Asked only when the question is possible: reading the conversations first takes an answer
    // from the server, and a key pressed meanwhile would find the row still there and act on it
    // again (#196). A refusal leaves the list as it was, and the undo of the last action in place.
    let all = ids;
    // The letters were read before the rows left; the quick way below reads them after.
    let read = false;
    if (ask && this.upper(ids, grouped) > BULK_LIMIT) {
      const found = await this.readFirst(ids, grouped, rows, failText, ask);
      if (!found) return;
      all = found;
      read = true;
    }
    // "z" always means the latest action, never an older one.
    this.lastUndo = null;
    // A letter being dealt with is read now, not after the wait (#71). Locally only:
    // the move sets `\Seen` for these letters only, and a flag between moves would split the series.
    this.host.reader.saw(ids, false);
    const hidden = new Set(ids);
    // The letters of a conversation leave with the row it stands for.
    this.markLeaving(all, hidden);
    // Out of sight at once, except a letter of a thread, whose place waits for where it went.
    this.hideRows(ids, threadLetter, threaded);
    let failed = false;
    try {
      // The quick way reads the conversations after the rows left: a failure brings them back.
      if (!read && grouped.length) {
        all = await this.withConversation(ids, grouped);
        this.markLeaving(all, hidden);
      }
      const moved = (await this.host.ui.track(run(all, ids))).filter((m) => m.message_ids.length);
      const said = typeof text === "function" ? text(moved) : text;
      // The letter is gone: it leaves the shown conversation with the cache (0.8.4, #180).
      const renamed = threaded ? this.settleThread(ids, rows, moved) : null;
      if (!threaded && threadLetter) this.host.reader.dropFromConversation(ids);
      if (this.host.windowOf !== null && !threadLetter) {
        // The letter is done with: its window closes, the main window offers the undo.
        if (moved.length) await emitTo("main", "window-moved", { moved, text: said });
        await getCurrentWindow().close();
        return;
      }
      if (moved.length) this.record({ moved, text: said, renamed: renamed ?? undefined }, failText + (count ? "" : "\0" + said), ids.length, count);
      else this.breaks++;
    } catch (e) {
      failed = true;
      this.breaks++;
      this.refused(e, rows, failText);
    } finally {
      // Moved: the cache no longer has them here. Refused: they come back with the error.
      for (const id of hidden) list.leaving.delete(id);
    }
    if (failed) list.restore(before, new Set(ids));
    void this.host.selection.reload();
  }

  /**
   * The letters the action takes, read before anything leaves the list when more than `BULK_LIMIT`
   * of them are possible: their count is an upper bound, as `withConversation` drops letters of other
   * folders (#196). Null says the action ends here: refused, or a conversation that could not be read.
   */
  private async readFirst(ids: number[], grouped: MessageRow[], rows: (MessageRow | undefined)[], failText: string, ask: Ask): Promise<number[] | null> {
    const all = await this.lettersOf(ids, grouped, rows, failText);
    return all && (await this.mayAsk(ask, all.length)) ? all : null;
  }

  /** The most letters an action can take: a row that carries a conversation stands for all of it,
   *  and `withConversation` drops letters of other folders, so this overcounts at worst (#196). */
  private upper(ids: number[], grouped: MessageRow[]): number {
    return ids.length + grouped.reduce((n, r) => n + r.thread_count - 1, 0);
  }

  /** What an action starts from: the rows as they were, and the two shapes of acting on a thread (#180). */
  private startOf(ids: number[], single: boolean) {
    const before = this.host.list.messages;
    const opened = this.host.reader.opened;
    const rowOf = (id: number) =>
      before.find((m) => m.id === id) ?? this.host.list.threadRow(id) ?? this.host.reader.conversation.find((m) => m.id === id) ?? (opened?.row.id === id ? opened.row : undefined);
    // A letter unfolded in the conversation, not open in the pane (0.8.4, #180): the pane keeps
    // the letter it shows — no "take out", no next row, and a window of a letter of its own stays
    // open. The row goes (a list is not always grouped), and the letter leaves the conversation.
    const threadLetter = single && !ids.includes(opened?.row.id ?? -1);
    // A letter of a thread on screen: a move that leaves it in its thread keeps its place and its
    // row takes the new folder, instead of going and coming back on the next reload (#180).
    const threaded = this.host.windowOf === null && ids.length > 0 && ids.every((id) => this.letterOfThread(id));
    return { before, rows: ids.map(rowOf), threadLetter, threaded };
  }

  /**
   * The letters an action applies to, whole conversations included. The list is left as it was
   * when a conversation cannot be read: the failure is told, and null says nothing was done.
   */
  private async lettersOf(ids: number[], grouped: MessageRow[], rows: (MessageRow | undefined)[], failText: string): Promise<number[] | null> {
    if (!grouped.length) return ids;
    try {
      return await this.withConversation(ids, grouped);
    } catch (e) {
      this.breaks++;
      this.refused(e, rows, failText);
      void this.host.selection.reload();
      return null;
    }
  }

  /** Whether the action goes on: more letters than `BULK_LIMIT` are asked about first (#196), and a
   *  refusal ends the run of equal actions as any other break does. */
  private async mayAsk(ask: Ask, n: number): Promise<boolean> {
    if (n <= BULK_LIMIT) return true;
    if (await this.host.ui.confirm({ title: ask.title(n), text: ask.note ?? t("bulk.note"), okLabel: ask.okLabel, danger: ask.danger })) return true;
    this.breaks++;
    return false;
  }

  /**
   * Makes `step` what "z" takes back and tells it in a toast. An equal action right after the last
   * one joins its toast instead of adding another: the words count the letters, the time runs anew,
   * and "z" takes the steps back from the last to the first. The join is decided here, when the
   * server has answered, not when the action began: «e» pressed again does not wait for the answer.
   */
  private record(step: Undoable, key: string, n: number, count?: (n: number) => string) {
    const { ui } = this.host;
    const last = this.group;
    const g = last && last.key === key && last.breaks === this.breaks && !step.run && ui.toasts.some((x) => x.id === last.toast) ? last : null;
    if (!g) {
      this.lastUndo = step;
      const toast = ui.toast(step.text, false, { label: t("undo"), run: () => void this.undo() });
      this.group = { key, steps: [step], total: n, toast, breaks: this.breaks };
      return;
    }
    g.steps.push(step);
    g.total += n;
    const text = count ? count(g.total) : `${step.text} · ${g.total}`;
    this.lastUndo = { ...step, text, earlier: g.steps.slice(0, -1) };
    g.steps[g.steps.length - 1] = this.lastUndo;
    ui.restate(g.toast, text);
  }

  /** A letter of a thread on screen: a row of an unfolded thread in the list, or a letter of the
   *  open conversation the list does not show as a row of its own (#179, #180). */
  private letterOfThread(id: number): boolean {
    const { list } = this.host;
    if (list.threadRow(id)) return true;
    const opened = this.host.reader.opened;
    if (!opened || id === opened.row.id) return false;
    if (!this.host.reader.conversation.some((m) => m.id === id)) return false;
    return !list.messages.some((m) => m.id === id);
  }

  /**
   * Where a move left the letters of a thread (#180): the ones whose new folder still holds the
   * thread stay — the row keeps its place and takes the new folder; the ones the trash or the
   * spam takes leave, as the backend's `thread` leaves them out. A destination the cache does
   * not know is not guessed: the row stays and the thread is read again. Returns the folders the
   * letters wore before, for the undo to write back.
   */
  private settleThread(ids: number[], rows: (MessageRow | undefined)[], moved: Moved[]): Map<number, string> | null {
    const { list } = this.host;
    const gone: number[] = [];
    const renamed = new Map<number, string>();
    const back = new Map<number, string>();
    let unknown = false;
    for (const id of ids) {
      const row = rows.find((r) => r?.id === id);
      const to = this.destination(moved, row);
      const leaves = this.leavesThread(to, row?.account_id ?? "");
      if (leaves === null) unknown = true;
      else if (leaves) gone.push(id);
      else if (to && row) {
        renamed.set(id, to);
        back.set(id, row.folder);
      }
    }
    if (renamed.size) {
      list.setThreadFolder(renamed);
      this.host.reader.renameInConversation(renamed);
    }
    if (gone.length) {
      list.remove(gone);
      this.host.reader.dropFromConversation(gone);
      for (const id of gone) list.leaving.delete(id);
    }
    if (unknown) void list.refreshThreads(true);
    return back.size ? back : null;
  }

  /** The folder the move named for this row, from the moves the backend reported. */
  private destination(moved: Moved[], row: MessageRow | undefined): string | null {
    if (!row) return null;
    const groups = moved.filter((m) => m.account_id === row.account_id && m.from === row.folder);
    const exact = groups.find((m) => !!row.message_id && m.message_ids.includes(row.message_id));
    return (exact ?? groups[0])?.to ?? null;
  }

  /** Whether the new folder leaves the letter out of its thread: the trash and the spam, which
   *  the backend's `thread` skips. An unknown folder answers nothing, and the caller re-reads. */
  private leavesThread(to: string | null, account_id: string): boolean | null {
    if (to === null) return null;
    const role = this.host.mailboxes.folders.find((f) => f.account_id === account_id && f.name === to)?.role;
    if (!role) return null;
    return role === "trash" || role === "junk";
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
    const folder = row ? (this.host.mailboxes.folders.find((f) => f.account_id === row.account_id && f.name === row.folder)?.display_name ?? row.folder) : "";
    switch (what) {
      case "no-rights": {
        // The ban is already remembered by the backend; the notice leads to the folder.
        const account = row?.account_id;
        this.host.ui.toast(t("refuse.noRights", { folder }), true, {
          label: t("folder.properties"),
          run: () => {
            if (account) labels.openCard(account, row!.folder);
          },
        });
        break;
      }
      case "error":
        this.host.ui.toast(t("refuse.error", { folder }), true, { label: t("retry"), run: () => this.host.selection.reload() });
        break;
      case "no-answer":
        // Not a refusal: yellow, not red; the action waits in the background, as all offline work.
        this.host.ui.toast(t("refuse.noAnswer", { folder }), false);
        break;
      default:
        this.host.ui.fail(e, failText);
    }
  }

  /** The letters on their way out: the list keeps them until the server answers, and a failure
   *  brings them back with the error. */
  private markLeaving(ids: number[], hidden: Set<number>) {
    for (const id of ids) {
      hidden.add(id);
      this.host.list.leaving.add(id);
    }
  }

  /** Out of sight at once, except a letter of a thread, whose place waits for where it went (#180). */
  private hideRows(ids: number[], threadLetter: boolean, threaded: boolean) {
    if (threaded) return;
    if (threadLetter) this.host.list.remove(ids);
    else this.host.selection.takeOut(ids);
  }

  /** The rows that carry a conversation to read: a letter of an unfolded thread stands for itself (#179),
   *  a letter dealt with on its own carries nothing (#180), and a message window shows one letter. */
  private conversations(rows: (MessageRow | undefined)[], single: boolean): MessageRow[] {
    if (single || !this.host.settingsCtl.settings.threads || this.host.windowOf !== null) return [];
    return rows.filter((r): r is MessageRow => !!r && r.thread_count > 1 && !this.host.list.threadRow(r.id));
  }

  /** The ids an action applies to: in a grouped list a row stands for its whole conversation. */
  private async withConversation(ids: number[], grouped: MessageRow[]): Promise<number[]> {
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

  /** Without `ids`: the selected rows; `single` deals with the given letters alone (#180). */
  remove(ids = this.host.selection.selectedIds(), single = false) {
    const ask = { title: (n: number) => tn("bulk.delete", n), okLabel: t("act.delete"), danger: true, note: this.goneForGood(ids) ? t("bulk.note.gone") : undefined };
    return this.perform(tn("done.deleted", ids.length), ids, api.remove, t("err.delete"), single, (n) => tn("done.deleted", n), ask);
  }

  /** Whether the delete leaves nothing to take back: in the trash, or in a mailbox without one,
   *  the backend removes the letters for good and reports no move (#196). */
  private goneForGood(ids: number[]): boolean {
    const { list } = this.host;
    return ids.some((id) => {
      const row = list.messages.find((m) => m.id === id) ?? list.threadRow(id);
      if (!row) return false;
      const folders = this.host.mailboxes.folders.filter((f) => f.account_id === row.account_id);
      const trash = folders.find((f) => f.role === "trash");
      // A mailbox not read yet is not a mailbox without the folder.
      return trash ? trash.name === row.folder : folders.length > 0;
    });
  }

  moveTo(folder: string, ids = this.host.selection.selectedIds()) {
    const name = this.host.mailboxes.folders.find((f) => f.name === folder)?.display_name ?? folder;
    const ask = { title: (n: number) => tn("bulk.move", n, { folder: name }), okLabel: t("bulk.ok.move") };
    return this.perform(t("done.moved", { folder: name }), ids, (all) => api.move(all, folder), t("err.move"), false, undefined, ask);
  }

  /** "Done": out of the inbox, into the archive; `single` deals with the given letters alone (#180). */
  archive(ids = this.host.selection.selectedIds(), single = false) {
    const ask = { title: (n: number) => tn("bulk.archive", n), okLabel: t("bulk.ok.archive") };
    return this.perform(tn("done.archived", ids.length), ids, api.archive, t("err.archive"), single, (n) => tn("done.archived", n), ask);
  }

  spam(ids = this.host.selection.selectedIds()) {
    const ask = { title: (n: number) => tn("bulk.spam", n), okLabel: t("act.spam"), danger: true };
    return this.perform(t("done.spam"), ids, api.spam, t("err.spam"), false, undefined, ask);
  }

  /**
   * Offers to take back something that is not a move of letters (a merge of people, #104): the
   * toast's button and "z" run `run`, for `ms`, then it is no longer on offer.
   */
  offer(text: string, run: () => Promise<void>, ms = 10_000) {
    const u: Undoable = { moved: [], text, run };
    this.breaks++;
    this.lastUndo = u;
    this.host.ui.toast(text, false, { label: t("undo"), run: () => void this.undo() }, ms);
    setTimeout(() => {
      u.expired = true;
      if (this.lastUndo === u) this.lastUndo = null;
    }, ms);
  }

  /**
   * Makes `run` what "z" takes back for as long as something else counts down (a clearing's wait):
   * "z" always means the latest action. The returned function lets go of it, unless a newer action took
   * the place; the undo it covered comes back if it is still on offer.
   */
  hold(text: string, run: () => Promise<void>): () => void {
    const prev = this.lastUndo;
    const u: Undoable = { moved: [], text, run };
    this.breaks++;
    this.lastUndo = u;
    return () => {
      if (this.lastUndo === u) this.lastUndo = prev && !prev.undone && !prev.expired ? prev : null;
    };
  }

  /** Takes back the last move; waits for an action still on its way. */
  async undo() {
    if (!this.lastUndo && this.pending) await this.pending;
    const u = this.lastUndo;
    if (!u) return;
    this.lastUndo = null;
    this.breaks++;
    u.undone = true;
    try {
      // Equal actions merged into one toast: the last is taken back first.
      for (const step of [...(u.earlier ?? []), u].reverse()) {
        await (step.run ? step.run() : api.undo(step.moved));
        // The move back leaves the letters where they were: their folders are named again (#180).
        if (step.renamed) {
          this.host.list.setThreadFolder(step.renamed);
          this.host.reader.renameInConversation(step.renamed);
        }
      }
      this.host.ui.toast(t("done.undone"));
    } catch (e) {
      this.host.ui.fail(e, t("err.undo"));
    }
    void this.host.selection.reload();
  }
}
