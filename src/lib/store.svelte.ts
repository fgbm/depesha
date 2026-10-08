import { api } from "./api";
import { extensions } from "./extensions.svelte";
import { listenMain, listenWindow } from "./events";
import { tellMissed } from "./background.svelte";
import { ListController, type View } from "./list.svelte";
import { ActionRunner } from "./actions.svelte";
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
import type { AccountView, ComposeDraft, FollowupPlan, KeySettings, MessageRow, Moved, SortKey } from "./types";

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

  /**
   * The letter a separate message window shows (double click in the list); null in the
   * main window. Such a window has no list: actions on its letter close it, and what
   * concerns the list (undo, a search by sender) goes to the main window.
   */
  windowOf = $state<number | null>(null);

  // State that lives in a module, read and written through the store as before.
  get accounts() { return this.mailboxes.accounts; }
  set accounts(v) { this.mailboxes.accounts = v; }
  get folders() { return this.mailboxes.folders; }
  get outbox() { return this.mailboxes.outbox; }
  get version() { return this.mailboxes.version; }
  get settings() { return this.settingsCtl.settings; }
  set settings(v) { this.settingsCtl.settings = v; }
  get update() { return this.settingsCtl.update; }
  set update(v) { this.settingsCtl.update = v; }
  get toasts() { return this.ui.toasts; }
  get confirmation() { return this.ui.confirmation; }
  set confirmation(v) { this.ui.confirmation = v; }
  get wizard() { return this.ui.wizard; }
  set wizard(v) { this.ui.wizard = v; }
  get busy() { return this.ui.busy; }
  get tasks() { return this.ui.tasks; }
  set tasks(v) { this.ui.tasks = v; }
  get tasksOpen() { return this.ui.tasksOpen; }
  set tasksOpen(v) { this.ui.tasksOpen = v; }
  get settingsOpen() { return this.ui.settingsOpen; }
  set settingsOpen(v) { this.ui.settingsOpen = v; }
  get settingsPage() { return this.ui.settingsPage; }
  set settingsPage(v) { this.ui.settingsPage = v; }
  get settingsSection() { return this.ui.settingsSection; }
  set settingsSection(v) { this.ui.settingsSection = v; }
  get settingsKeys() { return this.ui.settingsKeys; }
  set settingsKeys(v) { this.ui.settingsKeys = v; }
  get settingsTurn() { return this.ui.settingsTurn; }
  get settingsLeave() { return this.ui.settingsLeave; }
  set settingsLeave(v) { this.ui.settingsLeave = v; }
  get focusSearch() { return this.ui.focusSearch; }
  set focusSearch(v) { this.ui.focusSearch = v; }

  get selected() { return this.selection.selected; }
  set selected(v) { this.selection.selected = v; }
  get anchor() { return this.selection.anchor; }
  set anchor(v) { this.selection.anchor = v; }
  get view() { return this.list.view; }
  get messages() { return this.list.messages; }
  get exhausted() { return this.list.exhausted; }
  get loadingMore() { return this.list.loadingMore; }
  get serverSearching() { return this.list.serverSearching; }
  /** Rows the server-side search found, kept across list reloads. */
  get serverRows() { return this.list.serverRows; }
  /** How many letters the search finds in the cache and their size. */
  get searchTotals() { return this.list.totals; }
  /** The last move that can be taken back with "z". */
  get lastUndo() { return this.actions.lastUndo; }
  /** Compositions in progress, oldest first; at most one is unfolded. */
  get composes() { return this.compose.windows; }
  get opened() { return this.reader.opened; }
  get openError() { return this.reader.openError; }
  get opening() { return this.reader.opening; }
  /** The list row of the message being opened: its header shows at once, before the body arrives. */
  get openingRow() { return this.reader.openingRow; }
  get allowRemote() { return this.reader.allowRemote; }
  /** The opened message's conversation, oldest first; empty for a lone message. */
  get conversation() { return this.reader.conversation; }

  // Settings, mailboxes, overlays and the selection.
  loadLanguage() { return this.settingsCtl.loadLanguage(); }
  loadSettings() { return this.settingsCtl.loadSettings(); }
  patchSettings(patch: Record<string, unknown>) { return this.settingsCtl.patchSettings(patch); }
  saveKeybindings(next: KeySettings) { return this.settingsCtl.saveKeybindings(next); }
  savePluginSettings(plugin: string, values: Record<string, unknown>) { return this.settingsCtl.savePluginSettings(plugin, values); }
  checkUpdates() { return this.settingsCtl.checkUpdates(); }
  installUpdate() { return this.settingsCtl.installUpdate(); }
  restartForUpdate() { this.settingsCtl.restartForUpdate(); }
  loadAccounts() { return this.mailboxes.loadAccounts(); }
  scheduleFolders() { this.mailboxes.scheduleFolders(); }
  loadFolders() { return this.mailboxes.loadFolders(); }
  loadOutbox() { return this.mailboxes.loadOutbox(); }
  account(id: string) { return this.mailboxes.account(id); }
  accountColor(id: string) { return this.mailboxes.accountColor(id); }
  folder(accountId: string, name: string) { return this.mailboxes.folder(accountId, name); }
  /** Where the app starts and comes back to: all inboxes, or the only account's inbox. */
  home(): View { return this.mailboxes.home(); }
  toast(text: string, error = false, action?: { label: string; run: () => void }, ms?: number) { this.ui.toast(text, error, action, ms); }
  confirm(q: Omit<Confirmation, "resolve">) { return this.ui.confirm(q); }
  /** Asks with two answers and a dismissal apart, and a box to tick. */
  choose(q: Omit<Confirmation, "resolve">) { return this.ui.choose(q); }
  dismiss(id: number) { this.ui.dismiss(id); }
  fail(e: unknown, prefix = "") { this.ui.fail(e, prefix); }
  track<T>(p: Promise<T>) { return this.ui.track(p); }
  openSettings(page = "general", section: string | null = null) { this.ui.openSettings(page, section); }
  /** Opens Settings → «Keys» at a command, highlighting its row (the palette's Alt+Enter, #46). */
  editKeys(command: string, title: string) { this.ui.editKeys(command, title); }
  /** Opens a web link after confirming the real address with the user. */
  openLink(href: string) { return this.ui.openLink(href); }
  inboxLike() { return this.selection.inboxLike(); }
  listKey() { return this.selection.listKey(); }
  listFilter() { return this.selection.listFilter(); }
  sort() { return this.selection.sort(); }
  ownSort() { return this.selection.ownSort(); }
  /** Orders the current list (`own`), or every list without an order of its own. */
  setSort(sort: SortKey[], own = this.ownSort()) { return this.selection.setSort(sort, own); }
  /** Bytes of the selected rows: a conversation counts with its letters in the list. */
  selectedSize(): number { return this.selection.selectedSize(); }
  /** Selects every row of the list: "Select all found" in a search, Ctrl+A. */
  selectAll() { this.selection.selectAll(); }
  scheduleReload() { this.selection.scheduleReload(); }
  /** Reloads the current list keeping as many rows as are shown now; a message window has none. */
  reload() { return this.selection.reload(); }
  /** Letters the reader shows now: the open one and its conversation. */
  showing(): number[] { return this.selection.showing(); }
  /** Rows the user is on: the selection and the open letter. */
  using(): number[] { return [...this.selected, ...(this.opened ? [this.opened.row.id] : [])]; }
  /** The list was read again: selections of rows that disappeared (moved, deleted elsewhere) go. */
  listed(ids: Set<number>, search: boolean): Promise<void> { return this.selection.listed(ids, search); }
  /** Searches on the servers too: finds mail older than the local cache. */
  searchServer() { return this.selection.searchServer(); }
  loadMore() { return this.selection.loadMore(); }
  setView(v: View) { return this.selection.setView(v); }
  select(id: number, mode: "single" | "toggle" | "range" = "single") { return this.selection.select(id, mode); }
  move(step: 1 | -1) { this.selection.move(step); }
  selectedIds(): number[] { return this.selection.selectedIds(); }
  /** Takes rows out of the list and opens the next one: triage keeps going. */
  takeOut(ids: number[]) { this.selection.takeOut(ids); }
  /** Reads or (un)flags rows: the list keeps them and their place meanwhile. */
  flag(change: "seen" | "flagged", value: boolean, ids = this.selectedIds()) { return this.selection.flag(change, value, ids); }
  /** Opens a letter in a window of its own; a draft opens in the composer instead. */
  openWindow(row: MessageRow) { return this.selection.openWindow(row); }

  async init() {
    this.mailboxes.initVersion();
    extensions.toast = (text, error) => this.toast(text, error);
    await listenMain(this);
    await this.loadLanguage();
    // Each request that fails is told and does not hold up the others.
    const [accounts] = await Promise.all([
      this.loadAccounts().then(() => true, (e) => (this.fail(e), false)),
      this.loadFolders(),
      this.loadOutbox(),
      this.loadSettings(),
      extensions.load(),
      hints.load(),
      peopleBook.load(),
      api.tasks().then((tasks) => (this.tasks = tasks), (e) => this.fail(e)),
      api.updateStatus().then((u) => (this.update = u), (e) => this.fail(e)),
    ]);
    this.list.view = this.home();
    // Mailboxes filling up warn once the accounts and the settings are read.
    rooms.start(this);
    labels.start(this);
    void Promise.all(this.accounts.map((a) => labels.load(a.id)));
    await this.reload();
    void tellMissed(this);
    // Unknown mailboxes are not no mailboxes: the wizard waits for a list it could read.
    if (accounts && this.accounts.length === 0) this.wizard = { account: null };
  }

  /** A separate window with one letter: no list, no background work of its own. */
  async initWindow(id: number) {
    this.windowOf = id;
    extensions.toast = (text, error) => this.toast(text, error);
    await listenWindow(this);
    await this.loadLanguage();
    await Promise.all([this.loadAccounts().catch((e) => this.fail(e)), this.loadFolders(), this.loadSettings(), extensions.load(), hints.load(), peopleBook.load()]);
    this.selected = new Set([id]);
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
  perform(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    return this.actions.perform(text, ids, run, failText);
  }

  remove(ids = this.selectedIds()) { return this.actions.remove(ids); }
  moveTo(folder: string, ids = this.selectedIds()) { return this.actions.moveTo(folder, ids); }
  /** "Done": out of the inbox, into the archive. */
  archive(ids = this.selectedIds()) { return this.actions.archive(ids); }
  spam(ids = this.selectedIds()) { return this.actions.spam(ids); }
  undo() { return this.actions.undo(); }

  /** Queues the composition; it leaves after the undo delay or at `at`. */
  send(accountId: string, draft: ComposeDraft, draftId: number | null, at: number | null, followupSecs: number | null, followup: FollowupPlan | null = null) {
    return this.compose.send(accountId, draft, draftId, at, followupSecs, followup);
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
    if (this.accounts.length === 0) this.wizard = { account: null };
    else this.openSettings(acc ? `account:${acc.id}` : "account:new");
  }

  /** Opens a composition window; the others fold into bars, as in Gmail. */
  openCompose(c: ComposeState, mode?: ComposeWindow["mode"]): number { return this.compose.open(c, mode); }

  /** Unfolds a window and folds the rest. */
  showCompose(id: number, mode: "open" | "max" = "open") { this.compose.show(id, mode); }
  closeCompose(id: number) { this.compose.close(id); }

  /** The window that takes dropped files: the unfolded one, else the newest. */
  activeCompose(): ComposeWindow | undefined { return this.compose.active(); }

  defaultAccount() {
    // A mailbox chosen as the default wins everywhere, the open folder included.
    const chosen = this.settings.default_account_id;
    const fixed = chosen ? this.account(chosen) : undefined;
    if (fixed) return fixed;
    const v = this.view;
    if (v.kind === "folder") return this.account(v.account_id);
    if (this.opened) return this.account(this.opened.row.account_id);
    return this.accounts[0];
  }
}

export const app = new AppStore();
