// A click on a desktop notification (#63). The backend brings the window forward and
// says what the notification was about; here the main window turns to it: a letter is
// selected where it is seen (decisions, frame 12В), a summary opens its inbox with the
// new letters tinted (13А), a letter gone since is told with a way to find it (14А).

import { t } from "./i18n.svelte";
import { layout } from "./layout.svelte";
import type { View } from "./list.svelte";
import type { MessageRow } from "./types";
import type { Confirmation } from "./ui.svelte";

/** What the backend sends on a click: `notification-open`. */
export interface NotificationOpen {
  /** The mailbox; null for a summary of several: all inboxes. */
  account_id: string | null;
  folder: string | null;
  /** The letter, where the cache has it now; null for a summary or a letter gone. */
  id: number | null;
  /** The new letters a summary tells about. */
  ids: number[];
  gone: { subject: string; from: string } | null;
}

/** The frame round the row a notification led to fades in this long. */
export const FLASH_MS = 1500;

/** What a click on a notification needs from the app store. */
export interface ArrivalsHost {
  readonly view: View;
  readonly messages: MessageRow[];
  readonly confirmation: Confirmation | null;
  settingsOpen: boolean;
  tasksOpen: boolean;
  setView(v: View): Promise<void>;
  select(id: number): Promise<void>;
  toast(text: string, error?: boolean, action?: { label: string; run: () => void }, ms?: number): void;
}

export class Arrivals {
  /** The row a notification led to: framed for a moment. */
  flash = $state<number | null>(null);
  /** A row to take the keyboard: the list focuses it once it is drawn. */
  focus = $state<number | null>(null);
  /** New letters of a summary, tinted while the list it opened is open. */
  private fresh = $state<Set<number>>(new Set());
  private freshIn = $state<View | null>(null);
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  /** The row is one of the new letters a summary opened this list for. */
  isFresh(view: View, id: number): boolean {
    return view === this.freshIn && this.fresh.has(id);
  }

  freshCount(view: View): number {
    return view === this.freshIn ? this.fresh.size : 0;
  }

  reset() {
    clearTimeout(this.flashTimer);
    this.flash = null;
    this.focus = null;
    this.fresh = new Set();
    this.freshIn = null;
  }

  async open(host: ArrivalsHost, p: NotificationOpen) {
    closeOverlays(host);
    if (p.id !== null) await this.openLetter(host, p, p.id);
    else await this.openList(host, p);
  }

  private async openLetter(host: ArrivalsHost, p: NotificationOpen, id: number) {
    // The open list stays when it shows the letter: a mailbox's folder, all inboxes, «Unread».
    const v = host.view;
    const stays = (v.kind === "folder" || v.kind === "unified") && host.messages.some((m) => m.id === id);
    if (!stays && p.account_id && p.folder) await host.setView({ kind: "folder", account_id: p.account_id, folder: p.folder });
    layout.showLetter();
    await host.select(id);
    this.focus = id;
    clearTimeout(this.flashTimer);
    this.flash = id;
    this.flashTimer = setTimeout(() => {
      if (this.flash === id) this.flash = null;
    }, FLASH_MS);
  }

  private async openList(host: ArrivalsHost, p: NotificationOpen) {
    const v: View = p.account_id && p.folder ? { kind: "folder", account_id: p.account_id, folder: p.folder } : { kind: "unified", role: "inbox" };
    await host.setView(v);
    layout.showList();
    if (p.gone) {
      const { subject, from } = p.gone;
      const shown = subject || t("noSubject");
      host.toast(t("arrivals.gone", { subject: shown }), false, {
        label: t("arrivals.find"),
        run: () => void host.setView({ kind: "search", text: findQuery(from, subject) }),
      });
      return;
    }
    this.fresh = new Set(p.ids);
    this.freshIn = host.view;
    // The first new row takes the keyboard, unopened: Enter opens it.
    this.focus = host.messages.find((m) => this.fresh.has(m.id))?.id ?? null;
  }
}

/** Settings, the tasks and a question on the way close without saving (decisions, #63). */
function closeOverlays(host: ArrivalsHost) {
  host.confirmation?.resolve(null);
  host.settingsOpen = false;
  host.tasksOpen = false;
}

/** A search for a letter gone from the inbox: by its sender and subject, in every folder. */
function findQuery(from: string, subject: string): string {
  const parts = from ? [`from:${from}`] : [];
  const s = subject.replace(/"/g, "").trim();
  if (s) parts.push(`subject:"${s}"`);
  return parts.join(" ");
}

export const arrivals = new Arrivals();
