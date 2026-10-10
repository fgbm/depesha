// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import MessageList from "./MessageList.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, settings } from "../lib/testing";
import type { AccountView, MessageRow } from "../lib/types";

// jsdom has no layout: `bind:clientHeight` listens through a ResizeObserver.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const account = { id: "a", label: "Я", display_name: "Я", email: "me@x" } as unknown as AccountView;
const row = (id: number, from: string, over: Partial<MessageRow> = {}): MessageRow =>
  ({
    id, account_id: "a", folder: "INBOX", uid: id, message_id: `<${id}@x>`, in_reply_to: null, references: [], subject: `Тема ${id}`,
    from: { name: null, email: from }, to: [{ name: null, email: "me@x" }], cc: [], reply_to: [], date: 1000 + id, size: 10,
    flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false },
    has_attachments: false, thread: `t${id}`, bulk: false, thread_count: 1, thread_date: 1000 + id, thread_senders: [], thread_draft: false,
    snoozed_until: null, followup_due: null, dmarc: false, thread_voices: [], ...over,
  }) as MessageRow;

let view: ReturnType<typeof mount> | null = null;
function draw(rows: MessageRow[], over: object = {}) {
  app.settings = { ...settings(), ...over };
  app.accounts = [account];
  app.list.messages = rows;
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(MessageList, { target, props: { searchInput: null } });
  flushSync();
  return target;
}

beforeEach(() => {
  i18n.lang = "ru";
  api.avatar.mockReset();
  api.avatar.mockResolvedValue(null);
  app.selected = new Set();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the pictures of the list (#108)", () => {
  it("draws a circle in every row: initials until the logo comes", async () => {
    const t = draw([row(1, "first@one.example", { dmarc: true, from: { name: "Озон Банк", email: "first@one.example" } })]);
    await tick();
    expect(t.querySelector(".row .pic")?.textContent?.trim()).toBe("ОБ");
    expect(t.querySelector(".row")?.classList.contains("avatars")).toBe(true);
  });

  it("asks for a company logo only for a sender the server vouched for, and only with the logos on", async () => {
    draw([row(1, "ozon@two.example", { dmarc: true }), row(2, "ivan@two.example")]);
    await tick();
    expect(api.avatar).toHaveBeenCalledWith("a", "ozon@two.example", true);
    expect(api.avatar).toHaveBeenCalledWith("a", "ivan@two.example", false);
  });

  it("never lets the network in when the logos are off: the circle asks without the brand flag", async () => {
    draw([row(1, "ozon@three.example", { dmarc: true })], { sender_logos: false });
    await tick();
    expect(api.avatar).toHaveBeenCalledWith("a", "ozon@three.example", false);
    expect(api.avatar).not.toHaveBeenCalledWith("a", "ozon@three.example", true);
  });

  it("draws nothing and asks nothing with the avatars of the list off", async () => {
    const t = draw([row(1, "ozon@four.example", { dmarc: true })], { list_avatars: false });
    await tick();
    expect(t.querySelector(".pic")).toBeNull();
    expect(t.querySelector(".row")?.classList.contains("avatars")).toBe(false);
    expect(api.avatar).not.toHaveBeenCalled();
  });

  it("makes the circle neither a control nor a stop of the keyboard", () => {
    const t = draw([row(1, "a@x.example")]);
    const pic = t.querySelector(".row .pic")!;
    expect(pic.querySelector("button, a, [tabindex], input")).toBeNull();
    expect(pic.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(t.querySelectorAll("[role='option']").length).toBe(1);
  });
});

describe("chosen rows and the open letter (#108, 2.5 Б)", () => {
  it("puts a tick in the place of the circle of the rows chosen together, and not of the one letter that is open", () => {
    const t = draw([row(1, "a@x.example"), row(2, "b@x.example"), row(3, "c@x.example")]);
    // A single selection is only the letter that is open: the circle stays, no ground, no tick.
    app.selected = new Set([2]);
    flushSync();
    let rows = t.querySelectorAll(".row");
    expect(rows[1].querySelector(".pic")).not.toBeNull();
    expect(rows[1].querySelector(".pick")).toBeNull();
    expect(rows[1].classList.contains("selected")).toBe(false);
    // Two chosen: both have the tick and the ground, the third keeps its circle.
    app.selected = new Set([1, 2]);
    flushSync();
    rows = t.querySelectorAll(".row");
    for (const i of [0, 1]) {
      expect(rows[i].querySelector(".pic")).toBeNull();
      expect(rows[i].querySelector(".pick.round")).not.toBeNull();
      expect(rows[i].classList.contains("selected")).toBe(true);
    }
    expect(rows[2].querySelector(".pic")).not.toBeNull();
    expect(rows[2].classList.contains("selected")).toBe(false);
  });

  it("keeps the tick in the strip at the left of the text when the circles are off: the text does not move", () => {
    const t = draw([row(1, "a@x.example"), row(2, "b@x.example")], { list_avatars: false });
    app.selected = new Set([1, 2]);
    flushSync();
    expect(t.querySelectorAll(".row .pick").length).toBe(2);
    expect(t.querySelector(".row .pick.round")).toBeNull();
    expect(t.querySelector(".row")?.classList.contains("avatars")).toBe(false);
  });
});

describe("the cursor bar moves with the key (#108, 2.5 Б)", () => {
  const cursors = (t: HTMLElement) => [...t.querySelectorAll(".row")].map((r) => r.classList.contains("cursor"));

  it("stands on the one selected row at once, though the letter is not open yet", () => {
    const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example"), row(3, "c@cur.example")]);
    // j: the old letter is still open, the new one only selected.
    app.reader.opened = { row: row(1, "a@cur.example") } as never;
    app.selected = new Set([1]);
    flushSync();
    expect(cursors(t)).toEqual([true, false, false]);
    app.selected = new Set([2]);
    flushSync();
    expect(cursors(t)).toEqual([false, true, false]);
    app.reader.opened = null;
  });

  it("stays on the selected row when the open failed, and on a row a Shift click left alone", () => {
    const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example")]);
    app.reader.opened = null;
    app.reader.openingRow = null;
    app.selected = new Set([2]);
    flushSync();
    expect(cursors(t)).toEqual([false, true]);
  });

  it("follows the letter being opened, then the open one, with several chosen", () => {
    const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example"), row(3, "c@cur.example")]);
    app.selected = new Set([1, 2]);
    app.reader.opened = { row: row(1, "a@cur.example") } as never;
    flushSync();
    expect(cursors(t)).toEqual([true, false, false]);
    app.reader.openingRow = row(2, "b@cur.example");
    flushSync();
    expect(cursors(t)).toEqual([false, true, false]);
    app.reader.opened = null;
    app.reader.openingRow = null;
  });
});

describe("the list scrolls after the cursor only when the cursor moves by a key (#122)", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, `p${i + 1}@cur.example`));

  /** jsdom has no layout: the viewport remembers what the list wrote to its scrollTop. */
  function watch(t: HTMLElement) {
    const viewport = t.querySelector<HTMLElement>(".viewport")!;
    let top = 0;
    const writes: number[] = [];
    Object.defineProperty(viewport, "scrollTop", { get: () => top, set: (v: number) => { top = v; writes.push(v); }, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { get: () => 128, configurable: true });
    return writes;
  }

  it("stays where it is when a Ctrl click takes a visible row out and leaves a row below the screen", async () => {
    const t = draw(rows);
    // Letter 40 is the open one, below the screen: the list went to it when it opened.
    app.reader.opened = { row: rows[39] } as never;
    app.reader.openingRow = null;
    app.selected = new Set([1, 40]);
    flushSync();
    const writes = watch(t);
    t.querySelector<HTMLElement>(".row")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    flushSync();
    await tick();
    expect([...app.selected]).toEqual([40]);
    expect(writes).toEqual([]);
    // The list refreshed under the same cursor (new mail, a sync) does not jump to it either.
    app.list.messages = [...app.messages];
    flushSync();
    await tick();
    expect(writes).toEqual([]);
    // A key afterwards does follow the cursor.
    app.selected = new Set([39]);
    flushSync();
    expect(writes.length).toBeGreaterThan(0);
    app.reader.opened = null;
  });
});

describe("the logos by folder (#108)", () => {
  it("asks for no logo of a letter in Spam or in Trash, in the list (#108)", async () => {
    app.mailboxes.folders = [
      { account_id: "a", name: "Junk", role: "junk" },
      { account_id: "a", name: "Trash", role: "trash" },
      { account_id: "a", name: "INBOX", role: "inbox" },
    ] as never;
    draw([
      row(1, "spam@junk.example", { dmarc: true, folder: "Junk" }),
      row(2, "old@trash.example", { dmarc: true, folder: "Trash" }),
      row(3, "ok@inbox.example", { dmarc: true, folder: "INBOX" }),
    ]);
    await tick();
    expect(api.avatar).toHaveBeenCalledWith("a", "spam@junk.example", false);
    expect(api.avatar).toHaveBeenCalledWith("a", "old@trash.example", false);
    expect(api.avatar).toHaveBeenCalledWith("a", "ok@inbox.example", true);
    app.mailboxes.folders = [];
  });
});

describe("the mark of a letter asked to be read first (#72)", () => {
  it("stands before the other marks of a high letter only, also with the avatars off", () => {
    for (const over of [{}, { list_avatars: false }]) {
      const t = draw([
        row(1, "a@imp.example", { importance: "high", flags: { seen: true, answered: false, flagged: true, draft: false, deleted: false, forwarded: false, answered_all: false }, has_attachments: true }),
        row(2, "b@imp.example", { importance: "normal" }),
        row(3, "c@imp.example", { importance: "low" }),
      ], over);
      const [high, normal, low] = [...t.querySelectorAll<HTMLElement>(".row")];
      const bang = high.querySelector<HTMLElement>(".imp")!;
      expect(bang.textContent).toBe("!");
      expect(bang.getAttribute("aria-label")).toBe("Высокая важность");
      // The first of the marks: before the flag and the paperclip, which come before the date.
      const order = [...high.querySelectorAll(".line1 > *")];
      expect(order.indexOf(bang)).toBeLessThan(order.indexOf(high.querySelector(".flag")!));
      expect(order.indexOf(bang)).toBeLessThan(order.indexOf(high.querySelector(".clip")!));
      expect(order.indexOf(bang)).toBeLessThan(order.indexOf(high.querySelector(".date")!));
      // Low is kept in the cache and not shown (3.1 А).
      expect(normal.querySelector(".imp")).toBeNull();
      expect(low.querySelector(".imp")).toBeNull();
      unmount(view!);
      view = null;
      document.body.innerHTML = "";
    }
  });
});

describe("the unread state without the dot (#108)", () => {
  it("is part of the name of an unread row and absent from the name of a read one", () => {
    const unseen = { seen: false, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false };
    const t = draw([row(1, "a@x.example", { flags: unseen }), row(2, "b@x.example")]);
    const [unread, read] = [...t.querySelectorAll<HTMLElement>(".row")];
    expect(unread.textContent).toMatch(/^Не прочитано, /);
    expect(read.textContent).not.toContain("Не прочитано");
  });
});
