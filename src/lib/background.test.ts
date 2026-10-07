// Work in the background (#4): the questions the main window asks when it is closed
// and when the app quits, the tray menu's errands, and letters that missed their time.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { quitApp } from "./background.svelte";
import { i18n } from "./i18n.svelte";
import { api, emit, flush, resetFakes, settings } from "./testing";

async function started() {
  const s = new AppStore();
  await s.init();
  s.wizard = null;
  return s;
}

beforeEach(() => {
  resetFakes();
  i18n.lang = "en";
});

describe("closing the window, asked", () => {
  it("keeps the app in the background and remembers it by default", async () => {
    const s = await started();
    emit("close-asked", { no_tray: false });
    const q = s.confirmation!;
    expect(q.title).toBe("Keep Depesha in the background?");
    expect(q.okLabel).toBe("Keep in background");
    expect(q.cancelLabel).toBe("Quit");
    expect(q.check).toEqual({ label: "Remember my choice", checked: true });
    expect(q.note).toBe("You can change it in Settings → Background and startup.");
    q.resolve(true);
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith({ ...settings(), close_action: "background" });
    expect(api.windowHide).toHaveBeenCalled();
    expect(api.appQuit).not.toHaveBeenCalled();
  });

  it("asks again next time when the choice was not remembered", async () => {
    const s = await started();
    emit("close-asked", { no_tray: false });
    s.confirmation!.check!.checked = false;
    s.confirmation!.resolve(true);
    await flush();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.windowHide).toHaveBeenCalled();
  });

  it("quits, and remembers that", async () => {
    const s = await started();
    emit("close-asked", { no_tray: false });
    s.confirmation!.resolve(false);
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith({ ...settings(), close_action: "quit" });
    // Letters waiting for their time may still stop the quit: the backend asks then.
    expect(api.appQuit).toHaveBeenCalledWith(false);
    expect(api.windowHide).not.toHaveBeenCalled();
  });

  it("leaves the window open on Esc or a click beside the dialog", async () => {
    const s = await started();
    emit("close-asked", { no_tray: false });
    s.confirmation!.resolve(null);
    await flush();
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.windowHide).not.toHaveBeenCalled();
    expect(api.appQuit).not.toHaveBeenCalled();
  });

  it("without a tray warns, and works on without the icon only when told so", async () => {
    const s = await started();
    emit("close-asked", { no_tray: true });
    const q = s.confirmation!;
    expect(q.title).toBe("There will be no tray icon");
    expect(q.okLabel).toBe("Work in the background");
    expect(q.cancelLabel).toBe("Quit");
    expect(q.check).toEqual({ label: "Don't ask again", checked: false });
    q.check!.checked = true;
    q.resolve(true);
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith({ ...settings(), close_action: "background", background_without_tray: true });
    expect(api.windowHide).toHaveBeenCalled();
  });
});

describe("quitting with letters waiting for their time", () => {
  it("lists them and quits or stays in the background", async () => {
    const s = await started();
    const at = Math.floor(new Date(2026, 9, 7, 18, 0).getTime() / 1000);
    emit("quit-asked", { letters: [{ subject: "Reconciliation", at }, { subject: "", at }] });
    const q = s.confirmation!;
    expect(q.title).toBe("Quit Depesha?");
    expect(q.text).toBe("2 letters wait to be sent on schedule. While Depesha is closed they will not go: at the next start Depesha will offer to send them.");
    expect(q.items).toHaveLength(2);
    expect(q.items![0]).toMatch(/^«Reconciliation» — /);
    expect(q.items![1]).toMatch(/^«\(no subject\)» — /);
    expect(q.okLabel).toBe("Quit");
    expect(q.cancelLabel).toBe("Keep in background");
    q.resolve(true);
    await flush();
    expect(api.appQuit).toHaveBeenCalledWith(true);

    emit("quit-asked", { letters: [{ subject: "Reconciliation", at }] });
    s.confirmation!.resolve(false);
    await flush();
    expect(api.windowHide).toHaveBeenCalled();
    expect(api.appQuit).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Q asks the backend, which knows the outbox", async () => {
    await started();
    quitApp();
    expect(api.appQuit).toHaveBeenCalledWith(false);
  });
});

describe("the tray menu's errands", () => {
  it("writes a letter, shows the unread ones and a mailbox's settings", async () => {
    const s = await started();
    const write = vi.spyOn(s, "newMessage").mockImplementation(() => {});
    emit("tray-action", { action: "compose" });
    expect(write).toHaveBeenCalled();
    emit("tray-action", { action: "unread" });
    await flush();
    expect(s.view).toEqual({ kind: "unified", role: "inbox", unread: true });
    emit("tray-action", { action: "account", account_id: "a" });
    expect(s.settingsOpen).toBe(true);
    expect(s.settingsPage).toBe("account:a");
  });
});

describe("letters that missed their time", () => {
  it("are told at start, with a way to send them now", async () => {
    api.outboxMissed.mockResolvedValue([3, 4]);
    const s = await started();
    await flush();
    const toast = s.toasts.find((x) => x.action?.label === "Send now");
    expect(toast?.text).toBe("2 letters were not sent on time: Depesha was closed or the computer was asleep.");
    toast!.action!.run();
    await flush();
    expect(api.outboxRetry.mock.calls).toEqual([[3], [4]]);
  });

  it("are told when the computer wakes up late too", async () => {
    const s = await started();
    await flush();
    api.outboxMissed.mockResolvedValue([5]);
    emit("outbox-missed");
    await flush();
    expect(s.toasts.some((x) => x.text === "1 letter was not sent on time: Depesha was closed or the computer was asleep.")).toBe(true);
  });

  it("say nothing when none missed", async () => {
    api.outboxMissed.mockResolvedValue([]);
    const s = await started();
    await flush();
    expect(s.toasts).toEqual([]);
  });
});
