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
  /**
   * A third answer beside the other two: `resolve(null)`, the same as a dismissal (Esc).
   * For a question with three outcomes, such as leaving a page with unsaved changes.
   */
  altLabel?: string;
  /** The action loses something: the safe button gets the focus. */
  danger?: boolean;
  /** A box to tick under the text («Remember my choice»); the dialog changes `checked`. */
  check?: { label: string; checked: boolean };
  /** A quiet line under the box: where the choice can be changed later. */
  note?: string;
  /** Lines shown apart from the text, in a box: letters waiting to be sent. */
  items?: string[];
  /** The answer: the main button, the other one, or null when the dialog was dismissed (Esc, a click beside it). */
  resolve: (ok: boolean | null) => void;
}

/** An answer of `choose`: which button, and the box under the text. */
export interface Choice {
  answer: boolean | null;
  checked: boolean;
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
  /** The page it opens on: "reading", "storage", "keys", "accounts", "account:<id>", "account:new", "plugins"… (the ids of before 0.8, such as "general", are read as their new pages). */
  settingsPage = $state("reading");
  /** A section of a mailbox's page to open the settings at (`storage`), once. */
  settingsSection: string | null = null;
  /** Where the address book opens in the main window: at a person and a filter, once (a link from the settings; #104). */
  peopleFocus: { email?: string; filter?: "all" | "ruled" | "manual" | "hidden" } | null = null;
  /** Counts the requests to open the book at a place: an open book turns to it. */
  peopleTurn = $state(0);
  /** Puts the focus into the search of the book; set by the book while it is shown. */
  focusPeople: () => void = () => {};
  /** Counts the requests to open the card of the open letter's sender (its key, #104). */
  senderCard = $state(0);
  /** A command to open the «Keys» page at (the palette's Alt+Enter), once. */
  settingsKeys: { id: string; title: string } | null = null;
  /** Counts `openSettings` calls: an already open settings window turns to the page asked for. */
  settingsTurn = $state(0);
  /** Asked before the open settings page is left: a mailbox's page with unsaved changes or a check under way. */
  settingsLeave: (() => Promise<boolean>) | null = null;
  /** Takes back the last change of the open mailbox's page (Ctrl+Z); that page saves apart from the rows. */
  settingsUndo: (() => Promise<boolean>) | null = null;
  /** Focuses the search box; set by the window that owns it. */
  focusSearch: () => void = () => {};

  private toastSeq = 0;

  toast(text: string, error = false, action?: Toast["action"], ms?: number): number {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, error, action });
    setTimeout(() => this.dismiss(id), ms ?? (error ? 12000 : action ? 8000 : 4000));
    return id;
  }

  /** Changes the text of a toast still on the screen (a countdown); false when it is gone. */
  retext(id: number, text: string): boolean {
    const toast = this.toasts.find((t) => t.id === id);
    if (toast) toast.text = text;
    return !!toast;
  }

  /** Asks in the app's own dialog; true when the user agreed. */
  async confirm(q: Omit<Confirmation, "resolve">): Promise<boolean> {
    return (await this.choose(q)).answer === true;
  }

  /** Asks with two answers and a dismissal apart, and the state of the box under the text. */
  choose(q: Omit<Confirmation, "resolve">): Promise<Choice> {
    this.confirmation?.resolve(null);
    return new Promise((resolve) => {
      this.confirmation = {
        ...q,
        resolve: (answer) => {
          // The dialog ticks the box of the state's copy, not of `q`.
          const checked = this.confirmation?.check?.checked ?? false;
          this.confirmation = null;
          resolve({ answer, checked });
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

  openSettings(page = "reading", section: string | null = null) {
    this.settingsPage = page;
    this.settingsSection = section;
    this.settingsTurn++;
    this.settingsOpen = true;
  }

  /**
   * Opens Settings → «Keys» at a command, highlighting its row; `command` empty only opens
   * the page. A command without a row there is found by `title` (the palette's Alt+Enter, #46).
   */
  editKeys(command: string, title: string) {
    if (command) this.settingsKeys = { id: command, title };
    this.openSettings("keys");
  }

  /** Opens a web link after confirming the real address with the user. */
  async openLink(href: string) {
    const ok = await this.confirm({ text: t("link.open"), detail: href, okLabel: t("link.openButton") });
    if (ok) api.openLink(href).catch((e) => this.fail(e));
  }
}
