// View state of the sidebar, shared by its components: folded mailboxes and folders,
// the folder context menu, the strip's flyout and the smart sections' counters. The
// state here is what the sidebar itself shows (kept between launches, as favourites and
// the layout are); the mail itself stays in `app.*`, the only entry to app state.

import type { Component } from "svelte";
import Inbox from "@lucide/svelte/icons/inbox";
import Send from "@lucide/svelte/icons/send";
import FilePen from "@lucide/svelte/icons/file-pen";
import Archive from "@lucide/svelte/icons/archive";
import ShieldAlert from "@lucide/svelte/icons/shield-alert";
import Trash from "@lucide/svelte/icons/trash-2";
import Folder from "@lucide/svelte/icons/folder";
import AlarmClock from "@lucide/svelte/icons/alarm-clock";
import { app, type View } from "../../lib/store.svelte";
import { api } from "../../lib/api";
import { initials, roleLabel } from "../../lib/format";
import { favourites, neighbour, type Favourite } from "../../lib/favourites.svelte";
import type { AccountView, FolderInfo, FolderRole } from "../../lib/types";

const COLLAPSED_KEY = "depesha.sidebar.collapsed";
const FOLDED_KEY = "depesha.sidebar.folded";

function readBooleans(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch { // A broken stored value starts from nothing.
    return {};
  }
}

const ROLE_ICON: Record<FolderRole, Component> = {
  inbox: Inbox,
  snoozed: AlarmClock,
  drafts: FilePen,
  sent: Send,
  archive: Archive,
  junk: ShieldAlert,
  trash: Trash,
};

/** The folder's icon: by its role, the plain folder for the rest. */
export function roleIcon(role: FolderRole | null): Component {
  return role ? ROLE_ICON[role] : Folder;
}

class SidebarUi {
  /** Folded mailboxes, kept between launches. */
  collapsed = $state<Record<string, boolean>>(readBooleans(COLLAPSED_KEY));
  /** Folded folders with subfolders, by account and name; kept between launches. */
  folded = $state<Record<string, boolean>>(readBooleans(FOLDED_KEY));
  /** The context menu of a folder, or of an account (folder null). */
  folderMenu = $state<{ at: { x: number; y: number }; account: AccountView; folder: FolderInfo | null } | null>(null);
  /** The account whose menu is open in the full sidebar. */
  menuFor = $state<string | null>(null);
  /** The «do not disturb» menu of the footer; open in both the full sidebar and the strip. */
  dndMenu = $state(false);
  /** The mailbox whose folders open beside the strip; a click opens them, hovering does not. */
  flyout = $state<string | null>(null);
  /** The flyout of a mailbox with favourites shows them; the whole tree opens under «All folders». */
  flyoutTree = $state(false);

  /** «Do not disturb» is on until this moment. */
  get dnd(): boolean {
    return app.settings.dnd_until > Date.now() / 1000;
  }

  toggleAccount(id: string) {
    this.collapsed = { ...this.collapsed, [id]: !this.collapsed[id] };
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(this.collapsed));
  }

  foldKey(f: FolderInfo): string {
    return `${f.account_id}\u0000${f.name}`;
  }

  /** Folded by account and name: the tree loop asks without a FolderInfo at hand. */
  foldedName(account: string, name: string): boolean {
    return !!this.folded[`${account}\u0000${name}`];
  }

  isFolded(f: FolderInfo): boolean {
    return !!this.folded[this.foldKey(f)];
  }

  fold(f: FolderInfo) {
    const key = this.foldKey(f);
    const next = { ...this.folded };
    if (next[key]) delete next[key];
    else next[key] = true;
    this.folded = next;
    localStorage.setItem(FOLDED_KEY, JSON.stringify(this.folded));
  }

  contextMenu(e: MouseEvent, account: AccountView, folder: FolderInfo | null) {
    e.preventDefault();
    this.menuFor = null;
    this.folderMenu = { at: { x: e.clientX, y: e.clientY }, account, folder };
  }

  foldersOf(acc: AccountView): FolderInfo[] {
    return app.folders.filter((f) => f.account_id === acc.id && !f.hidden);
  }

  /** The depth of the indent of a folder, from the hierarchy in its name. */
  depth(f: FolderInfo): number {
    if (!f.delimiter || f.role) return 0;
    const parts = f.name.split(f.delimiter);
    // Children of INBOX on Dovecot-style servers are shown one level deep.
    return Math.max(0, parts.length - 1 - (parts[0].toUpperCase() === "INBOX" ? 1 : 0));
  }

  label(f: FolderInfo): string {
    if (f.role) return roleLabel(f.role);
    if (!f.delimiter) return f.display_name;
    return f.display_name.split(f.delimiter).pop() ?? f.display_name;
  }

  isActive(v: View): boolean {
    const c = app.view;
    if (c.kind !== v.kind) return false;
    if (c.kind === "unified" && v.kind === "unified")
      return c.role === v.role && !!c.unread === !!v.unread && !!c.flagged === !!v.flagged;
    if (c.kind === "folder" && v.kind === "folder") return c.account_id === v.account_id && c.folder === v.folder;
    if (c.kind === "search" && v.kind === "search") return c.text === v.text;
    if (c.kind === "plugin" && v.kind === "plugin") return c.id === v.id;
    return true;
  }

  async refresh(acc: AccountView) {
    this.menuFor = null;
    try {
      await api.syncNow(acc.id);
    } catch (e) {
      app.fail(e, acc.email);
    }
  }

  favouriteOf(f: FolderInfo): Favourite {
    return { name: f.name, display: f.display_name, delimiter: f.delimiter };
  }

  /** The folder list of the mailbox has been read: a favourite missing from it is gone, not unloaded. */
  listed(acc: AccountView): boolean {
    return app.folders.some((f) => f.account_id === acc.id);
  }

  inboxUnread(acc: AccountView): number {
    return app.folders.filter((f) => f.account_id === acc.id && f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  }

  accountInitials(acc: AccountView): string {
    return initials({ name: acc.label?.trim() || acc.display_name?.trim() || acc.email.split("@")[0], email: acc.email });
  }

  /** A count on an icon: small, so big numbers are cut short. */
  badge(n: number): string {
    return n > 99 ? "99+" : String(n);
  }

  totalUnread(): number {
    return app.folders.filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  }

  /** Drafts of every mailbox, read or not: a draft is not «unread». */
  totalDrafts(): number {
    return app.folders.filter((f) => f.role === "drafts").reduce((n, f) => n + f.total, 0);
  }

  get outboxFailed(): boolean {
    return app.outbox.some((o) => o.failed);
  }

  get tasksRunning(): number {
    return app.tasks.filter((x) => x.state === "running").length;
  }

  get tasksFailed(): boolean {
    return app.tasks.some((x) => x.state === "failed");
  }
}

export const sidebarUi = new SidebarUi();

// A row leaving the favourites with the focus on its star hands the focus on: to the next
// row's star, else the one before, else the mailbox's name (the flyout's «All folders»).
// Set once, here: the sidebar may render several blocks of favourites at a time.
favourites.onleave = (account, name) => {
  const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".fav-row");
  if (!row || row.dataset.account !== account || row.dataset.folder !== name) return;
  const block = row.closest<HTMLElement>(".favs");
  const rows = [...(block?.querySelectorAll<HTMLElement>(".fav-row") ?? [])];
  const next = neighbour(rows, rows.indexOf(row))?.querySelector<HTMLElement>(".star");
  const around = block?.closest<HTMLElement>(".group, .fly-folders");
  (next ?? around?.querySelector<HTMLElement>(".account-name, .all-folders"))?.focus();
};
