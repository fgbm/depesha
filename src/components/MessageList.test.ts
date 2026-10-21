// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import MessageList from "./MessageList.svelte";
import ReaderStates from "./reader/ReaderStates.svelte";
import { app } from "../lib/store.svelte";
import { bus } from "../lib/bus";
import { layout } from "../lib/layout.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, deferred, settings } from "../lib/testing";
import { registry } from "../plugin-host/registry.svelte";
import { pseudoSelectors, rulesFor, useStyles } from "../lib/cssTesting";
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
  app.settingsCtl.settings = { ...settings(), ...over };
  app.mailboxes.accounts = [account];
  app.list.messages = rows;
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(MessageList, { target, props: { searchInput: null } });
  flushSync();
  return target;
}

// The thread of #179: the backend's `thread` returns the summary's own letter among the others.
const letters = [
  row(1, "ann@x.example", { thread: "t9", date: 900, subject: "Re: Счёт" }),
  row(11, "peter@x.example", { thread: "t9", folder: "Sent", date: 950, subject: "Re: Счёт" }),
  row(12, "ann@x.example", { thread: "t9", date: 1000, subject: "Re: Счёт" }),
];
const summary = (over: Partial<MessageRow> = {}) => row(1, "ann@x.example", { thread: "t9", thread_count: 3, thread_date: 1000, subject: "Re: Счёт", ...over });
const subs = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>(".row.sub")];
/** Sends → to the first row of the list, as the keyboard does. */
function unfoldByArrow(t: HTMLElement) {
  t.querySelector<HTMLElement>(".row")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  flushSync();
}
/** Unfolds the thread of the first row by → and lets its letters arrive. */
async function unfold(t: HTMLElement) {
  api.thread.mockResolvedValue(letters);
  unfoldByArrow(t);
  await tick();
  flushSync();
}

beforeEach(() => {
  i18n.lang = "ru";
  api.avatar.mockReset();
  api.avatar.mockResolvedValue(null);
  app.selection.selected = new Set();
  app.list.clearThreads();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  layout.width = 1280;
  app.list.view = { kind: "unified", role: "inbox" };
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
    expect(api.avatar).toHaveBeenCalledWith("a", "ozon@two.example", 1);
    expect(api.avatar).toHaveBeenCalledWith("a", "ivan@two.example", null);
  });

  it("never lets the network in when the logos are off: the circle asks without the brand flag", async () => {
    draw([row(1, "ozon@three.example", { dmarc: true })], { sender_logos: false });
    await tick();
    expect(api.avatar).toHaveBeenCalledWith("a", "ozon@three.example", null);
    expect(api.avatar).not.toHaveBeenCalledWith("a", "ozon@three.example", 1);
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
    app.selection.selected = new Set([2]);
    flushSync();
    let rows = t.querySelectorAll(".row");
    expect(rows[1].querySelector(".pic")).not.toBeNull();
    expect(rows[1].querySelector(".pick")).toBeNull();
    expect(rows[1].classList.contains("selected")).toBe(false);
    // Two chosen: both have the tick and the ground, the third keeps its circle.
    app.selection.selected = new Set([1, 2]);
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
    app.selection.selected = new Set([1, 2]);
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
    app.selection.selected = new Set([1]);
    flushSync();
    expect(cursors(t)).toEqual([true, false, false]);
    app.selection.selected = new Set([2]);
    flushSync();
    expect(cursors(t)).toEqual([false, true, false]);
    app.reader.opened = null;
  });

  it("stays on the selected row when the open failed, and on a row a Shift click left alone", () => {
    const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example")]);
    app.reader.opened = null;
    app.reader.openingRow = null;
    app.selection.selected = new Set([2]);
    flushSync();
    expect(cursors(t)).toEqual([false, true]);
  });

  it("follows the letter being opened, then the open one, with several chosen", () => {
    const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example"), row(3, "c@cur.example")]);
    app.selection.selected = new Set([1, 2]);
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

describe("the cursor has the ground, not a bar (#165, #108)", () => {
  it("tells the three states by the classes and the tick: cursor, chosen, cursor on a chosen one", () => {
    const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example"), row(3, "c@cur.example")]);
    app.reader.opened = null;
    app.reader.openingRow = null;
    app.selection.selected = new Set([1]);
    flushSync();
    let rows = [...t.querySelectorAll(".row")];
    // The cursor: the ground class, no tick.
    expect(rows[0].classList.contains("cursor")).toBe(true);
    expect(rows[0].querySelector(".pick")).toBeNull();
    app.selection.selected = new Set([2, 3]);
    app.reader.openingRow = row(2, "b@cur.example");
    flushSync();
    rows = [...t.querySelectorAll(".row")];
    // Cursor on a chosen row: the ground and the tick; the other chosen row: the tick without the cursor.
    expect(rows[1].classList.contains("cursor") && rows[1].classList.contains("selected")).toBe(true);
    expect(rows[1].querySelector(".pick")).not.toBeNull();
    expect(rows[2].classList.contains("cursor")).toBe(false);
    expect(rows[2].classList.contains("selected")).toBe(true);
    expect(rows[2].querySelector(".pick")).not.toBeNull();
    app.reader.openingRow = null;
  });

  describe("as the browser draws it", () => {
    let unstyle = () => {};
    beforeEach(() => (unstyle = useStyles(import.meta.url, "./MessageList.svelte")));
    afterEach(() => unstyle());
    const ground = (el: Element) => getComputedStyle(el).background;
    const BARE = "rgba(0, 0, 0, 0)";

    it("gives the ground to the rows the action acts on: the chosen ones, or the open letter alone", () => {
      const t = draw([row(1, "a@cur.example"), row(2, "b@cur.example"), row(3, "c@cur.example")]);
      // The open letter with nothing chosen together: it is the cursor, and wears the ground.
      app.selection.selected = new Set();
      app.reader.opened = null;
      app.reader.openingRow = row(1, "a@cur.example");
      flushSync();
      expect([...t.querySelectorAll(".row")].map(ground)).toEqual(["var(--selected)", BARE, BARE]);
      // Several chosen: the ground goes with the choice; the cursor outside it has the hover ground.
      app.reader.openingRow = row(2, "b@cur.example");
      app.selection.selected = new Set([1, 3]);
      flushSync();
      expect([...t.querySelectorAll(".row")].map(ground)).toEqual(["var(--selected)", "var(--hover)", "var(--selected)"]);
      app.reader.openingRow = null;
      app.selection.selected = new Set();
      flushSync();
      expect([...t.querySelectorAll(".row")].map(ground)).not.toContain("var(--selected)");
    });

    it("gives the subject the place it needs and the preview only what is left", () => {
      const [subject] = rulesFor(".subject");
      const [preview] = rulesFor(".preview");
      expect(subject.style.getPropertyValue("flex")).toBe("0 1 auto");
      expect(preview.style.getPropertyValue("flex")).toBe("1 1 0");
    });

    it("has no bar: no element for it and no rule that draws one before a row", () => {
      const t = draw([row(1, "a@cur.example")]);
      app.selection.selected = new Set([1]);
      flushSync();
      expect(t.querySelector(".row .bar, .row .cursor-bar")).toBeNull();
      expect(pseudoSelectors().filter((x) => x.includes(".row") && x.includes("::before"))).toEqual([]);
    });

    it("marks a row that has the keyboard without being the cursor by the same ground, no frame", () => {
      const [rule] = rulesFor(".row:focus-visible:not(.cursor)");
      expect(rule.style.getPropertyValue("background")).toBe("var(--selected)");
      expect(rule.style.getPropertyValue("box-shadow")).toBe("");
      expect(rule.style.getPropertyValue("outline")).toBe("");
    });
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
    app.selection.selected = new Set([1, 40]);
    flushSync();
    const writes = watch(t);
    t.querySelector<HTMLElement>(".row")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    flushSync();
    await tick();
    expect([...app.selection.selected]).toEqual([40]);
    expect(writes).toEqual([]);
    // The list refreshed under the same cursor (new mail, a sync) does not jump to it either.
    app.list.messages = [...app.list.messages];
    flushSync();
    await tick();
    expect(writes).toEqual([]);
    // A key afterwards does follow the cursor.
    app.selection.selected = new Set([39]);
    flushSync();
    expect(writes.length).toBeGreaterThan(0);
    app.reader.opened = null;
  });

  it("goes to a cursor row that was not in the list yet once it is loaded", async () => {
    const t = draw(rows);
    app.reader.opened = null;
    app.reader.openingRow = null;
    app.selection.selected = new Set([41]);
    flushSync();
    const writes = watch(t);
    expect(writes).toEqual([]);
    app.list.messages = [...rows, row(41, "p41@cur.example")];
    flushSync();
    await tick();
    expect(writes.length).toBeGreaterThan(0);
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
    expect(api.avatar).toHaveBeenCalledWith("a", "spam@junk.example", null);
    expect(api.avatar).toHaveBeenCalledWith("a", "old@trash.example", null);
    expect(api.avatar).toHaveBeenCalledWith("a", "ok@inbox.example", 3);
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

describe("where the search box lives (#176, question 1.2 «Б»)", () => {
  it("is not the list's own in the wide window: the panel above carries it", () => {
    layout.width = 1440;
    const t = draw([row(1, "a@x.example")]);
    expect(t.querySelector(".search")).toBeNull();
  });

  it("is the list's own in a narrow window, where there is no panel (1.5 А)", () => {
    layout.width = 640;
    const t = draw([row(1, "a@x.example")]);
    expect(t.querySelector(".search")).not.toBeNull();
  });
});

describe("the beginning of the letter's text in the row (#177)", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./MessageList.svelte")));
  afterEach(() => unstyle());

  it("stands after the subject, in the second line", () => {
    const t = draw([row(1, "a@x.example", { snippet: "Добрый день! Счёт во вложении." })]);
    const line = t.querySelector<HTMLElement>(".row .line2")!;
    const kids = [...line.children];
    const subject = line.querySelector(".subject")!;
    const preview = line.querySelector<HTMLElement>(".preview")!;
    expect(preview.textContent).toBe("Добрый день! Счёт во вложении.");
    expect(kids.indexOf(preview)).toBe(kids.indexOf(subject) + 1);
    // The row is still two lines: the preview takes no line of its own.
    expect(t.querySelectorAll(".row .line1, .row .line2")).toHaveLength(2);
  });

  it("draws it grey, in one line, cut with an ellipsis", () => {
    const [rule] = rulesFor(".preview");
    const css = (p: string) => rule.style.getPropertyValue(p);
    expect(css("color")).toBe("var(--muted)");
    expect(css("white-space")).toBe("nowrap");
    expect(css("text-overflow")).toBe("ellipsis");
    expect(css("overflow")).toBe("hidden");
  });

  it("shows only the subject when there is no text", () => {
    const t = draw([row(1, "a@x.example")]);
    expect(t.querySelector(".row .preview")).toBeNull();
    expect(t.querySelector(".row .subject")?.textContent).toBe("Тема 1");
  });
});

describe("the thread unfolded in the list (#179, decisions 0.8.3, screen 3)", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./MessageList.svelte")));
  afterEach(() => unstyle());

  it("unfolds the thread by → and folds it back by ←", async () => {
    const t = draw([summary()]);
    expect(subs(t)).toHaveLength(0);
    await unfold(t);
    expect(api.thread).toHaveBeenCalledWith(1);
    // The thread has three letters; the row's own letter is not repeated among them (#179).
    expect(subs(t)).toHaveLength(2);
    expect(subs(t)[0].textContent).toContain("peter@x.example");
    expect(subs(t)[1].textContent).toContain("ann@x.example");
    t.querySelector<HTMLElement>(".row")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    flushSync();
    expect(subs(t)).toHaveLength(0);
  });

  it("does not unfold a row without a thread: the arrows are deaf to it", () => {
    const t = draw([row(1, "a@x.example")]);
    t.querySelector<HTMLElement>(".row")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();
    expect(api.thread).not.toHaveBeenCalled();
    expect(subs(t)).toHaveLength(0);
  });

  it("shows the plugin badges of a letter of a thread, as an ordinary row does (#179)", async () => {
    registry.add("rowTags", "probe", (m) => (m.id === 11 ? { text: "Ждёт ответа", note: { text: "Напоминание" } } : null));
    const list = layout.list;
    // Wide enough for the quiet note of the first line, which a narrow list hides.
    layout.list = 500;
    try {
      const t = draw([summary()]);
      await unfold(t);
      // The letter the plugin tags carries both the quiet note and the badge of a row.
      expect(subs(t)[0].querySelector(".tag")?.textContent).toContain("Ждёт ответа");
      expect(subs(t)[0].querySelector(".note")?.textContent).toContain("Напоминание");
      // A letter the plugin does not tag carries neither.
      expect(subs(t)[1].querySelector(".tag")).toBeNull();
      expect(subs(t)[1].querySelector(".note")).toBeNull();
    } finally {
      layout.list = list;
      registry.removeOwner("probe");
    }
  });

  it("unfolds and folds by a click on the counter, which is not a stop of the keyboard", async () => {
    const t = draw([summary()]);
    const count = t.querySelector<HTMLButtonElement>(".count")!;
    expect(count).not.toBeNull();
    expect(count.getAttribute("tabindex")).toBe("-1");
    expect(t.querySelectorAll("[role='option']")).toHaveLength(1);
    count.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    await tick();
    flushSync();
    expect(subs(t)).toHaveLength(2);
    expect(t.querySelectorAll("[role='option']")).toHaveLength(3);
    t.querySelector<HTMLButtonElement>(".count")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    expect(subs(t)).toHaveLength(0);
  });
});

describe("a long thread and the ground of its letters (#179)", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./MessageList.svelte")));
  afterEach(() => unstyle());

  it("unfolds a long thread whole, without folding the far history (3.2 А)", async () => {
    const many = [row(1, "ann@x.example", { thread: "t9", date: 800 }), ...Array.from({ length: 8 }, (_, i) => row(20 + i, `p${i}@x.example`, { thread: "t9", date: 801 + i }))];
    api.thread.mockResolvedValue(many);
    const t = draw([summary({ thread_count: 9 })]);
    unfoldByArrow(t);
    await tick();
    flushSync();
    expect(subs(t)).toHaveLength(8);
  });

  it("gives the letters of a thread no ground of their own (3.1 А): only the indent", async () => {
    const t = draw([summary()]);
    await unfold(t);
    const [rule] = rulesFor(".row.sub");
    expect(rule.style.getPropertyValue("background")).toBe("");
    expect(rule.style.getPropertyValue("padding")).not.toBe("");
    expect(subs(t).every((r) => !r.classList.contains("selected"))).toBe(true);
  });

  it("draws no bar at the left of a letter of a thread: no rule for it at all", () => {
    expect(rulesFor(".row.sub.cursor")).toEqual([]);
    expect(rulesFor(".row.sub").every((r) => r.style.getPropertyValue("box-shadow") === "")).toBe(true);
  });
});

describe("the cursor and the actions of a thread letter in the list (#179)", () => {
  it("moves the cursor over the letters of an unfolded thread", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([1]);
    flushSync();
    app.selection.move(1);
    flushSync();
    expect([...app.selection.selected]).toEqual([11]);
    app.selection.move(1);
    flushSync();
    expect([...app.selection.selected]).toEqual([12]);
    expect(subs(t)[1].classList.contains("cursor")).toBe(true);
  });

  it("acts on a letter of a thread: the action takes the letter itself", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([11]);
    flushSync();
    await app.selection.toggleFlagged();
    expect(api.setFlag).toHaveBeenCalledWith([11], { flag: "flagged", value: true });
    expect(app.list.threadRow(11)?.flags.flagged).toBe(true);
    flushSync();
    expect(subs(t)[0].classList.contains("cursor")).toBe(true);
  });

  it("leaves the arrows of a letter of a thread to the row with the counter", async () => {
    const t = draw([summary()]);
    await unfold(t);
    subs(t)[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    flushSync();
    expect(subs(t)).toHaveLength(2);
  });

  it("shows the folder of a letter of a thread that is not the folder shown", async () => {
    app.list.view = { kind: "folder", account_id: "a", folder: "INBOX" };
    const t = draw([summary()]);
    api.thread.mockResolvedValue([
      row(1, "ann@x.example", { thread: "t9", folder: "INBOX", date: 900 }),
      row(11, "ann@x.example", { thread: "t9", folder: "INBOX", date: 920 }),
      row(12, "peter@x.example", { thread: "t9", folder: "Archive", date: 950 }),
    ]);
    unfoldByArrow(t);
    await tick();
    flushSync();
    const [inFolder, inArchive] = subs(t);
    expect(inFolder.querySelector(".subfolder")).toBeNull();
    expect(inArchive.querySelector(".subfolder")?.textContent).toBe("Archive");
  });
});

describe("a row of a thread and its letters are told apart (#179)", () => {
  it("↓↓↓ leads the cursor out of the thread to the next row", async () => {
    const t = draw([summary(), row(2, "b@x.example", { thread: "t10", thread_count: 2 })]);
    await unfold(t);
    app.selection.selected = new Set([1]);
    flushSync();
    for (let i = 0; i < 3; i++) {
      app.selection.move(1);
      flushSync();
    }
    expect([...app.selection.selected]).toEqual([2]);
  });

  it("puts the cursor on one row only: the row of the thread and its letter are not both lit", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([1]);
    flushSync();
    expect(t.querySelectorAll(".row.cursor")).toHaveLength(1);
    expect(t.querySelector<HTMLElement>(".row.cursor")!.classList.contains("sub")).toBe(false);
  });

  it("e on a letter of a thread archives that letter alone, not the whole thread", async () => {
    const t = draw([summary()]);
    await unfold(t);
    api.archive.mockResolvedValue([]);
    api.messages.mockResolvedValue([summary()]);
    app.selection.selected = new Set([11]);
    flushSync();
    await app.actions.archive();
    expect(api.archive.mock.calls[0][0]).toEqual([11]);
  });

  it("# on a letter of a thread deletes that letter alone", async () => {
    const t = draw([summary()]);
    await unfold(t);
    api.remove.mockResolvedValue([]);
    api.messages.mockResolvedValue([summary()]);
    app.selection.selected = new Set([12]);
    flushSync();
    await app.actions.remove();
    expect(api.remove.mock.calls[0][0]).toEqual([12]);
  });
});

describe("a move of a letter of a thread (#180)", () => {
  it("keeps the row of an archived letter of a thread, naming its new folder", async () => {
    app.list.view = { kind: "folder", account_id: "a", folder: "INBOX" };
    app.mailboxes.folders = [
      { account_id: "a", name: "INBOX", role: "inbox" },
      { account_id: "a", name: "Archive", role: "archive" },
    ] as never;
    const t = draw([summary()]);
    await unfold(t);
    api.messages.mockResolvedValue([summary()]);
    api.archive.mockResolvedValue([{ account_id: "a", from: "Sent", to: "Archive", message_ids: ["<11@x>"], unseen: [], snoozed: [], waits: [] }]);
    app.selection.selected = new Set([11]);
    flushSync();
    await app.actions.archive();
    await tick();
    flushSync();
    // The row stays where it was; the folder beside it is the new one.
    expect(subs(t)).toHaveLength(2);
    expect(subs(t)[0].querySelector(".subfolder")?.textContent).toBe("Archive");
  });

  it("writes the folder of the letter back when the move is taken back with «z» (#180)", async () => {
    app.list.view = { kind: "folder", account_id: "a", folder: "INBOX" };
    app.mailboxes.folders = [
      { account_id: "a", name: "INBOX", role: "inbox" },
      { account_id: "a", name: "Archive", role: "archive" },
    ] as never;
    const t = draw([summary()]);
    await unfold(t);
    api.messages.mockResolvedValue([summary()]);
    api.archive.mockResolvedValue([{ account_id: "a", from: "Sent", to: "Archive", message_ids: ["<11@x>"], unseen: [], snoozed: [], waits: [] }]);
    app.selection.selected = new Set([11]);
    flushSync();
    await app.actions.archive();
    await tick();
    flushSync();
    expect(subs(t)[0].querySelector(".subfolder")?.textContent).toBe("Archive");
    // The undo puts the letter back where it was: the folder it names is the old one again.
    await app.actions.undo();
    flushSync();
    expect(subs(t)[0].querySelector(".subfolder")?.textContent).toBe("Sent");
  });

  it("lets a letter the trash takes go, as api.thread leaves it out (#180)", async () => {
    app.list.view = { kind: "folder", account_id: "a", folder: "INBOX" };
    app.mailboxes.folders = [
      { account_id: "a", name: "INBOX", role: "inbox" },
      { account_id: "a", name: "Trash", role: "trash" },
    ] as never;
    const t = draw([summary()]);
    await unfold(t);
    api.messages.mockResolvedValue([summary()]);
    api.remove.mockResolvedValue([{ account_id: "a", from: "Sent", to: "Trash", message_ids: ["<11@x>"], unseen: [], snoozed: [], waits: [] }]);
    app.selection.selected = new Set([11]);
    flushSync();
    await app.actions.remove();
    await tick();
    flushSync();
    expect(subs(t)).toHaveLength(1);
    expect(subs(t)[0].textContent).toContain("ann@x.example");
  });
});

describe("a reload and an unfolded thread (#179)", () => {
  it("reads the thread again when its row changed: a new letter becomes a row", async () => {
    const t = draw([summary()]);
    await unfold(t);
    expect(subs(t)).toHaveLength(2);
    // The list is read again with a longer thread: its letters are read again too.
    api.messages.mockResolvedValue([summary({ thread_count: 4, thread_date: 1100 })]);
    api.thread.mockResolvedValue([...letters, row(13, "peter@x.example", { thread: "t9", date: 1100 })]);
    await app.list.reload();
    await tick();
    flushSync();
    expect(subs(t)).toHaveLength(3);
    expect(subs(t)[2].textContent).toContain("peter@x.example");
  });

  it("lets a letter gone from the thread go", async () => {
    const t = draw([summary()]);
    await unfold(t);
    api.messages.mockResolvedValue([summary({ thread_count: 2, thread_date: 1000 })]);
    api.thread.mockResolvedValue([letters[0], letters[2]]);
    await app.list.reload();
    await tick();
    flushSync();
    expect(subs(t)).toHaveLength(1);
  });
});

describe("an answer of api.thread that arrives too late (#179)", () => {
  it("is dropped when the view changed while the letters were on their way", async () => {
    const t = draw([summary()]);
    const pending = deferred<MessageRow[]>();
    api.thread.mockReturnValue(pending.promise);
    unfoldByArrow(t);
    await tick();
    // The view changes while the letters are still coming.
    app.list.reset({ kind: "folder", account_id: "a", folder: "Archive" });
    flushSync();
    pending.resolve(letters);
    await tick();
    flushSync();
    expect(app.list.threadLetters.size).toBe(0);
    expect(subs(t)).toHaveLength(0);
  });
});

describe("the key of an unfolded thread (#179)", () => {
  it("keeps the threads of two mailboxes apart in the unified inbox", async () => {
    const other = { ...account, id: "b", label: "Б", email: "me@b" } as unknown as AccountView;
    const t = draw([
      row(1, "ann@a.example", { thread: "t9", thread_count: 2, account_id: "a" }),
      row(2, "ann@b.example", { thread: "t9", thread_count: 2, account_id: "b" }),
    ]);
    app.mailboxes.accounts = [account, other];
    flushSync();
    const a = (id: number, date: number) => row(id, "ann@a.example", { thread: "t9", account_id: "a", date });
    const b = (id: number, date: number) => row(id, "ann@b.example", { thread: "t9", account_id: "b", date });
    api.thread.mockImplementation(async (id: number) => (id === 1 ? [a(1, 900), a(11, 950)] : [b(2, 900), b(21, 950)]));
    t.querySelector<HTMLElement>(".row")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();
    await tick();
    flushSync();
    expect(subs(t)).toHaveLength(1);
    expect(subs(t)[0].textContent).toContain("ann@a.example");
  });
});

describe("the choice over the letters of a thread (#179)", () => {
  it("Shift takes a range from the row to a letter of its thread", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([1]);
    app.selection.anchor = 1;
    flushSync();
    subs(t)[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    flushSync();
    expect([...app.selection.selected].sort((a, b) => a - b)).toEqual([1, 11, 12]);
  });

  it("Ctrl adds one letter of a thread, shown by the ground alone, without a tick (#179)", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([1]);
    flushSync();
    subs(t)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    flushSync();
    expect([...app.selection.selected].sort((a, b) => a - b)).toEqual([1, 11]);
    expect(subs(t)[0]!.classList.contains("selected")).toBe(true);
    expect(subs(t)[0]!.querySelector(".pick")).toBeNull();
  });

  it("highlights exactly the rows it counts as chosen (#179)", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([1, 11]);
    flushSync();
    const marked = [...t.querySelectorAll(".row")].filter((r) => r.classList.contains("selected"));
    expect(marked.length).toBe(app.selection.selected.size);
    // The letter of the thread is one of them, and carries no tick of its own.
    expect(subs(t)[0].classList.contains("selected")).toBe(true);
    expect(subs(t)[0].querySelector(".pick")).toBeNull();
  });

  it("marks the open letter of a thread as the cursor alone: no tick of a choice (#179)", async () => {
    const t = draw([summary()]);
    await unfold(t);
    // The open letter is a row of the thread: it is the cursor, and nothing is chosen.
    app.reader.opened = { row: letters[2] } as never;
    app.selection.selected = new Set();
    flushSync();
    expect(subs(t)[1].classList.contains("cursor")).toBe(true);
    expect(subs(t)[1].classList.contains("selected")).toBe(false);
    expect(subs(t)[1].querySelector(".pick")).toBeNull();
    app.reader.opened = null;
  });

  it("Select all and the chosen size count the letters of an unfolded thread too", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selectAll();
    flushSync();
    expect([...app.selection.selected].sort((a, b) => a - b)).toEqual([1, 11, 12]);
    // Every row says 10 bytes; the letters of the thread count as well.
    expect(app.selection.selectedSize()).toBe(30);
  });
});

describe("the ground of a choice over a thread", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./MessageList.svelte")));
  afterEach(() => unstyle());
  const ground = (el: Element) => getComputedStyle(el).background;
  const grounded = (t: HTMLElement) => [...t.querySelectorAll(".row")].filter((r) => ground(r) === "var(--selected)");

  it("grounds exactly the rows the count names when a letter of a thread is the open one", async () => {
    const t = draw([summary()]);
    await unfold(t);
    // The reader names the selection while the list grounds it: both stand as the window draws them.
    const pane = document.createElement("div");
    document.body.append(pane);
    const reader = mount(ReaderStates, { target: pane, props: { which: "bare", waited: 0 } });
    try {
      // A third letter is open, two of the thread are added to it with Ctrl.
      app.selection.selected = new Set([1, 11, 12]);
      app.reader.opened = { row: letters[2] } as never;
      flushSync();
      // The label counts the selection; the rows with the ground are as many, the open letter of
      // the thread among them — it is not left to a bar at the left instead.
      expect(app.selection.selected.size).toBe(3);
      expect(pane.textContent).toMatch(/Выбрано 3/);
      expect(grounded(t).length).toBe(3);
    } finally {
      unmount(reader);
      pane.remove();
      app.reader.opened = null;
    }
  });

  it("gives the open letter of a thread the ground when nothing is chosen together, as a row of a list", async () => {
    const t = draw([summary()]);
    await unfold(t);
    // Opening a letter leaves only it selected: a single selection is the open letter.
    app.reader.opened = { row: letters[2] } as never;
    app.selection.selected = new Set([12]);
    flushSync();
    const open = subs(t)[1];
    expect(open.classList.contains("cursor")).toBe(true);
    expect(open.classList.contains("selected")).toBe(false);
    expect(ground(open)).toBe("var(--selected)");
    app.reader.opened = null;
  });

  it("draws no bar, bracket or frame at the left of any row", async () => {
    const t = draw([summary()]);
    await unfold(t);
    app.selection.selected = new Set([1, 11, 12]);
    app.reader.opened = { row: letters[2] } as never;
    flushSync();
    expect(rulesFor(".row.sub.cursor")).toEqual([]);
    expect(t.querySelector(".row .bar, .row .cursor-bar")).toBeNull();
    for (const r of t.querySelectorAll<HTMLElement>(".row")) expect(getComputedStyle(r).boxShadow).toBe("");
    app.reader.opened = null;
  });
});

describe("a letter of a thread in a window of its own, and its accessibility (#179)", () => {
  it("opens the letter in a window of its own on a double click", async () => {
    const t = draw([summary()]);
    await unfold(t);
    subs(t)[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    flushSync();
    expect(api.messageWindow).toHaveBeenCalledWith(11, expect.any(String));
  });

  it("marks the row-option as expanded and names the number in the counter", async () => {
    const t = draw([summary()]);
    expect(t.querySelector<HTMLElement>(".row")!.getAttribute("aria-expanded")).toBe("false");
    expect(t.querySelector(".count")!.getAttribute("aria-label")).toContain("3");
    await unfold(t);
    expect(t.querySelector<HTMLElement>(".row")!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the menu of a row from the keyboard (#126)", () => {
  it("opens for the row with the cursor on the command, and gives the focus back on Escape", async () => {
    const t = draw([row(1, "ann@x.example"), row(2, "bob@x.example")]);
    await tick();
    app.selection.selected = new Set([2]);
    flushSync();
    const rowEl = t.querySelector<HTMLElement>(".row")!;
    rowEl.focus();
    expect(document.querySelector("button.mi")).toBeNull();
    bus.emit("list.row-menu");
    await tick();
    flushSync();
    expect(document.querySelector("button.mi")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    flushSync();
    expect(document.querySelector("button.mi")).toBeNull();
    expect(document.activeElement).toBe(rowEl);
  });

  it("does nothing when no row is chosen", async () => {
    draw([row(1, "ann@x.example")]);
    await tick();
    bus.emit("list.row-menu");
    await tick();
    expect(document.querySelector("button.mi")).toBeNull();
  });
});

describe("the operators under «nothing found» (А10)", () => {
  it("are the Russian ones of the search box, with the folder sample of its suggestions", () => {
    app.list.view = { kind: "search", text: "ничего" };
    const t = draw([]);
    const ops = [...t.querySelectorAll(".ops code")].map((c) => c.textContent);
    expect(ops).toContain("это:непрочитанное");
    expect(ops).toContain("в:Папка/*");
    expect(ops).not.toContain("is:unread");
    expect(ops).not.toContain("в:Работа/*");
  });
});
