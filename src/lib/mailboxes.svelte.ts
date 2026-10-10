// The mailboxes and their folders: what the sidebar shows, the outbox of queued
// letters, and the app's version. `home` is where the app starts and comes back to;
// the folders are re-read a moment after the backend says they changed.

import type { UiController } from "./ui.svelte";
import { getVersion } from "@tauri-apps/api/app";
import { accountColor } from "./format";
import { api } from "./api";
import type { View } from "./list.svelte";
import type { AccountView, FolderInfo, OutboxItem } from "./types";

/** What the mailboxes need from the app store. */
export interface MailboxHost {
  readonly ui: Pick<UiController, "fail">;
}

export class MailboxController {
  accounts = $state<AccountView[]>([]);
  folders = $state<FolderInfo[]>([]);
  outbox = $state<OutboxItem[]>([]);
  /** The app's version, shown quietly in the sidebar. */
  version = $state("");

  private foldersTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: MailboxHost) {}

  initVersion() {
    // The version is shown in «About» only; without it the line stays empty.
    getVersion().then((v) => (this.version = v), () => {});
  }

  async loadAccounts() {
    this.accounts = await api.accounts();
  }

  scheduleFolders() {
    if (this.foldersTimer) return;
    this.foldersTimer = setTimeout(() => {
      this.foldersTimer = null;
      this.loadFolders();
    }, 400);
  }

  async loadFolders() {
    try {
      this.folders = await api.folders();
    } catch (e) {
      this.host.ui.fail(e);
    }
  }

  /**
   * The first read of the sidebar's data: the folders and the outbox are put in together. The row «Outbox»
   * that came after the tree was drawn pushed the tree down under the pointer (#158). A request that fails
   * is told and does not hold up the other.
   */
  async loadFoldersAndOutbox() {
    const [folders, outbox] = await Promise.allSettled([api.folders(), api.outbox()]);
    if (folders.status === "fulfilled") this.folders = folders.value;
    else this.host.ui.fail(folders.reason);
    if (outbox.status === "fulfilled") this.outbox = outbox.value;
    else this.host.ui.fail(outbox.reason);
  }

  async loadOutbox() {
    try {
      this.outbox = await api.outbox();
    } catch (e) {
      this.host.ui.fail(e);
    }
  }

  account(id: string) {
    return this.accounts.find((a) => a.id === id);
  }

  /** The colour that marks a mailbox in the sidebar and in shared lists. */
  accountColor(id: string): string {
    const i = this.accounts.findIndex((a) => a.id === id);
    return accountColor(this.accounts[i], i);
  }

  folder(accountId: string, name: string) {
    return this.folders.find((f) => f.account_id === accountId && f.name === name);
  }

  /** Where the app starts and comes back to: all inboxes, or the only account's inbox. */
  home(): View {
    if (this.accounts.length !== 1) return { kind: "unified", role: "inbox" };
    const id = this.accounts[0].id;
    const inbox = this.folders.find((f) => f.account_id === id && f.role === "inbox");
    return { kind: "folder", account_id: id, folder: inbox?.name ?? "INBOX" };
  }
}
