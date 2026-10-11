// @vitest-environment jsdom
// A sync the server refused for its login offers «Sign in again», not a retry that fails the same way (#166).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import Tasks from "./Tasks.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, resetFakes, settings } from "../lib/testing";
import type { AccountView, CmdError, Task } from "../lib/types";

const account = (over: Partial<AccountView>): AccountView =>
  ({
    id: "a",
    display_name: "Jane",
    email: "jane@example.com",
    username: "jane@example.com",
    imap: { host: "imap.example.com", port: 993, security: "tls" },
    smtp: { host: "smtp.example.com", port: 465, security: "tls" },
    save_sent_copy: true,
    attachments_dir: "",
    status: null,
    ...over,
  }) as AccountView;

const failed = (error: CmdError, kind: Task["kind"] = "sync"): Task => ({
  key: `${kind}:a`,
  kind,
  account_id: "a",
  label: "Синхронизация jane@example.com",
  done: 0,
  total: 0,
  state: "failed",
  started: 1,
  error,
});

let view: ReturnType<typeof mount> | null = null;

function open(task: Task) {
  app.ui.tasks = [task];
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(Tasks, { target, props: {} });
  flushSync();
  const button = [...target.querySelectorAll<HTMLButtonElement>(".task.failed button.small-btn")];
  return button;
}

beforeEach(() => {
  resetFakes();
  // The fakes stub a bare window; the cards listen on the real one.
  vi.unstubAllGlobals();
  i18n.lang = "ru";
  api.syncOverview.mockResolvedValue([]);
  api.taskDismiss.mockResolvedValue(undefined);
  api.oauthProviders.mockResolvedValue([{ provider: "google", title: "Google", configured: true }]);
  api.accountCheck.mockResolvedValue(undefined);
  api.accountSave.mockResolvedValue(account({}));
  app.settingsCtl.settings = settings();
  app.ui.tasksOpen = true;
  app.ui.settingsOpen = false;
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("a failed sync in the tasks window", () => {
  it("a refused OAuth login offers to sign in again and does it, then the task goes", async () => {
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    api.oauthSignIn.mockResolvedValue({ id: "g1", provider: "google", email: "jane@example.com", name: null, imap: account({}).imap, smtp: account({}).smtp });
    const buttons = open(failed({ kind: "auth", message: "Token has been expired or revoked." }));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Войти заново"]);

    buttons[0].click();
    await vi.waitFor(() => expect(api.taskDismiss).toHaveBeenCalledWith("sync:a"));
    expect(api.oauthSignIn).toHaveBeenCalledWith("google", "jane@example.com");
    expect(api.accountSave).toHaveBeenCalledTimes(1);
    expect(api.accountSave.mock.calls[0][2]).toBe("g1");
    // The save restarts the sync by itself: no manual sync is asked for.
    expect(api.syncNow).not.toHaveBeenCalled();
  });

  it("a refused sign-in keeps the task and shows the error", async () => {
    const fail = vi.spyOn(app.ui, "fail").mockImplementation(() => {});
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    api.oauthSignIn.mockRejectedValue({ kind: "auth", message: "access denied" });
    const buttons = open(failed({ kind: "auth", message: "Token has been expired or revoked." }));
    buttons[0].click();
    await vi.waitFor(() => expect(fail).toHaveBeenCalled());
    expect(fail.mock.calls[0][0]).toMatchObject({ message: "access denied" });
    expect(api.taskDismiss).not.toHaveBeenCalled();
    expect(api.accountSave).not.toHaveBeenCalled();
  });

  it("a check the server rejects keeps the task and shows the error", async () => {
    const fail = vi.spyOn(app.ui, "fail").mockImplementation(() => {});
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    api.oauthSignIn.mockResolvedValue({ id: "g1", provider: "google", email: "jane@example.com", name: null, imap: account({}).imap, smtp: account({}).smtp });
    api.accountCheck.mockRejectedValue({ kind: "auth", message: "IMAP: login rejected" });
    const buttons = open(failed({ kind: "auth", message: "Token has been expired or revoked." }));
    buttons[0].click();
    await vi.waitFor(() => expect(fail).toHaveBeenCalled());
    expect(fail.mock.calls[0][0]).toMatchObject({ message: "IMAP: login rejected" });
    expect(api.accountSave).not.toHaveBeenCalled();
    expect(api.taskDismiss).not.toHaveBeenCalled();
  });

  it("what was changed in the mailbox during the browser wait is saved, not the old copy", async () => {
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    api.oauthSignIn.mockImplementation(async () => {
      app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" }, signatures: [{ id: "s1", name: "Новая", text: "С уважением" }] as never })];
      return { id: "g1", provider: "google", email: "jane@example.com", name: null, imap: account({}).imap, smtp: account({}).smtp };
    });
    open(failed({ kind: "auth", message: "Token has been expired or revoked." }))[0].click();
    await vi.waitFor(() => expect(api.accountSave).toHaveBeenCalled());
    expect(api.accountSave.mock.calls[0][0].signatures).toMatchObject([{ id: "s1", name: "Новая" }]);
  });

});

describe("a failed task in the tasks window, more", () => {
  it("a double click signs in once, and the button waits meanwhile", async () => {
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    let finish: (e: unknown) => void = () => {};
    api.oauthSignIn.mockImplementation(() => new Promise((_, reject) => (finish = reject)));
    const buttons = open(failed({ kind: "auth", message: "Token has been expired or revoked." }));
    vi.spyOn(app.ui, "fail").mockImplementation(() => {});
    buttons[0].click();
    flushSync();
    expect(buttons[0].disabled).toBe(true);
    buttons[0].click();
    await tick();
    expect(api.oauthSignIn).toHaveBeenCalledTimes(1);
    finish({ kind: "auth", message: "cancelled" });
    await vi.waitFor(() => expect(buttons[0].disabled).toBe(false));
  });

  it("a held letter goes out again after the sign-in, then the task goes", async () => {
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    api.oauthSignIn.mockResolvedValue({ id: "g1", provider: "google", email: "jane@example.com", name: null, imap: account({}).imap, smtp: account({}).smtp });
    api.outbox.mockResolvedValue([
      { id: 7, account_id: "a", failed: true } as never,
      { id: 8, account_id: "a", failed: false } as never,
      { id: 9, account_id: "b", failed: true } as never,
    ]);
    api.outboxRetry.mockResolvedValue(undefined);
    const buttons = open(failed({ kind: "auth", message: "Token has been expired or revoked." }, "send"));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Войти заново"]);
    buttons[0].click();
    await vi.waitFor(() => expect(api.taskDismiss).toHaveBeenCalledWith("send:a"));
    expect(api.outboxRetry.mock.calls).toEqual([[7]]);
  });

  it("a refused password opens the mailbox's page", () => {
    app.mailboxes.accounts = [account({})];
    const buttons = open(failed({ kind: "auth", message: "login rejected" }));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Войти заново"]);
    buttons[0].click();
    expect(api.oauthSignIn).not.toHaveBeenCalled();
    expect(app.ui.tasksOpen).toBe(false);
    expect(app.ui.settingsOpen).toBe(true);
    expect(app.ui.settingsPage).toBe("account:a");
  });

  it("any other error keeps «Retry»", () => {
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    const buttons = open(failed({ kind: "network", message: "timed out" }));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Повторить"]);
    buttons[0].click();
    expect(api.syncNow).toHaveBeenCalledWith("a");
    expect(api.oauthSignIn).not.toHaveBeenCalled();
  });
});

describe("the offline progress bar of a mailbox", () => {
  // Fully downloaded reads as done, not as an error (#169): a full red bar under «Офлайн: скачано N из N писем» looked like one.
  async function openWithOverview(overview: { offline_done: number; offline_total: number; paused: boolean }) {
    app.mailboxes.accounts = [account({})];
    api.syncOverview.mockResolvedValue([{ account_id: "a", last_sync: 1, ...overview }]);
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(Tasks, { target, props: {} });
    await vi.waitFor(() => expect(target.querySelector(".acc .offline")).not.toBeNull());
    return target;
  }

  it("shows no bar once everything is downloaded", async () => {
    const target = await openWithOverview({ offline_done: 1300, offline_total: 1300, paused: false });
    expect(target.querySelector(".acc .offline")?.textContent).toContain("Офлайн: скачано 1300 из 1300 писем");
    expect(target.querySelector(".acc .bar")).toBeNull();
  });

  it("shows no bar when there is nothing to download", async () => {
    const target = await openWithOverview({ offline_done: 0, offline_total: 0, paused: false });
    expect(target.querySelector(".acc .bar")).toBeNull();
  });

  it("keeps the bar while the download is still running", async () => {
    const target = await openWithOverview({ offline_done: 300, offline_total: 1300, paused: false });
    expect(target.querySelector(".acc .offline")?.textContent).toContain("Офлайн: скачано 300 из 1300 писем");
    expect(target.querySelector(".acc .bar")).not.toBeNull();
  });
});
