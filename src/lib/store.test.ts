import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
import { ComposeFormat } from "./compose/format.svelte";
import { GAP, QUOTE_CLASS, SIGNATURE_CLASS, findBlock } from "./richtext";
import { shortcuts } from "./shortcuts.svelte";
import { api, emit, eventModule, flush, handlers, opened, resetFakes, row, settings } from "./testing";
import type { AccountView, BodyFormat, Extension } from "./types";

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

/** A mailbox as the store lists one, with one signature of its own, writing in `format`. */
const accWith = (id: string, format: BodyFormat): AccountView =>
  ({
    ...acc(id),
    compose_format: format,
    default_signature: "s1",
    signatures: [{ id: "s1", name: "Me", html: "<div>Ann</div>", text: "Ann" }],
  }) as unknown as AccountView;

/** A quick answer to a letter in this mailbox, with `text` typed into it. */
function typing(account: AccountView, text: string): QuickReplyState {
  app.accounts = [account];
  app.settings = { ...settings(), default_account_id: account.id };
  app.reader.opened = opened(row(1, { account_id: account.id }));
  const quick = new QuickReplyState({ keptAsDraft: () => {} });
  quick.openQuick(false);
  quick.text = text;
  return quick;
}

/** The draft of the last opened composition window. */
const unfolded = () => app.compose.windows.at(-1)!.draft;
const count = (html: string, mark: string) => html.split(mark).length - 1;

/** The field of a window asks for a caret at once; no animation frames stand here. */
const noAnimation = () =>
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    fn();
    return 0;
  });

/** Places the caret as the window opens on the last draft, and tells what the field got. */
function caret(): { focus: number; at: number | null } {
  const calls: { focus: number; at: number | null } = { focus: 0, at: null };
  const field = {
    value: "",
    focus: () => (calls.focus += 1),
    setSelectionRange: (a: number) => (calls.at = a),
    scrollTop: 0,
  };
  const fmt = new ComposeFormat({
    win: app.compose.windows.at(-1)!,
    windowOf: null,
    account: (id) => app.account(id),
    openSettings: () => {},
    fail: () => {},
    confirmToPlain: async () => true,
    formatChanged: () => {},
  });
  fmt.body = field as unknown as HTMLTextAreaElement;
  (fmt as unknown as { placeCaret(): void }).placeCaret();
  return calls;
}

describe("the quick answer unfolded into a window", () => {
  it("keeps an empty line above the signature in HTML, the quote whole and once", () => {
    const quick = typing(accWith("b", "html"), "Hello\n\nWorld");
    quick.toWindow();
    const html = unfolded().html ?? "";
    // The typed paragraphs first, then exactly the empty line the reply keeps over the signature.
    expect(html.startsWith(`<p>Hello</p><p>World</p>${GAP}`)).toBe(true);
    const sig = findBlock(html, SIGNATURE_CLASS);
    const quote = findBlock(html, QUOTE_CLASS);
    expect(sig).not.toBeNull();
    expect(quote).not.toBeNull();
    // The signature right under that line, the quote after it: no gap between them, none lost.
    expect(html.slice(0, sig?.start)).toBe(`<p>Hello</p><p>World</p>${GAP}`);
    expect(html.slice(sig?.end, quote?.start)).toBe("");
    expect(html.slice(quote?.end)).toBe("");
    expect(count(html, SIGNATURE_CLASS)).toBe(1);
    expect(count(html, QUOTE_CLASS)).toBe(1);
  });

  it("keeps the plain-text separator of a plain answer", () => {
    const quick = typing(accWith("b", "plain"), "Hi");
    quick.toWindow();
    const text = unfolded().text;
    expect(text.startsWith("Hi\n\n-- \nAnn")).toBe(true);
    expect(text).toContain("\n\nOn ");
  });

  it("keeps the plain-text separator of a Markdown answer", () => {
    const quick = typing(accWith("b", "markdown"), "Hi");
    quick.toWindow();
    const text = unfolded().text;
    expect(text.startsWith("Hi\n\n-- \nAnn")).toBe(true);
    expect(text).toContain("\n\nOn ");
  });
});

describe("the caret of a quick answer unfolded into a window", () => {
  beforeEach(noAnimation);

  it("stands at the end of the words in a plain answer, above the signature", () => {
    const quick = typing(accWith("b", "plain"), "Hello\n\nWorld");
    quick.toWindow();
    const head = unfolded().text.split("\n\n-- ")[0];
    // The words are all there; the caret stands at their end, the signature block under them.
    expect(caret()).toEqual({ focus: 1, at: head.length });
    expect(head).toBe("Hello\n\nWorld");
  });

  it("stands at the end of the words in a Markdown answer, above the signature", () => {
    const quick = typing(accWith("b", "markdown"), "Hi");
    quick.toWindow();
    const head = unfolded().text.split("\n\n-- ")[0];
    expect(caret()).toEqual({ focus: 1, at: head.length });
    expect(head).toBe("Hi");
  });

  it("stays at the very top of a fresh reply, the empty line above the signature", () => {
    app.compose.windows.length = 0;
    app.accounts = [accWith("b", "plain")];
    app.settings = { ...settings(), default_account_id: "b" };
    app.reader.opened = opened(row(1, { account_id: "b" }));
    app.replyTo(false);
    // Not an unfolded answer: the field is focused, the caret kept at the very top.
    expect(caret()).toEqual({ focus: 1, at: 0 });
  });
});

describe("a message window and mail changes", () => {
  it("does not read the folders list it has no use for", async () => {
    const s = new AppStore();
    await s.initWindow(1);
    api.folders.mockClear();
    vi.useFakeTimers();
    emit("mail-changed", { account_id: "a", folder: "INBOX" });
    vi.advanceTimersByTime(500);
    await flush();
    expect(api.folders).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("the address book changed elsewhere", () => {
  it("reads the book again", async () => {
    const s = new AppStore();
    await s.init();
    api.people.mockClear();
    emit("people-changed");
    await flush();
    expect(api.people).toHaveBeenCalled();
  });
});

describe("settings changed elsewhere", () => {
  it("switch the language of the main window too", async () => {
    const s = new AppStore();
    await s.init();
    vi.useFakeTimers();
    api.settings.mockResolvedValue({ ...settings(), language: "ru" });
    api.language.mockResolvedValue("ru");
    emit("settings-changed");
    await vi.advanceTimersByTimeAsync(300);
    expect(i18n.lang).toBe("ru");
    vi.useRealTimers();
  });

  // An already open window — a message of its own too — hears the event and takes the
  // keys at once: no reopening, the toolbar and the palette follow.
  it("bring the new keys to an open message window at once", async () => {
    const s = new AppStore();
    await s.initWindow(1);
    vi.useFakeTimers();
    const changed = { ...settings(), keybindings: { custom: { "core.reply-all": ["Shift+r"] }, dismissed: [] } };
    api.settings.mockResolvedValue(changed);
    emit("settings-changed");
    await vi.advanceTimersByTimeAsync(300);
    expect(shortcuts.keys("core.reply-all")).toEqual(["Shift+r"]);
    vi.useRealTimers();
  });

  it("read neither the language nor the extensions again when nothing relevant changed", async () => {
    const s = new AppStore();
    await s.init();
    vi.useFakeTimers();
    api.language.mockClear();
    const load = vi.spyOn(extensions, "load");
    emit("settings-changed");
    await vi.advanceTimersByTimeAsync(300);
    expect(api.language).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
    vi.useRealTimers();
  });
});

describe("saving one setting", () => {
  // The whole settings from memory would roll back what another window or the tray wrote
  // meanwhile: a save names only its own keys, and the backend patches them over the file.
  it("patches only the keys it names, not the whole settings from memory", async () => {
    const s = new AppStore();
    await s.init();
    const keys = { custom: { "core.reply-all": ["Shift+r"] }, dismissed: [] };
    await s.saveKeybindings(keys);
    expect(api.settingsPatch).toHaveBeenCalledWith({ keybindings: keys });
    expect(s.settings.keybindings).toEqual(keys);
  });

  // Every place that changes a setting patches its own keys: no part of the app writes the
  // whole object any more (the backend's `settings_set` stays for the e2e harness).
  it("leaves no place that writes the whole settings object", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts") && /\.saveSettings\s*\(/.test(readFileSync(path, "utf-8"))) {
          offenders.push(relative(src, path));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
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

describe("the toast of a letter taken to Waiting for reply (#106)", () => {
  it("keeps the undo of a later action when pressed", async () => {
    const s = new AppStore();
    await s.init();
    emit("parked", { account_id: "a", key: "r@x", subject: "Счёт" });
    const toast = s.toasts.at(-1)!;
    const other = { moved: [], text: "другое" };
    s.actions.lastUndo = other;
    api.followupUnpark.mockResolvedValue(undefined);
    toast.action!.run();
    await flush();
    expect(s.actions.lastUndo).toBe(other);
  });
});

describe("an answer that takes its letter to the archive (#106)", () => {
  it("says so once the letter has moved, and offers the undo of «Archive»", async () => {
    const s = new AppStore();
    await s.init();
    i18n.lang = "ru";
    const moved = { account_id: "a", from: "INBOX", to: "Archive", message_ids: ["q@x"] };
    emit("sent", { id: 1, subject: "Счёт", parking: true });
    expect(s.toasts).toEqual([]);
    emit("archived-after-send", { subject: "Счёт", moved });
    const toast = s.toasts.at(-1)!;
    expect(toast.text).toBe("Отправлено: Счёт. Письмо — в архиве");
    expect(toast.action?.label).toBe("Отменить");
    expect(s.actions.lastUndo).toEqual({ moved: [moved], text: toast.text });
  });

  it("undoes its own move even when another action has come since", async () => {
    const s = new AppStore();
    await s.init();
    const moved = { account_id: "a", from: "INBOX", to: "Archive", message_ids: ["q@x"] };
    emit("archived-after-send", { subject: "Счёт", moved });
    const toast = s.toasts.at(-1)!;
    const other = { moved: [{ account_id: "a", from: "INBOX", to: "Trash", message_ids: ["z@x"] }], text: "другое" };
    s.actions.lastUndo = other;
    api.undo.mockResolvedValue(undefined);
    toast.action!.run();
    await flush();
    expect(api.undo).toHaveBeenCalledWith([moved]);
    expect(s.actions.lastUndo).toBe(other);
  });
});

describe("an answer that takes its letter to Waiting for reply", () => {
  async function started() {
    const s = new AppStore();
    await s.init();
    i18n.lang = "ru";
    return s;
  }

  it("says so once the letter has moved, and offers to keep it in the inbox", async () => {
    const s = await started();
    emit("sent", { id: 1, subject: "Счёт за сентябрь", parking: true });
    // One toast, when the move is done: «Sent» alone would be taken back a moment later.
    expect(s.toasts).toEqual([]);
    emit("parked", { account_id: "a", key: "r@x", subject: "Счёт за сентябрь" });
    const toast = s.toasts.at(-1)!;
    expect(toast.text).toBe("Отправлено: Счёт за сентябрь. Письмо — в «Ждут ответа»");
    expect(toast.error).toBe(false);
    expect(toast.action?.label).toBe("Оставить во входящих");
    api.followupUnpark.mockResolvedValue(undefined);
    toast.action!.run();
    await flush();
    expect(api.followupUnpark).toHaveBeenCalledWith("a", "r@x");
  });

  it("«z» keeps the letter in the inbox as well, as it takes back «Done»", async () => {
    const s = await started();
    emit("parked", { account_id: "a", key: "r@x", subject: "Счёт" });
    api.followupUnpark.mockResolvedValue(undefined);
    await s.undo();
    expect(api.followupUnpark).toHaveBeenCalledWith("a", "r@x");
    expect(api.undo).not.toHaveBeenCalled();
  });

  it("a folder the server refused is said in red, with the way out", async () => {
    const s = await started();
    emit("park-failed", { account_id: "a", subject: "Счёт", folder: "Ждут ответа", refused: true });
    const toast = s.toasts.at(-1)!;
    expect(toast.error).toBe(true);
    expect(toast.text).toBe("Не удалось создать папку «Ждут ответа»: сервер не разрешает. Письмо осталось во входящих");
    expect(toast.action?.label).toBe("Выбрать папку");
    toast.action!.run();
    expect([s.settingsOpen, s.settingsPage, s.settingsSection]).toEqual([true, "account:a", "letters"]);
  });

  it("a move that failed for another reason says why", async () => {
    const s = await started();
    emit("park-failed", { account_id: "a", subject: "Счёт", folder: "Ждут ответа", refused: false, error: "нет связи" });
    expect(s.toasts.at(-1)!.text).toBe("Письмо не перенесено в «Ждут ответа»: нет связи. Оно осталось во входящих");
  });

  it("an ordinary letter says «Sent» as before", async () => {
    const s = await started();
    emit("sent", { id: 1, subject: "Обед" });
    expect(s.toasts.at(-1)!.text).toBe("Отправлено: Обед");
  });
});
