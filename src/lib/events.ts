// What the backend tells the windows. Both kinds of window handle the events in `common`
// the same way; what only one of them hears is spelled out in `listenMain` and `listenWindow`.
// Every subscription starts at once: nothing said while a window starts is lost.

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { extensions, listenForMail } from "./extensions.svelte";
import { t } from "./i18n.svelte";
import { applyRules } from "./rules";
import type { Undoable } from "./actions.svelte";
import type { View } from "./list.svelte";
import type { AppStore } from "./store.svelte";
import type { AccountStatus, CmdError, Task, UpdateStatus } from "./types";

interface MailChanged {
  account_id: string;
  folder: string;
}

function common(app: AppStore) {
  return [
    listen("folders-changed", () => app.scheduleFolders()),
    listen<{ account_id: string; status: AccountStatus }>("account-status", (e) => {
      const a = app.accounts.find((x) => x.id === e.payload.account_id);
      if (a) a.status = e.payload.status;
    }),
    listen<{ subject: string }>("sent", (e) => app.toast(t("toast.sent", { subject: e.payload.subject || t("noSubject") }))),
    listen<{ error: CmdError }>("send-failed", (e) => app.toast(t("toast.sendFailed", { error: e.payload.error.message }), true)),
    // Settings saved elsewhere (another window, a plugin) may change the language too.
    listen("settings-changed", async () => {
      await app.loadSettings();
      await app.loadLanguage();
      await extensions.load();
    }),
  ];
}

/** The main window: the list, the outbox, tasks, mail rules and updates. */
export function listenMain(app: AppStore) {
  return Promise.all([
    ...common(app),
    listen<MailChanged>("mail-changed", (e) => {
      // My answers and drafts change how conversations look in every grouped list.
      const role = app.folder(e.payload.account_id, e.payload.folder)?.role;
      const threadPart = app.settings.threads && (role === "sent" || role === "drafts");
      if (threadPart || app.list.includes(e.payload.account_id, e.payload.folder)) app.scheduleReload();
      if (app.opened?.row.account_id === e.payload.account_id) app.reader.scheduleConversation();
      app.scheduleFolders();
    }),
    listen("outbox-changed", () => app.loadOutbox()),
    listen<Task[]>("tasks-changed", (e) => (app.tasks = e.payload)),
    listen<{ message: string }>("app-error", (e) => app.toast(e.payload.message, true)),
    listen<{ id: string }>("extensions-changed", (e) => {
      // A reinstalled extension starts with its new code.
      extensions.stop(e.payload.id);
      extensions.load();
    }),
    // Mail rules run in the main window only, or they would run twice.
    listenForMail((ids) => applyRules(app, ids)),
    listen<UpdateStatus>("update-status", (e) => (app.update = e.payload)),
    // A message window hands over what concerns the list.
    listen<Undoable>("window-moved", (e) => {
      app.actions.lastUndo = e.payload;
      app.toast(e.payload.text, false, { label: t("undo"), run: () => app.undo() });
      app.reload();
    }),
    listen<View>("window-view", (e) => {
      getCurrentWindow().setFocus().catch(() => {});
      app.setView(e.payload);
    }),
  ]);
}

/** A message window: no list, only the letter it shows. */
export function listenWindow(app: AppStore) {
  return Promise.all([
    ...common(app),
    listen<MailChanged>("mail-changed", (e) => {
      const row = app.opened?.row;
      if (row && row.account_id === e.payload.account_id && row.folder === e.payload.folder) app.reader.checkStillThere();
      app.scheduleFolders();
    }),
  ]);
}
