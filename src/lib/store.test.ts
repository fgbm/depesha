import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore, app } from "./store.svelte";
import { extensions } from "./extensions.svelte";
import { i18n } from "./i18n.svelte";
import { QuickReplyState } from "../components/reader/useQuickReply.svelte";
import { api, emit, eventModule, flush, handlers, opened, resetFakes, row, settings } from "./testing";
import type { AccountView, Extension } from "./types";

beforeEach(() => {
  resetFakes();
  i18n.lang = "en";
});

describe("the main window starting", () => {
  it("listens to mail changes before it reads the list", async () => {
    const s = new AppStore();
    await s.init();
    const subscribed = eventModule.listen.mock.calls.findIndex(([name]) => name === "mail-changed");
    const order = eventModule.listen.mock.invocationCallOrder[subscribed];
    expect(order).toBeLessThan(api.messages.mock.invocationCallOrder[0]);
  });

  it("subscribes to everything at once", async () => {
    eventModule.listen.mockImplementation(() => new Promise(() => {}));
    const s = new AppStore();
    void s.init();
    await flush();
    const names = eventModule.listen.mock.calls.map(([name]) => name);
    for (const name of ["mail-changed", "account-status", "sent", "send-failed", "settings-changed", "window-moved", "window-view", "mail-arrived"]) {
      expect(names).toContain(name);
    }
    expect(api.messages).not.toHaveBeenCalled();
  });

  it("keeps listening when the mailboxes cannot be read", async () => {
    api.accounts.mockRejectedValue({ kind: "other", message: "accounts file broken" });
    const s = new AppStore();
    await expect(s.init()).resolves.toBeUndefined();
    expect(s.toasts.some((x) => x.error && x.text.includes("accounts file broken"))).toBe(true);
    for (const name of ["mail-changed", "account-status", "sent", "window-moved", "window-view"]) expect(handlers.has(name)).toBe(true);
    expect(s.wizard).toBeNull();
    expect(api.messages).toHaveBeenCalled();
  });

  it("tells about every request that failed, not only the first", async () => {
    api.folders.mockRejectedValue({ kind: "other", message: "no folders" });
    api.tasks.mockRejectedValue({ kind: "other", message: "no tasks" });
    const s = new AppStore();
    await s.init();
    const texts = s.toasts.map((x) => x.text);
    expect(texts).toContain("no folders");
    expect(texts).toContain("no tasks");
  });

  it("opens the setup of a first mailbox when there is none", async () => {
    const s = new AppStore();
    await s.init();
    expect(s.wizard).toEqual({ account: null });
  });
});

/** A mailbox as the store lists one, with nothing the choice below reads. */
const acc = (id: string): AccountView =>
  ({ id, display_name: id, email: `${id}@example.com`, username: id, imap: { host: "h", port: 993, security: "tls" }, smtp: { host: "h", port: 465, security: "tls" }, save_sent_copy: true, status: null }) as unknown as AccountView;

describe("the mailbox of a new message", () => {
  it("is the default one even when another mailbox's folder is open", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: "b" };
    s.list.view = { kind: "folder", account_id: "a", folder: "INBOX" };
    expect(s.defaultAccount()?.id).toBe("b");
  });

  it("follows the context when none is chosen", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: null };
    s.list.view = { kind: "folder", account_id: "b", folder: "INBOX" };
    expect(s.defaultAccount()?.id).toBe("b");
    s.list.view = { kind: "unified", role: "inbox" };
    expect(s.defaultAccount()?.id).toBe("a");
  });

  it("treats a removed or unknown default as none", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: "gone" };
    s.list.view = { kind: "folder", account_id: "b", folder: "INBOX" };
    expect(s.defaultAccount()?.id).toBe("b");
  });
});

describe("the mailbox an answer, a forward or a link goes from", () => {
  it("leaves an answer going from the mailbox the letter arrived in", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: "a" };
    s.reader.opened = opened(row(1, { account_id: "b" }));
    s.replyTo(false);
    expect(s.compose.windows.at(-1)?.account_id).toBe("b");
  });

  it("leaves «Reply all» and a forward going from the mailbox the letter arrived in", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: "a" };
    s.reader.opened = opened(row(1, { account_id: "b" }));
    s.replyTo(true);
    expect(s.compose.windows.at(-1)?.account_id).toBe("b");
    s.forwardOpened();
    expect(s.compose.windows.at(-1)?.account_id).toBe("b");
  });

  it("leaves a quick answer going from the mailbox the letter arrived in", () => {
    // The quick answer reads the running store, not a host of its own.
    app.accounts = [acc("a"), acc("b")];
    app.settings = { ...settings(), default_account_id: "a" };
    app.reader.opened = opened(row(1, { account_id: "b" }));
    const quick = new QuickReplyState({ keptAsDraft: () => {} });
    quick.openQuick(false);
    expect(quick.quick?.account_id).toBe("b");
  });

  it("writes a mailto link from the default mailbox, not the letter's", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: "a" };
    s.list.view = { kind: "folder", account_id: "b", folder: "INBOX" };
    s.reader.opened = opened(row(1, { account_id: "b" }));
    s.openMailto("mailto:someone@example.org?subject=Hi%20there");
    const win = s.compose.windows.at(-1);
    expect(win?.account_id).toBe("a");
    expect(win?.draft.to.map((a) => a.email)).toEqual(["someone@example.org"]);
    expect(win?.draft.subject).toBe("Hi there");
  });

  it("writes a mailto link from the open letter when no default is set", () => {
    const s = new AppStore();
    s.accounts = [acc("a"), acc("b")];
    s.settings = { ...settings(), default_account_id: null };
    s.list.view = { kind: "folder", account_id: "b", folder: "INBOX" };
    s.reader.opened = opened(row(1, { account_id: "b" }));
    s.openMailto("mailto:someone@example.org");
    expect(s.compose.windows.at(-1)?.account_id).toBe("b");
  });
});

describe("settings changed elsewhere", () => {
  it("switch the language of the main window too", async () => {
    const s = new AppStore();
    await s.init();
    api.language.mockResolvedValue("ru");
    emit("settings-changed");
    await flush();
    expect(i18n.lang).toBe("ru");
  });
});

describe("extension banners", () => {
  it("are kept only for the open letter and its conversation", async () => {
    extensions.list = [{ id: "x", name: { en: "X" }, enabled: true, hooks: ["messageOpen"], permissions: [], contributes: { commands: [] } } as unknown as Extension];
    const call = vi.spyOn(extensions, "call").mockImplementation(async (_ext, _name, args) => ({
      banner: { text: `about ${(args[0] as { id: number }).id}` },
    }));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    // The last letter is a conversation with letter 99.
    api.thread.mockImplementation(async (id: number) => (id === 20 || id === 99 ? [row(99, { date: 1 }), row(20, { date: 2 })] : []));
    const s = new AppStore();
    await s.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    for (let id = 1; id <= 20; id++) {
      await s.open(id);
      await flush();
    }
    expect(extensions.banners.map((b) => b.messageId)).toEqual([20]);

    // Its other letter opened from the conversation: both banners stay.
    await s.open(99);
    await flush();
    expect(extensions.banners.map((b) => b.messageId).sort()).toEqual([20, 99]);
    call.mockRestore();
    extensions.list = [];
  });
});
