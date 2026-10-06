// The app's own overlays: toasts and the question dialog, the wizard, the settings
// window, the tasks panel — and the progress line of user actions that wait for the
// server. Nothing here reaches the server on its own: the app store keeps `app.*` as
// the interface's one way in.

import { api, asError } from "./api";
import { t } from "./i18n.svelte";
import type { Account, Task } from "./types";

export interface Toast {
  id: number;
  text: string;
  error: boolean;
  action?: { label: string; run: () => void };
}

export interface Confirmation {
  title?: string;
  text: string;
  /** Shown apart from the text, in monospace: a link's real address. */
  detail?: string;
  okLabel: string;
  cancelLabel?: string;
  /** The action loses something: the safe button gets the focus. */
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export interface WizardState {
  /** Existing account when editing. */
  account: Account | null;
}

export class UiController {
  toasts = $state<Toast[]>([]);
  /** The question the app waits an answer to (`confirm`), drawn above every dialog. */
  confirmation = $state<Confirmation | null>(null);
  wizard = $state<WizardState | null>(null);
  /** User actions still talking to the server; the list shows a progress line meanwhile. */
  busy = $state(0);
  /** Background work: running, and failed until dismissed. */
  tasks = $state<Task[]>([]);
  tasksOpen = $state(false);
  /** One window for every setting: the app's, the mailboxes', the plugins'. */
  settingsOpen = $state(false);
  /** The page it opens on: "general", "offline", "accounts", "account:<id>", "account:new", "plugins"… */
  settingsPage = $state("general");
  /** A section of a mailbox's page to open the settings at (`storage`), once. */
  settingsSection: string | null = null;
  /** Counts `openSettings` calls: an already open settings window turns to the page asked for. */
  settingsTurn = $state(0);
  /** Asked before the open settings page is left: a mailbox's page with unsaved changes or a check under way. */
  settingsLeave: (() => Promise<boolean>) | null = null;
  /** Focuses the search box; set by the window that owns it. */
  focusSearch: () => void = () => {};

  private toastSeq = 0;

  toast(text: string, error = false, action?: Toast["action"], ms?: number) {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, error, action });
    setTimeout(() => this.dismiss(id), ms ?? (error ? 12000 : action ? 8000 : 4000));
  }

  /** Asks in the app's own dialog; true when the user agreed. */
  confirm(q: Omit<Confirmation, "resolve">): Promise<boolean> {
    this.confirmation?.resolve(false);
    return new Promise((resolve) => {
      this.confirmation = {
        ...q,
        resolve: (ok) => {
          this.confirmation = null;
          resolve(ok);
        },
      };
    });
  }

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  fail(e: unknown, prefix = "") {
    const err = asError(e);
    this.toast(prefix ? `${prefix}: ${err.message}` : err.message, true);
  }

  /** Runs a user action that waits for the server, with the progress line shown meanwhile. */
  async track<T>(p: Promise<T>): Promise<T> {
    this.busy++;
    try {
      return await p;
    } finally {
      this.busy--;
    }
  }

  openSettings(page = "general", section: string | null = null) {
    this.settingsPage = page;
    this.settingsSection = section;
    this.settingsTurn++;
    this.settingsOpen = true;
  }

  /** Opens a web link after confirming the real address with the user. */
  async openLink(href: string) {
    const ok = await this.confirm({ text: t("link.open"), detail: href, okLabel: t("link.openButton") });
    if (ok) api.openLink(href).catch((e) => this.fail(e));
  }
}
