// A click on a desktop notification (#63): the backend shows the window and says what
// the notification was about; the main window turns to it (decisions, frames 12В–14А).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { FLASH_MS, arrivals } from "./arrivals.svelte";
import { i18n } from "./i18n.svelte";
import { api, emit, flush, opened, resetFakes, row } from "./testing";
import type { AccountView, FolderInfo } from "./types";

const acc = (id: string, label: string): AccountView =>
  ({ id, label, display_name: label, email: `${id}@example.com`, username: id, imap: { host: "h", port: 993, security: "tls" }, smtp: { host: "h", port: 465, security: "tls" }, save_sent_copy: true, status: null }) as unknown as AccountView;

const folder = (account_id: string, name: string, role: FolderInfo["role"]): FolderInfo =>
  ({ account_id, name, display_name: name, delimiter: "/", role, selectable: true, hidden: false, total: 10, unread: 1 }) as FolderInfo;

/** A main window with two mailboxes, started and showing all inboxes. */
async function started() {
  api.accounts.mockResolvedValue([acc("a", "Работа"), acc("b", "Личное")]);
  api.folders.mockResolvedValue([folder("a", "INBOX", "inbox"), folder("a", "Archive", "archive"), folder("b", "INBOX", "inbox")]);
  const s = new AppStore();
  await s.init();
  return s;
}

const letter = (id: number, extra = {}) => ({ account_id: "a", folder: "INBOX", id, ids: [id], gone: null, ...extra });

beforeEach(() => {
  resetFakes();
  i18n.lang = "en";
  api.open.mockImplementation(async (id: number) => opened(row(id)));
  arrivals.reset();
});

afterEach(() => vi.useRealTimers());

describe("a click on a notification about one letter", () => {
  it("stays in the open list when the letter is in it, and frames its row for a moment", async () => {
    vi.useFakeTimers();
    api.messages.mockResolvedValue([row(1), row(7), row(9)]);
    const s = await started();
    const view = s.view;
    emit("notification-open", letter(7));
    await flush();
    expect(s.view).toBe(view);
    expect([...s.selection.selected]).toEqual([7]);
    expect(s.opened?.row.id).toBe(7);
    expect(arrivals.flash).toBe(7);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(arrivals.flash).toBe(7);
    vi.advanceTimersByTime(1);
    expect(arrivals.flash).toBeNull();
  });

  it("stays in «Unread» and in the mailbox's own inbox too", async () => {
    api.messages.mockResolvedValue([row(7)]);
    const s = await started();
    for (const v of [{ kind: "unified", role: "inbox", unread: true } as const, { kind: "folder", account_id: "a", folder: "INBOX" } as const]) {
      await s.selection.setView(v);
      const view = s.view;
      emit("notification-open", letter(7));
      await flush();
      expect(s.view).toBe(view);
      expect([...s.selection.selected]).toEqual([7]);
    }
  });

  it("goes to the mailbox's inbox from a list without the letter", async () => {
    api.messages.mockResolvedValue([row(1), row(2)]);
    const s = await started();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "Archive" });
    api.messages.mockResolvedValue([row(7), row(1)]);
    emit("notification-open", letter(7));
    await flush();
    expect(s.view).toEqual({ kind: "folder", account_id: "a", folder: "INBOX" });
    expect([...s.selection.selected]).toEqual([7]);
    expect(s.opened?.row.id).toBe(7);
    expect(arrivals.flash).toBe(7);
  });

  it("leaves a search and a plugin's list for the inbox even when they show the letter", async () => {
    api.messages.mockResolvedValue([row(7)]);
    api.search.mockResolvedValue([row(7)]);
    const s = await started();
    for (const v of [{ kind: "search", text: "счёт" } as const, { kind: "plugin", id: "followups" } as const]) {
      await s.selection.setView(v);
      emit("notification-open", letter(7));
      await flush();
      expect(s.view).toEqual({ kind: "folder", account_id: "a", folder: "INBOX" });
      expect([...s.selection.selected]).toEqual([7]);
    }
  });

});

describe("a click on a notification about a letter moved or gone", () => {
  it("opens a letter moved since in its new folder", async () => {
    api.messages.mockResolvedValue([row(1)]);
    const s = await started();
    emit("notification-open", letter(42, { folder: "Archive" }));
    await flush();
    expect(s.view).toEqual({ kind: "folder", account_id: "a", folder: "Archive" });
    expect(s.opened?.row.id).toBe(42);
  });

  it("says a letter is gone and offers to find it", async () => {
    api.messages.mockResolvedValue([row(1)]);
    const s = await started();
    await s.selection.setView({ kind: "unified", role: "inbox", flagged: true });
    emit("notification-open", { account_id: "a", folder: "INBOX", id: null, ids: [], gone: { subject: "Invoice for October", from: "ivan.petrov@example.com" } });
    await flush();
    expect(s.view).toEqual({ kind: "folder", account_id: "a", folder: "INBOX" });
    expect(s.selection.selected.size).toBe(0);
    const toast = s.ui.toasts.find((x) => x.text.includes("«Invoice for October»"));
    expect(toast?.text).toBe("«Invoice for October» is no longer in the Inbox: it was moved or deleted.");
    expect(toast?.action?.label).toBe("Find");
    toast?.action?.run();
    await flush();
    expect(s.view).toEqual({ kind: "search", text: 'from:ivan.petrov@example.com subject:"Invoice for October"' });
  });

});

describe("a click on a notification about letters that missed their time", () => {
  it("opens the Outbox rather than a letter", async () => {
    const s = await started();
    emit("notification-open", { account_id: null, folder: null, id: null, ids: [], outbox: true, gone: null });
    await flush();
    expect(s.view).toEqual({ kind: "outbox" });
    expect(s.selection.selected.size).toBe(0);
    expect(s.opened).toBeNull();
  });
});

describe("a click on a notification over the settings or a question", () => {
  it("leaves the settings, the tasks and a question alone, and says the letter opened behind them", async () => {
    api.messages.mockResolvedValue([row(7)]);
    const s = await started();
    s.ui.openSettings("general");
    s.ui.tasksOpen = true;
    const answer = s.ui.confirm({ text: "Discard the draft?", okLabel: "Discard" });
    emit("notification-open", letter(7));
    await flush();
    // Nothing is closed and nothing is saved: the overlays stay as they were.
    expect(s.ui.settingsOpen).toBe(true);
    expect(s.ui.tasksOpen).toBe(true);
    expect(s.ui.confirmation).not.toBeNull();
    expect(api.settingsPatch).not.toHaveBeenCalled();
    // The letter opens behind them, and a word says so.
    expect([...s.selection.selected]).toEqual([7]);
    expect(s.ui.toasts.some((x) => x.text === "The letter opened in the background.")).toBe(true);
    // The question still waits for its answer.
    s.ui.confirmation?.resolve(null);
    await expect(answer).resolves.toBe(false);
  });
});

describe("a click on a summary", () => {
  it("opens the mailbox's inbox with nothing chosen and the new letters tinted", async () => {
    api.messages.mockResolvedValue([row(1), row(2), row(3), row(4)]);
    const s = await started();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "Archive" });
    emit("notification-open", { account_id: "a", folder: "INBOX", id: null, ids: [1, 2, 3], gone: null });
    await flush();
    expect(s.view).toEqual({ kind: "folder", account_id: "a", folder: "INBOX" });
    expect(s.selection.selected.size).toBe(0);
    expect(s.opened).toBeNull();
    expect([1, 2, 3, 4].map((id) => arrivals.isFresh(s.view, id))).toEqual([true, true, true, false]);
    expect(arrivals.freshCount(s.view)).toBe(3);
    // The first new row takes the keyboard, unopened: Enter opens it.
    expect(arrivals.focus).toBe(1);
  });

  it("of every mailbox opens all inboxes", async () => {
    api.messages.mockResolvedValue([row(1), row(2, { account_id: "b" })]);
    const s = await started();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "Archive" });
    emit("notification-open", { account_id: null, folder: null, id: null, ids: [1, 2], gone: null });
    await flush();
    expect(s.view).toEqual({ kind: "unified", role: "inbox" });
    expect(arrivals.isFresh(s.view, 2)).toBe(true);
  });

  it("keeps the tint only while its list is open", async () => {
    api.messages.mockResolvedValue([row(1), row(2)]);
    const s = await started();
    emit("notification-open", { account_id: "a", folder: "INBOX", id: null, ids: [1, 2], gone: null });
    await flush();
    const tinted = s.view;
    expect(arrivals.isFresh(tinted, 1)).toBe(true);
    // Reading one keeps the list as it is: the tint stays.
    await s.selection.select(1);
    expect(arrivals.isFresh(s.view, 1)).toBe(true);
    await s.selection.setView({ kind: "unified", role: "inbox" });
    expect(arrivals.isFresh(s.view, 1)).toBe(false);
    // Coming back is another visit: no tint.
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    expect(arrivals.isFresh(s.view, 1)).toBe(false);
    expect(arrivals.freshCount(s.view)).toBe(0);
  });
});
