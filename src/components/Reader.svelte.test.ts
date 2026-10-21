// @vitest-environment jsdom
// Reading a conversation as an accordion (0.8.4, #180; decision 4.0 Б): the letter the pane has
// open is the unfolded one, the letters around it are folded rows, «Ещё N писем» unfolds the far
// history, and a row unfolds its letter by a click or a key.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import Reader from "./Reader.svelte";
import { app } from "../lib/store.svelte";
import { layout } from "../lib/layout.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, flush, resetFakes, settings } from "../lib/testing";
import type { MessageRow, OpenedMessage } from "../lib/types";

const row = (id: number) => ({ id, account_id: "a", folder: "INBOX", from: { name: `Автор ${id}`, email: `u${id}@x.example` }, flags: { seen: true }, date: 1000 + id }) as unknown as MessageRow;
const opened = (id: number): OpenedMessage =>
  ({
    row: row(id),
    view: { summary: { message_id: null, subject: `Тема ${id}`, from: { name: "Иван", email: "ivan@x.example" }, to: [], cc: [], date: 1000 }, attachments: [], text: "text", views: ["text"], calendar: null },
  }) as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;
let reply: Mock;
let forward: Mock;

/** The fold controls of the letters around the open one: a `button.head` per folded letter. */
const heads = () => [...document.querySelectorAll<HTMLButtonElement>(".thread .letter button.head")];
/** How many letters the accordion shows unfolded. */
const unfolded = () => document.querySelectorAll(".thread .letter .body").length;
const more = () => document.querySelectorAll(".thread .more").length;

beforeEach(async () => {
  resetFakes();
  i18n.lang = "ru";
  app.settingsCtl.settings = settings();
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  api.open.mockImplementation(async (id: number) => opened(id));
  const chain = [1, 2, 3, 4, 5, 6, 7].map(row);
  app.reader.opened = opened(7);
  app.reader.conversation = chain;
  reply = vi.fn();
  forward = vi.fn();
  view = mount(Reader, { target: document.body, props: { onReply: reply, onForward: forward } });
  flushSync();
});
afterEach(async () => {
  // jsdom cannot take a listener off the window of an open list: the page is gone with the document anyway.
  if (view) await Promise.resolve(unmount(view)).catch(() => {});
  view = null;
  app.reader.opened = null;
  app.reader.conversation = [];
  layout.width = 1280;
  app.windowOf = null;
  app.selection.selected = new Set();
  document.body.innerHTML = "";
});

describe("reading a conversation (0.8.4, #180)", () => {
  it("shows the letters around the open one folded, the far history behind «Ещё N писем» (4.0 Б)", () => {
    // The open letter (7) is the unfolded one; before it, 5 and 6 show and 1–4 fold away.
    expect(unfolded()).toBe(0);
    expect(more()).toBe(1);
    expect(heads().length).toBe(2);
    expect(document.querySelector(".reader h1")!.textContent).toContain("Тема 7");
  });

  it("shows the subject once, above all the letters, and no letter carries one (4.5)", () => {
    const h1s = [...document.querySelectorAll<HTMLElement>(".reader h1")];
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain("Тема 7");
    // The heading stands above the thread, not inside a letter of it.
    expect(document.querySelector(".reader .scroll > h1.subject")).not.toBeNull();
    expect(document.querySelector(".thread h1")).toBeNull();
  });

  it("unfolds the last letter of the thread by date, not by id (4.1 Б)", () => {
    // Dates out of step with the ids: the newest letter (id 1) is the one the pane has open.
    const chain = [7, 6, 5, 4, 3, 2, 1].map((id) => ({ ...row(id), date: 2000 - id }));
    app.reader.conversation = chain;
    app.reader.opened = opened(1);
    flushSync();
    const newest = chain.reduce((a, b) => (b.date > a.date ? b : a));
    expect(newest.id).toBe(1);
    expect(app.reader.opened?.row.id).toBe(newest.id);
    expect(document.querySelector(".reader h1")!.textContent).toContain(`Тема ${newest.id}`);
    expect(unfolded()).toBe(0);
    // The letters above it are the older ones, nearest first: 3 and 2 show, 7–4 fold away.
    expect(heads().map((h) => h.textContent)).toEqual([expect.stringContaining("Автор 3"), expect.stringContaining("Автор 2")]);
  });

  it("the lower «ещё N писем» folds the letters far from the open one (4.0 Б)", () => {
    // The oldest letter is open: the newer ones sit below it, the far end folded away.
    app.reader.opened = opened(1);
    flushSync();
    const after = document.querySelector<HTMLElement>(".thread.after");
    expect(after).not.toBeNull();
    const names = [...after!.querySelectorAll(".letter .head")].map((h) => h.textContent ?? "");
    // The letters nearest the open one show; the far ones fold away.
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("Автор 2");
    expect(names[1]).toContain("Автор 3");
    // The fold row stands at the far end, after the letters it does not hide.
    expect(after!.lastElementChild!.classList.contains("more")).toBe(true);
  });
});

describe("the folds of a conversation (0.8.4, #180)", () => {
  it("unfolds the far history by «Ещё N писем» and folds it back", () => {
    document.querySelector<HTMLButtonElement>(".thread .more")!.click();
    flushSync();
    expect(more()).toBe(0);
    expect(heads().length).toBe(6);
  });

  it("unfolds a letter by a click and folds it back", async () => {
    const h = heads()[0];
    h.click();
    await flush();
    flushSync();
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(unfolded()).toBe(1);
    h.click();
    await flush();
    flushSync();
    expect(h.getAttribute("aria-expanded")).toBe("false");
    expect(unfolded()).toBe(0);
  });

  it("unfolds a letter by the keyboard", async () => {
    const h = heads()[0];
    h.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    flushSync();
    expect(h.getAttribute("aria-expanded")).toBe("true");
    expect(unfolded()).toBe(1);
  });

  it("the folds close again when another letter opens, whatever its Message-ID", () => {
    document.querySelector<HTMLButtonElement>(".thread .more")!.click();
    flushSync();
    expect(more()).toBe(0);
    app.reader.opened = opened(6);
    flushSync();
    expect(more()).toBe(1);
  });

  it("stays unfolded when the same letter is loaded again", () => {
    document.querySelector<HTMLButtonElement>(".thread .more")!.click();
    flushSync();
    app.reader.opened = opened(7);
    flushSync();
    expect(more()).toBe(0);
  });
});

describe("a letter unfolded in the conversation (0.8.4, #180)", () => {
  it("its row follows its own read state and its own flags", async () => {
    app.reader.conversation = app.reader.conversation.map((m) => ({ ...m, flags: { ...m.flags, seen: false } }));
    flushSync();
    heads()[0].click();
    await flush();
    flushSync();
    // Unfolded: the row it was unfolded from shows it as read.
    expect(document.querySelector(".thread .letter")!.classList.contains("unread")).toBe(false);

    // The flag item of its own menu follows the letter.
    const menu = async () => {
      document.querySelector<HTMLButtonElement>(".thread .letter .acts .anchor button")!.click();
      await flush();
      flushSync();
      return [...document.querySelectorAll<HTMLButtonElement>(".pop button.mi")];
    };
    let items = await menu();
    expect(items[0].textContent).toContain("Поставить флаг");
    items[0].click();
    await flush();
    flushSync();
    items = await menu();
    expect(items[0].textContent).toContain("Снять флаг");
  });
});

describe("the buttons of a letter unfolded in the conversation (0.8.4, #180)", () => {
  it("unfolding a letter marks it read, the folded ones stay unread", async () => {
    app.reader.conversation = app.reader.conversation.map((m) => ({ ...m, flags: { ...m.flags, seen: false } }));
    flushSync();
    heads()[0].click();
    await flush();
    flushSync();
    const seen = api.setFlag.mock.calls.filter(([, c]) => c?.flag === "seen").flatMap(([ids]) => ids as number[]);
    expect(seen).toEqual([5]);
  });

  it("«Ответить» on an unfolded letter makes it the open one and replies to it", async () => {
    heads()[0].click();
    await flush();
    flushSync();
    const acts = [...document.querySelectorAll<HTMLButtonElement>(".thread .letter .acts button")];
    acts[0].click();
    await flush();
    flushSync();
    expect(api.open).toHaveBeenCalledWith(5, false, expect.anything());
    expect(reply).toHaveBeenCalledWith(false);
  });

  it("«Переслать» on an unfolded letter makes it the open one and forwards it", async () => {
    heads()[0].click();
    await flush();
    flushSync();
    const acts = [...document.querySelectorAll<HTMLButtonElement>(".thread .letter .acts button")];
    acts[1].click();
    await flush();
    flushSync();
    expect(api.open).toHaveBeenCalledWith(5, false, expect.anything());
    expect(forward).toHaveBeenCalled();
  });

  it("«Удалить» on an unfolded letter removes that letter", async () => {
    heads()[0].click();
    await flush();
    flushSync();
    const acts = [...document.querySelectorAll<HTMLButtonElement>(".thread .letter .acts button")];
    acts[2].click();
    await flush();
    expect(api.remove.mock.calls[0][0]).toEqual([5]);
  });
});

describe("the header of a letter unfolded in the conversation (4.6 revised 2026-10-14)", () => {
  it("keeps the name alone and the address on hover while the letter is folded", () => {
    const h = heads()[0];
    expect(h.textContent).not.toContain("u5@x.example");
    expect(h.querySelector(".who")?.getAttribute("title")).toBe("u5@x.example");
  });

  it("wears the pane's full header when unfolded, with its own «Кому» and «Копия»", async () => {
    const withRecipients = (id: number) => {
      const o = opened(id);
      return { ...o, view: { ...o.view, summary: { ...o.view.summary, to: [{ name: null, email: `to${id}@x.example` }], cc: [{ name: null, email: `cc${id}@x.example` }] } } } as unknown as OpenedMessage;
    };
    api.open.mockImplementation(async (id: number) => withRecipients(id));
    heads()[0].click();
    await flush();
    flushSync();
    const letter = document.querySelector<HTMLElement>(".thread .letter")!;
    // The sender with the address, and the letter's own recipients, not the open one's.
    expect(letter.textContent).toContain("ivan@x.example");
    expect(letter.textContent).toContain("Кому");
    expect(letter.textContent).toContain("to5@x.example");
    expect(letter.textContent).toContain("Копия");
    expect(letter.textContent).toContain("cc5@x.example");
    // The header of the letter open in the pane is its own: it names no recipient of the unfolded letter.
    expect(document.querySelector(".reader > .scroll > .head")?.textContent ?? "").not.toContain("to5@x.example");
  });
});

describe("the files of a letter unfolded in the conversation (4.8)", () => {
  it("shows the letter's files — name, size, a button that saves each — and no viewer", async () => {
    app.settingsCtl.settings = { ...settings(), attachments_dir: "/tmp/att" };
    api.attachmentSaveIn.mockResolvedValue("/tmp/att/отчёт.pdf");
    const withFiles = (id: number) => {
      const o = opened(id);
      return { ...o, view: { ...o.view, attachments: [{ index: 0, name: "отчёт.pdf", size: 2048, inline: false, content_id: null }] } } as unknown as OpenedMessage;
    };
    api.open.mockImplementation(async (id: number) => withFiles(id));
    heads()[0].click();
    await flush();
    flushSync();
    const files = [...document.querySelectorAll<HTMLElement>(".thread .letter .files .file")];
    expect(files).toHaveLength(1);
    expect(files[0].textContent).toContain("отчёт.pdf");
    expect(files[0].textContent).toContain("2 КБ");
    // No viewer here: the name is plain text, not a button that shows the file.
    expect(files[0].querySelector("button.file-name")).toBeNull();
    // The button saves the letter's own file, by the letter's id.
    [...files[0].querySelectorAll<HTMLButtonElement>("button")][0].click();
    await flush();
    expect(api.attachmentSaveIn).toHaveBeenCalledWith(5, 0);
  });
});

describe("a move of a letter unfolded in the conversation (#180)", () => {
  it("keeps an archived letter in the conversation, with its new folder", async () => {
    app.mailboxes.folders = [{ account_id: "a", name: "Archive", role: "archive" }] as never;
    heads()[0].click();
    await flush();
    flushSync();
    api.archive.mockResolvedValue([{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ["<5@example.com>"], unseen: [], snoozed: [], waits: [] }]);
    document.querySelector<HTMLButtonElement>(".thread .letter .acts .anchor button")!.click();
    await flush();
    flushSync();
    const done = [...document.querySelectorAll<HTMLButtonElement>(".pop button.mi")].find((b) => b.textContent?.includes("Готово"))!;
    done.click();
    await flush();
    flushSync();
    // The letter stays in the conversation; the folder it names is the new one.
    expect(app.reader.conversation.map((m) => m.id)).toContain(5);
    expect(app.reader.conversation.find((m) => m.id === 5)?.folder).toBe("Archive");
  });
});

describe("the letter's toolbar in the unified panel (0.8.3, #176)", () => {
  const toolbar = () => document.querySelector(".reader .toolbar");

  it("is not the reader's own in the wide window: the panel above carries it (1.1 В)", () => {
    expect(toolbar()).toBeNull();
  });

  it("stays the reader's own in a narrow window (1.5 А)", () => {
    layout.width = 640;
    flushSync();
    expect(toolbar()).not.toBeNull();
  });

  it("stays the reader's own in a letter opened in a window of its own", () => {
    app.windowOf = 5;
    flushSync();
    expect(toolbar()).not.toBeNull();
  });

  it("shows a bare «Выбрано N» for several chosen rows, with no actions of the reader (1.4 Б)", () => {
    app.selection.selected = new Set([1, 2, 3]);
    flushSync();
    const bare = document.querySelector(".reader .bare");
    expect(bare).not.toBeNull();
    expect(bare!.textContent).toMatch(/Выбрано 3/);
    expect(document.querySelector(".reader .actions")).toBeNull();
  });

  it("keeps the toolbar while another letter is being opened, its buttons standing aside", () => {
    layout.width = 640;
    flushSync();
    // The letter is leaving the pane: the new one is on its way (waited is still 0, so the
    // skeleton has not come yet). The toolbar must not vanish before it does.
    app.reader.opening = true;
    app.reader.openingRow = row(2);
    flushSync();
    expect(toolbar()).not.toBeNull();
    expect(document.querySelectorAll(".reader .toolbar").length).toBe(1);
    expect(document.querySelector(".reader .toolbar .row")!.classList.contains("inactive")).toBe(true);
    app.reader.opening = false;
    app.reader.openingRow = null;
    flushSync();
    expect(document.querySelector(".reader .toolbar .row")!.classList.contains("inactive")).toBe(false);
  });
});
