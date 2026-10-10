import { api } from "./api";
import { bus } from "./bus";
import { t, tn } from "./i18n.svelte";
import { extensions } from "./extensions.svelte";
import { listenMain, listenWindow } from "./events";
import { takePendingOpen, tellMissed } from "./background.svelte";
import { ListController, type View } from "./list.svelte";
import { ActionRunner, type Text } from "./actions.svelte";
import { Reader } from "./reader.svelte";
import { ComposeManager, type ComposeState, type ComposeWindow } from "./composes.svelte";
import { rooms } from "./room.svelte";
import { labels } from "./labels.svelte";
import { SettingsController } from "./settings.svelte";
import { hints } from "./hints.svelte";
import { peopleBook } from "./peopleBook.svelte";
import { MailboxController } from "./mailboxes.svelte";
import { UiController, type Confirmation } from "./ui.svelte";
import { SelectionController } from "./selection.svelte";
import { ClearFolder } from "./clearFolder.svelte";
import type { AccountView, CachedDraft, ComposeDraft, FollowupPlan, KeySettings, Moved, StuckCopy } from "./types";

export type { View } from "./list.svelte";
export type { ComposeState, ComposeWindow } from "./composes.svelte";
export type { Toast, Confirmation, WizardState } from "./ui.svelte";

// The list (./list.svelte), the reader (./reader.svelte), actions with their undo
// (./actions.svelte), compositions (./composes.svelte), the settings (./settings.svelte),
// the mailboxes (./mailboxes.svelte), the overlays (./ui.svelte) and the list view with
// the selection (./selection.svelte) live in modules of their own; the events of the
// backend are in ./events. The store ties them together and keeps `app.*` as the
// interface's one way in. Every module declares a narrow host.

export class AppStore {
  readonly settingsCtl: SettingsController = new SettingsController(this);
  readonly mailboxes: MailboxController = new MailboxController(this);
  readonly ui: UiController = new UiController();
  readonly selection: SelectionController = new SelectionController(this);

  readonly list: ListController = new ListController(this);
  readonly actions: ActionRunner = new ActionRunner(this);
  readonly compose: ComposeManager = new ComposeManager(this);
  readonly reader: Reader = new Reader(this);
  /** «Clear» for Trash, Spam and Drafts (#74). */
  readonly clearing: ClearFolder = new ClearFolder(this);

  /**
   * The letter a separate message window shows (double click in the list); null in the
   * main window. Such a window has no list: actions on its letter close it, and what
   * concerns the list (undo, a search by sender) goes to the main window.
   */
  windowOf = $state<number | null>(null);

  /** Asks the open letter's header to show the card of its sender. */
  openSenderCard() { bus.emit("reader.sender-card"); }
  /** Opens the address book in the main window, at a person and a filter; the settings window gives way. */
  async openPeople(at: { email?: string; filter?: "all" | "ruled" | "manual" | "hidden" } | null = null) {
    this.ui.settingsOpen = false;
    this.ui.peopleFocus = at;
    await this.selection.setView({ kind: "people" });
  }
  /** Puts the focus into the search box of what the main window shows: the mail list or the address book. */
  focusSearch() { bus.emit(this.list.view.kind === "people" ? "people.search" : "mail.search"); }


  /** Rows the user is on: the selection and the open letter. */
  using(): number[] { return [...this.selection.selected, ...(this.reader.opened ? [this.reader.opened.row.id] : [])]; }
  /** The letters are acted on: their read mark lands at once (#71). */
  markSeen(ids: number[], server = true) { this.reader.saw(ids, server); }

  async init() {
    this.mailboxes.initVersion();
    extensions.toast = (text, error) => this.ui.toast(text, error);
    await listenMain(this);
    await this.settingsCtl.loadLanguage();
    // Each request that fails is told and does not hold up the others.
    const [accounts] = await Promise.all([
      this.mailboxes.loadAccounts().then(() => true, (e) => (this.ui.fail(e), false)),
      this.mailboxes.loadFolders(),
      this.mailboxes.loadOutbox(),
      this.settingsCtl.loadSettings(),
      extensions.load(),
      hints.load(),
      peopleBook.load(),
      api.tasks().then((tasks) => (this.ui.tasks = tasks), (e) => this.ui.fail(e)),
      api.updateStatus().then((u) => (this.settingsCtl.update = u), (e) => this.ui.fail(e)),
    ]);
    this.list.view = this.mailboxes.home();
    // Mailboxes filling up warn once the accounts and the settings are read.
    rooms.start(this);
    labels.start(this);
    void Promise.all(this.mailboxes.accounts.map((a) => labels.load(a.id)));
    await this.selection.reload();
    void tellMissed(this);
    // Drafts kept locally when the app last stopped: offered for restore (#71).
    void this.offerLocalDrafts();
    void this.tellStuckCopies();
    // A toast click while the app was closed: the backend kept the URL for this window.
    void takePendingOpen(this);
    // Unknown mailboxes are not no mailboxes: the wizard waits for a list it could read.
    if (accounts && this.mailboxes.accounts.length === 0) this.ui.wizard = { account: null };
  }

  /** A separate window with one letter: no list, no background work of its own. */
  async initWindow(id: number) {
    this.windowOf = id;
    extensions.toast = (text, error) => this.ui.toast(text, error);
    await listenWindow(this);
    await this.settingsCtl.loadLanguage();
    await Promise.all([this.mailboxes.loadAccounts().catch((e) => this.ui.fail(e)), this.mailboxes.loadFolders(), this.settingsCtl.loadSettings(), extensions.load(), hints.load(), peopleBook.load()]);
    this.selection.selected = new Set([id]);
    await this.open(id);
  }

  open(id: number, allowRemote = false) { return this.reader.open(id, allowRemote); }

  /** A folder was opened: read its properties from the cache, or the server when never checked. */
  folderOpened(accountId: string, folder: string) {
    if (labels.prop(accountId, folder)) return;
    void labels.loadProps(accountId, folder);
  }

  /** The labels of a mailbox and the properties of its folders (#42). */
  get labels() { return labels; }
  /** Puts a label on the rows or takes it off. */
  setLabel(ids: number[], name: string, value: boolean) { return labels.set(ids, name, value); }
  /** Reads a folder's properties, asking the server. */
  checkFolderProps(accountId: string, folder: string) { return labels.check(accountId, folder); }
  /** Opens a folder's properties card (#42): the "no rights" notice leads there. */
  folderProperties(accountId: string, folder: string) { labels.openCard(accountId, folder); }
  /** Takes messages out of the list and runs `run`; the moves it returns can be undone. Never rejects. */
  perform(text: Text, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    return this.actions.perform(text, ids, run, failText);
  }

  remove(ids = this.selection.selectedIds()) { return this.actions.remove(ids); }
  moveTo(folder: string, ids = this.selection.selectedIds()) { return this.actions.moveTo(folder, ids); }
  /** "Done": out of the inbox, into the archive. */
  archive(ids = this.selection.selectedIds()) { return this.actions.archive(ids); }
  spam(ids = this.selection.selectedIds()) { return this.actions.spam(ids); }
  undo() { return this.actions.undo(); }
  offerUndo(text: string, run: () => Promise<void>) { return this.actions.offer(text, run); }
  holdUndo(text: string, run: () => Promise<void>) { return this.actions.hold(text, run); }

  /** Queues the composition; it leaves after the undo delay or at `at`. */
  send(accountId: string, draft: ComposeDraft, draftId: number | null, draftMessageId: string | null, at: number | null, followupSecs: number | null, followup: FollowupPlan | null = null) {
    return this.compose.send(accountId, draft, draftId, draftMessageId, at, followupSecs, followup);
  }

  /** Takes a queued message back into the composer. */
  reopenOutbox(id: number) { return this.compose.reopenOutbox(id); }

  newMessage() { this.compose.newMessage(); }
  replyTo(all: boolean) { this.compose.replyTo(all); }
  forwardOpened() { this.compose.forwardOpened(); }
  /** A `mailto:` link in a letter: a new letter to its address, from the default mailbox. */
  openMailto(href: string) { this.compose.openMailto(href); }

  /** A mailbox's page in the settings; the very first one is set up by the wizard alone. */
  accountSettings(acc: AccountView | null) {
    if (this.mailboxes.accounts.length === 0) this.ui.wizard = { account: null };
    else this.ui.openSettings(acc ? `account:${acc.id}` : "account:new");
  }

  /** Opens a composition window; the others fold into bars, as in Gmail. */
  openCompose(c: ComposeState, mode?: ComposeWindow["mode"]): number { return this.compose.open(c, mode); }

  /** Unfolds a window and folds the rest. */
  showCompose(id: number, mode: "open" | "max" = "open") { this.compose.show(id, mode); }
  closeCompose(id: number) { this.compose.close(id); }

  /** Keeps every composition of this window, each at most `ms`: a quit saves before it goes (#71). */
  saveComposes(ms: number) { return this.compose.saveAll(ms); }

  /** Drafts kept locally when the app last stopped: offered for restore (#71). */
  async offerLocalDrafts() {
    const drafts = (await api.draftCacheList().catch((e) => (this.ui.fail(e, t("startup.localDraftsFailed")), [] as CachedDraft[]))) ?? [];
    if (!drafts.length) return;
    this.ui.toast(
      tn("compose.localDraft", drafts.length, { n: drafts.length }),
      false,
      { label: t("compose.localDraftRestore"), run: () => void this.compose.restoreLocal(drafts) },
      30_000,
    );
  }

  /** Copies of sent letters the server refuses to keep: said once per start, until decided (#88). */
  async tellStuckCopies() {
    const stuck = (await api.stuckCopies().catch((e) => (this.ui.fail(e, t("startup.stuckCopiesFailed")), [] as StuckCopy[]))) ?? [];
    if (!stuck.length) return;
    this.ui.toast(tn("stuck.toast", stuck.length, { n: stuck.length }), false, { label: t("stuck.open"), run: () => (this.ui.tasksOpen = true) }, 30_000);
  }

  /** The window that takes dropped files: the unfolded one, else the newest. */
  activeCompose(): ComposeWindow | undefined { return this.compose.active(); }

  defaultAccount() {
    // A mailbox chosen as the default wins everywhere, the open folder included.
    const chosen = this.settingsCtl.settings.default_account_id;
    const fixed = chosen ? this.mailboxes.account(chosen) : undefined;
    if (fixed) return fixed;
    const v = this.list.view;
    if (v.kind === "folder") return this.mailboxes.account(v.account_id);
    if (this.reader.opened) return this.mailboxes.account(this.reader.opened.row.account_id);
    return this.mailboxes.accounts[0];
  }
}

export const app = new AppStore();
