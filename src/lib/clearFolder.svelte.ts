// «Clear» for Trash, Spam and Drafts (#74): one command with one key, offered in those three
// folders only. It asks with the number of letters on the server, waits a few seconds that
// can be cancelled (as a letter being sent does), and only then asks the backend, which
// works in batches that the tasks window shows with a «Stop». Drafts go to Trash, but for
// the ones open in a window. Offline there is no command, and a connection lost during the
// wait means it does not begin. Only what the question counted is cleared: the backend hands
// back a bound with the number, and the run (also a retry) is asked for that bound.

import { api, asError } from "./api";
import { t, tn } from "./i18n.svelte";
import type { ComposeWindow } from "./composes.svelte";
import type { View } from "./list.svelte";
import type { Confirmation } from "./ui.svelte";
import type { AccountView, FolderInfo, Task } from "./types";

/** The seconds between the confirmation and the first request. */
export const DELAY_SECS = 5;

type Role = "trash" | "junk" | "drafts";

const isClearable = (role: FolderInfo["role"]): role is Role => role === "trash" || role === "junk" || role === "drafts";

/** What the clearing needs from the app store. */
export interface ClearHost {
  readonly view: View;
  /** The letter of a separate message window; the command lives in the main window only. */
  readonly windowOf: number | null;
  readonly composes: ComposeWindow[];
  readonly tasks: Task[];
  account(id: string): AccountView | undefined;
  folder(accountId: string, name: string): FolderInfo | undefined;
  toast(text: string, error?: boolean, action?: { label: string; run: () => void }, ms?: number): number | void;
  retext(id: number, text: string): boolean;
  dismiss(id: number): void;
  confirm(q: Omit<Confirmation, "resolve">): Promise<boolean>;
  track<T>(p: Promise<T>): Promise<T>;
  fail(e: unknown, prefix?: string): void;
  /** "z" takes `run` back while the wait lasts; the returned function lets go of it. */
  holdUndo(text: string, run: () => Promise<void>): () => void;
}

/** The folder the command is offered for in the current view. */
export interface ClearTarget {
  account_id: string;
  folder: FolderInfo;
  role: Role;
}

export class ClearFolder {
  /** Folders whose question or wait is under way, `account\0folder`: a second press changes nothing. */
  private pending = new Set<string>();
  /** The bound each folder's last confirmed count gave, `account\0folder`: a retry goes on with it. */
  private bounds = new Map<string, number>();
  /** The role each folder had when it was confirmed, `account\0folder`: the run and a retry go on with it, not with a new lookup. */
  private roles = new Map<string, Role>();

  constructor(private host: ClearHost) {}

  /** The folder of the open list, when it is one of the three. */
  here(): ClearTarget | null {
    const { view } = this.host;
    if (this.host.windowOf !== null || view.kind !== "folder") return null;
    return this.target(view.account_id, view.folder);
  }

  target(accountId: string, name: string): ClearTarget | null {
    const folder = this.host.folder(accountId, name);
    if (!folder || !isClearable(folder.role)) return null;
    return { account_id: accountId, folder, role: folder.role };
  }

  /** Why the command cannot be used now (it is shown as the button's hint), or null. */
  reason(folder: FolderInfo): string | null {
    if (!this.online(folder.account_id)) return t("clear.offline");
    if (folder.total === 0) return t("clear.nothing");
    return null;
  }

  /** «Empty Trash» and its kin: the name of the command in the folder. */
  title(role: Role): string {
    return t(`clear.${role}`);
  }

  private online(accountId: string): boolean {
    return this.host.account(accountId)?.status?.state === "online";
  }

  /** The cache ids of the drafts that windows of the mailbox have open: they stay. */
  private open(accountId: string): ComposeWindow[] {
    return this.host.composes.filter((w) => w.account_id === accountId && w.draft_id !== null);
  }

  /** Asks; once confirmed, the delay runs and the clearing follows by itself. Returns when the delay has begun. */
  async begin(accountId: string, name: string): Promise<void> {
    const target = this.target(accountId, name);
    if (!target) return;
    const key = `${accountId}\0${name}`;
    if (this.pending.has(key) || this.running(accountId, name)) return;
    if (!this.online(accountId)) {
      this.host.toast(t("clear.offline"), true);
      return;
    }
    this.pending.add(key);
    let count = 0;
    let bound = 0;
    try {
      const plan = await this.plan(target);
      if (plan && (await this.host.confirm(plan.question))) {
        count = plan.count;
        bound = plan.bound;
      }
    } catch (e) {
      this.host.fail(e);
    }
    if (!count) {
      this.pending.delete(key);
      return;
    }
    void this.wait(target, count)
      .then(async (go) => {
        if (go) {
          this.bounds.set(key, bound);
          this.roles.set(key, target.role);
          await this.run(accountId, name, bound);
        }
      })
      .finally(() => this.pending.delete(key));
  }

  /** The question, built from what the server holds; null when there is nothing to ask about. */
  private async plan(target: ClearTarget): Promise<{ question: Omit<Confirmation, "resolve">; count: number; bound: number } | null> {
    const { account_id, folder, role } = target;
    const { total, bound } = await this.host.track(api.folderTotal(account_id, folder.name));
    if (total === 0) {
      this.host.toast(t("clear.nothing"));
      return null;
    }
    if (role !== "drafts") {
      return {
        count: total,
        bound,
        question: {
          title: t(`clear.ask.${role}`),
          // The list's own number is told only when it differs from the server's.
          text: total === folder.total ? t("clear.eraseText", { total }) : t("clear.eraseTextLoaded", { total, loaded: folder.total }),
          okLabel: t("clear.erase", { n: total }),
          danger: true,
        },
      };
    }
    // Windows of letters are not the main one's: the backend knows the drafts open in all of them.
    const opened = Math.max(this.open(account_id).length, await api.openDrafts(account_id).catch(() => 0));
    const moving = Math.max(0, total - opened);
    if (moving === 0) {
      this.host.toast(t("clear.allOpen"));
      return null;
    }
    // A copy that never reached the server stays, and so does the one of an open window.
    const openKeys = new Set(this.host.composes.map((w) => w.local_id));
    const lonely = (await api.draftCacheList().catch(() => []))
      .filter((c) => c.account_id === account_id && c.draft_id == null && !openKeys.has(c.key)).length;
    const items = [
      ...(opened ? [tn("clear.keptOpen", opened)] : []),
      ...(lonely ? [tn("clear.keptCopies", lonely)] : []),
    ];
    return {
      count: moving,
      bound,
      question: {
        title: t("clear.ask.drafts"),
        text: tn("clear.draftsText", moving),
        okLabel: t("clear.toTrash", { n: moving }),
        danger: true,
        ...(items.length ? { items } : {}),
      },
    };
  }

  /** The seconds to think again, counted down in a toast with «Undo». False when cancelled or when the network went. */
  private wait(target: ClearTarget, count: number): Promise<boolean> {
    const { account_id, role } = target;
    const what = role === "drafts" ? tn("clear.nDrafts", count) : tn("clear.nLetters", count);
    const text = (s: number) => t(`clear.counting.${role}`, { s, what });
    const end = Date.now() + DELAY_SECS * 1000;
    const left = () => Math.max(1, Math.ceil((end - Date.now()) / 1000));
    return new Promise((resolve) => {
      let toastId: number | void = undefined;
      // "z" means the latest action, and during the wait that is this one.
      const release = this.host.holdUndo(this.title(role), async () => done(false));
      const done = (go: boolean) => {
        release();
        clearTimeout(timer);
        clearInterval(ticker);
        if (typeof toastId === "number") this.host.dismiss(toastId);
        resolve(go);
      };
      const timer = setTimeout(() => {
        if (this.online(account_id)) return done(true);
        this.host.toast(t("clear.lost"), true);
        done(false);
      }, DELAY_SECS * 1000);
      const ticker = setInterval(() => {
        if (typeof toastId === "number") this.host.retext(toastId, text(left()));
      }, 1000);
      toastId = this.host.toast(text(DELAY_SECS), false, { label: t("undo"), run: () => done(false) }, DELAY_SECS * 1000);
    });
  }

  private running(accountId: string, name: string): boolean {
    return this.host.tasks.some((x) => x.key === taskKey(accountId, name) && x.state === "running");
  }

  /** Asks the backend; what it did is told in a toast, and a failure leaves its summary to retry. */
  private async run(accountId: string, name: string, bound: number): Promise<void> {
    // The folder list may be under rebuilding just now; the role is what the question was asked for.
    const role = this.roles.get(`${accountId}\0${name}`) ?? this.target(accountId, name)?.role;
    if (!role) {
      this.host.toast(t("clear.failed"), true);
      return;
    }
    // The windows of letters are added by the backend, which knows the drafts open in all of them.
    const keep = this.open(accountId).map((w) => w.draft_id as number);
    try {
      const run = await this.host.track(api.folderEmpty(accountId, name, role === "drafts" ? keep : [], bound));
      if (!run.stopped) {
        this.bounds.delete(`${accountId}\0${name}`);
        this.roles.delete(`${accountId}\0${name}`);
      }
      this.host.toast(run.stopped ? t("clear.stopped", { done: run.done, total: run.total }) : t(`clear.done.${role}`, { n: run.done }));
    } catch (e) {
      // The backend left a task with the summary of how far it got; the toast says it too.
      const failed = this.host.tasks.find((x) => x.key === taskKey(accountId, name) && x.state === "failed");
      const text = failed?.error?.message ?? (asError(e).message || t("clear.failed"));
      this.host.toast(text, true, { label: t("retry"), run: () => void this.retryTask({ key: taskKey(accountId, name), account_id: accountId } as Task) }, 12000);
    }
  }

  /**
   * The «Retry» of a failed clearing: the confirmation was given already, so it begins at once,
   * and on what that confirmation counted, not on what the folder holds now. Without that count
   * (the window was reloaded) it asks again.
   */
  async retryTask(task: Pick<Task, "key" | "account_id">): Promise<void> {
    const parsed = parseKey(task);
    if (!parsed) return;
    await api.taskDismiss(task.key).catch(() => {});
    const bound = this.bounds.get(`${parsed.account_id}\0${parsed.folder}`);
    if (bound === undefined) return this.begin(parsed.account_id, parsed.folder);
    await this.run(parsed.account_id, parsed.folder, bound);
  }
}

/** The key of a clearing's task: the backend names it so, and the tasks window finds the folder in it. */
export function taskKey(accountId: string, folder: string): string {
  return `empty:${accountId}:${folder}`;
}

export function parseKey(task: Pick<Task, "key" | "account_id">): { account_id: string; folder: string } | null {
  if (!task.account_id) return null;
  const prefix = `empty:${task.account_id}:`;
  return task.key.startsWith(prefix) ? { account_id: task.account_id, folder: task.key.slice(prefix.length) } : null;
}
