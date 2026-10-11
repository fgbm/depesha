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

const failed = (error: CmdError): Task => ({
  key: "sync:a",
  kind: "sync",
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

  it("a failed sign-in keeps the task and shows the error", async () => {
    app.mailboxes.accounts = [account({ auth: { kind: "oauth", provider: "google" } })];
    api.oauthSignIn.mockRejectedValue({ kind: "auth", message: "access denied" });
    const buttons = open(failed({ kind: "auth", message: "Token has been expired or revoked." }));
    buttons[0].click();
    await vi.waitFor(() => expect(api.oauthSignIn).toHaveBeenCalled());
    await tick();
    expect(api.taskDismiss).not.toHaveBeenCalled();
    expect(api.accountSave).not.toHaveBeenCalled();
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
