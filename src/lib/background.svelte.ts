// Work in the background (#4): the questions the main window asks for the backend —
// when it is closed (decisions, frames 1 and 3А) and when the app quits with letters
// waiting for their time (9А) — the tray menu's errands, and letters that missed
// their time (the toast of 9Б). The window itself only hides: its page keeps the
// mail rules and plugins running.

import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { t, tn } from "./i18n.svelte";
import { when } from "./later";
import { arrivals, type ArrivalsHost, type NotificationOpen } from "./arrivals.svelte";
import type { View } from "./list.svelte";
import type { Settings } from "./types";
import type { Choice, Confirmation } from "./ui.svelte";

/** What the background needs from the app store. */
export interface BackgroundHost extends ArrivalsHost {
  readonly settings: Settings;
  patchSettings(patch: Record<string, unknown>): Promise<void>;
  choose(q: Omit<Confirmation, "resolve">): Promise<Choice>;
  newMessage(): void;
  openSettings(page?: string, section?: string | null): void;
  fail(e: unknown, prefix?: string): void;
}

/** Letters late are worth a longer look than the usual toast. */
const MISSED_MS = 15000;

/** A letter waiting for its time, as the backend names it when the app quits. */
interface Due {
  subject: string;
  at: number;
}

/** Subscribes the main window to what the backend asks of it; nothing said meanwhile is lost. */
export function listenBackground(host: BackgroundHost) {
  const subscribed = [
    listen<{ no_tray: boolean }>("close-asked", (e) => void askClose(host, e.payload.no_tray)),
    listen<{ letters: Due[] }>("quit-asked", (e) => void askQuit(host, e.payload.letters)),
    listen<{ action: string; account_id?: string | null }>("tray-action", (e) => trayAction(host, e.payload.action, e.payload.account_id)),
    listen("outbox-missed", () => void tellMissed(host)),
    listen<NotificationOpen>("notification-open", (e) => void arrivals.open(host, e.payload)),
  ];
  return subscribed;
}

/** Ctrl+Q: quits for real; the backend asks first when letters wait for their time. */
export function quitApp() {
  api.appQuit(false).catch(() => {});
}

/** The close button: keep working in the background or quit, remembered unless untold. */
async function askClose(host: BackgroundHost, noTray: boolean) {
  const { answer, checked } = await host.choose(
    noTray
      ? {
          title: t("bg.noTray.title"),
          text: t("bg.noTray.text"),
          check: { label: t("bg.noTray.dontAsk"), checked: false },
          okLabel: t("bg.noTray.ok"),
          cancelLabel: t("bg.quit"),
        }
      : {
          title: t("bg.close.title"),
          text: t("bg.close.text"),
          check: { label: t("bg.close.remember"), checked: true },
          note: t("bg.close.note"),
          okLabel: t("bg.close.ok"),
          cancelLabel: t("bg.quit"),
        },
  );
  // Esc or a click beside the dialog: the window stays as it is.
  if (answer === null) return;
  if (checked) {
    // A patch of the two fields, not the whole settings from memory: what the tray or
    // another window wrote meanwhile is not rolled back.
    const patch: Record<string, unknown> = { close_action: answer ? "background" : "quit" };
    if (answer && noTray) patch.background_without_tray = true;
    await host.patchSettings(patch).catch((e) => host.fail(e));
  }
  if (answer) await api.windowHide().catch((e) => host.fail(e));
  else await api.appQuit(false).catch((e) => host.fail(e));
}

/** Quitting would hold back letters due within a day: say which, quit or stay in the background. */
async function askQuit(host: BackgroundHost, letters: Due[]) {
  const { answer } = await host.choose({
    title: t("bg.quitAsk.title"),
    text: tn("bg.quitAsk.text", letters.length, { n: letters.length }),
    items: letters.map((l) => t("bg.quitAsk.item", { subject: l.subject || t("noSubject"), when: when(l.at) })),
    okLabel: t("bg.quit"),
    cancelLabel: t("bg.close.ok"),
  });
  if (answer === true) await api.appQuit(true).catch((e) => host.fail(e));
  else if (answer === false) await api.windowHide().catch((e) => host.fail(e));
}

/** An errand from the tray menu; the backend has brought the window forward already. */
function trayAction(host: BackgroundHost, action: string, accountId?: string | null) {
  if (action === "compose") host.newMessage();
  else if (action === "unread") void host.setView({ kind: "unified", role: "inbox", unread: true } satisfies View);
  else if (action === "account" && accountId) host.openSettings(`account:${accountId}`);
}

/** Letters that missed their time wait in the outbox: one toast offers to send them now.
 * Asked again once the window started, in its language: held back before it listened. */
export async function tellMissed(host: BackgroundHost) {
  const ids = (await api.outboxMissed().catch(() => null)) ?? [];
  if (!ids.length) return;
  host.toast(
    tn("bg.missed", ids.length, { n: ids.length }),
    false,
    {
      label: t("bg.sendNow"),
      run: () => {
        for (const id of ids) api.outboxRetry(id).catch((e) => host.fail(e));
      },
    },
    MISSED_MS,
  );
}
