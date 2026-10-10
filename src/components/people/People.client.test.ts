// @vitest-environment jsdom
// The address book at work (#104): the card of a person with several addresses, the book of the
// main window, the dialog that joins people. Keyboard first: every gesture below is a key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync, mount, tick, unmount } from "svelte";
import PersonCard from "../reader/PersonCard.svelte";
import PeopleView from "./PeopleView.svelte";
import MergeDialog from "./MergeDialog.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { blankPerson, type Person } from "../../lib/people";
import { peopleBook } from "../../lib/peopleBook.svelte";
import { peopleOps } from "../../lib/peopleOps.svelte";
import { bus } from "../../lib/bus";
import { api } from "../../lib/testing";

// jsdom has no CSS.escape and no scrolling; the components use both.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

let next = 1;
const person = (name: string, emails: string[], fields: Partial<Person> = {}): Person => ({
  ...blankPerson(emails[0]),
  id: next++,
  name,
  emails: emails.map((email, i) => ({ email, primary: i === 0, uses: 3, name: "" })),
  uses: 3 * emails.length,
  heard: true,
  ...fields,
});

const olga = () => person("Ольга Смирнова", ["olga@example.org", "o.smirnova@example.com"], { note: "Заказывает залы" });
const ivan = () => person("Иван Петров", ["ivan@example.org"]);

async function book(list: Person[]) {
  api.people.mockResolvedValue(list);
  api.hints.mockResolvedValue([]);
  await peopleBook.refresh();
}

const press = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, code: /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  flushSync();
  return e;
};

const rowOf = (root: ParentNode, mark: string) => root.querySelector<HTMLElement>(`[data-r="${mark}"]`)!;

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function show(component: typeof PersonCard | typeof PeopleView | typeof MergeDialog, props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.append(target);
  view = mount(component as never, { target, props });
  flushSync();
  return target;
}

beforeEach(() => {
  i18n.lang = "ru";
  next = 1;
  for (const m of Object.values(api)) m.mockReset();
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  api.search.mockResolvedValue([]);
  peopleOps.cancel();
  peopleOps.stopPicking();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the card of a person with two addresses", () => {
  it("lists both, the primary marked, and shows the note", async () => {
    await book([olga()]);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    expect(root.textContent).toContain("Ольга Смирнова");
    const rows = [...root.querySelectorAll(".addr")];
    expect(rows.map((r) => r.querySelector(".em")?.textContent)).toEqual(["olga@example.org", "o.smirnova@example.com"]);
    expect(rows[0].querySelector(".radio.on")).not.toBeNull();
    expect(rows[1].querySelector(".radio.on")).toBeNull();
    expect(rowOf(root, "note").textContent).toContain("Заказывает залы");
  });

  it("writes the name on Enter, saves it on Enter and leaves on Esc (2.1 Б)", async () => {
    await book([olga()]);
    api.personSave.mockImplementation(async (p) => p);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    rowOf(root, "name").focus();
    press(rowOf(root, "name"), "F2");
    const input = root.querySelector<HTMLInputElement>("input[data-own]")!;
    expect(input.value).toBe("Ольга Смирнова");
    // Esc leaves the line and saves nothing.
    press(input, "Escape");
    expect(root.querySelector("input[data-own]")).toBeNull();
    expect(api.personSave).not.toHaveBeenCalled();
    press(rowOf(root, "name"), "F2");
    const again = root.querySelector<HTMLInputElement>("input[data-own]")!;
    again.value = "Ольга С.";
    again.dispatchEvent(new Event("input", { bubbles: true }));
    press(again, "Enter");
    await tick();
    expect(api.personSave).toHaveBeenCalledWith(expect.objectContaining({ id: 1, name: "Ольга С." }));
  });

  it("keeps the note's Shift+Enter for a new line and saves on Enter", async () => {
    await book([olga()]);
    api.personSave.mockImplementation(async (p) => p);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    press(rowOf(root, "note"), "Enter");
    // Enter on a button clicks it in a browser; the click opens the line.
    rowOf(root, "note").click();
    flushSync();
    const area = root.querySelector<HTMLTextAreaElement>("textarea[data-own]")!;
    area.value = "Две строки";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    const shifted = press(area, "Enter", { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(api.personSave).not.toHaveBeenCalled();
    press(area, "Enter");
    await tick();
    expect(api.personSave).toHaveBeenCalledWith(expect.objectContaining({ note: "Две строки" }));
  });

});

describe("the addresses in the card", () => {
  it("makes an address the primary one with P and lets it go with U", async () => {
    await book([olga()]);
    api.personSetPrimary.mockResolvedValue(olga());
    api.personSplit.mockResolvedValue({ person: ivan(), origin: olga(), undo: {} });
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    const second = rowOf(root, "a:o.smirnova@example.com");
    second.focus();
    // P on the primary changes nothing; on the other address it makes it the primary.
    press(rowOf(root, "a:olga@example.org"), "p");
    expect(api.personSetPrimary).not.toHaveBeenCalled();
    const stopped = press(second, "p");
    expect(stopped.defaultPrevented).toBe(true);
    expect(api.personSetPrimary).toHaveBeenCalledWith("o.smirnova@example.com");
    press(second, "u");
    await tick();
    expect(api.personSplit).toHaveBeenCalledWith("o.smirnova@example.com");
  });

  it("answers the Russian layout: з is P, г is U, ф is A", async () => {
    await book([olga()]);
    api.personSetPrimary.mockResolvedValue(olga());
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    const second = rowOf(root, "a:o.smirnova@example.com");
    press(second, "з", { code: "KeyP" });
    expect(api.personSetPrimary).toHaveBeenCalledWith("o.smirnova@example.com");
    press(second, "ф", { code: "KeyA" });
    expect(root.querySelector("input[data-own]")).not.toBeNull();
  });

  it("walks the rows with the arrows", async () => {
    await book([olga()]);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    rowOf(root, "name").focus();
    press(rowOf(root, "name"), "ArrowDown");
    expect(document.activeElement).toBe(rowOf(root, "all"));
    press(rowOf(root, "all"), "ArrowUp");
    expect(document.activeElement).toBe(rowOf(root, "name"));
  });

  it("turns the format and the view with the arrows and Space-Enter, and the hiding with a click", async () => {
    await book([olga()]);
    api.personSave.mockImplementation(async (p) => p);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    press(rowOf(root, "fmt"), "ArrowRight");
    expect(api.personSave).toHaveBeenLastCalledWith(expect.objectContaining({ send_format: "html" }));
    press(rowOf(root, "view"), "ArrowLeft");
    expect(api.personSave).toHaveBeenLastCalledWith(expect.objectContaining({ view: "text" }));
    rowOf(root, "hide").click();
    expect(api.personSave).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: true }));
  });

});

describe("an address that may be another person's", () => {
  it("offers a merge, not a refusal, for an address that is another person's (2.5 Б)", async () => {
    const list = [olga(), ivan()];
    await book(list);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    press(rowOf(root, "name"), "a");
    const input = root.querySelector<HTMLInputElement>("input[data-own]")!;
    input.value = "Ivan@Example.org";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press(input, "Enter");
    await tick();
    expect(api.personAddAddress).not.toHaveBeenCalled();
    const clash = rowOf(root, "clash");
    expect(root.textContent).toContain("уже у «Иван Петров»");
    clash.click();
    expect(peopleOps.dialog?.plan.people.map((p) => p.name).sort()).toEqual(["Иван Петров", "Ольга Смирнова"]);
  });

  it("adds an address that nobody has, and says so for a bad one", async () => {
    await book([olga()]);
    api.personAddAddress.mockResolvedValue({ person: olga(), owner: null });
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    press(rowOf(root, "name"), "a");
    let input = root.querySelector<HTMLInputElement>("input[data-own]")!;
    input.value = "не адрес";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press(input, "Enter");
    await tick();
    expect(root.textContent).toContain("Это не похоже на адрес");
    expect(api.personAddAddress).not.toHaveBeenCalled();
    press(rowOf(root, "add"), "a");
    input = root.querySelector<HTMLInputElement>("input[data-own]")!;
    input.value = "maria.o@example.org";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press(input, "Enter");
    await tick();
    expect(api.personAddAddress).toHaveBeenCalledWith("olga@example.org", "maria.o@example.org");
  });

  it("suggests the pair that may be one person, and N remembers they are two", async () => {
    const smirnova = person("Смирнова Ольга", ["o.smirnova@example.net"]);
    await book([olga(), smirnova]);
    const root = show(PersonCard, { email: "o.smirnova@example.net", name: "", onAllMail: () => {}, inBook: true });
    expect(root.textContent).toContain("Возможно, это один человек: Ольга Смирнова");
    press(rowOf(root, "all"), "n");
    await tick();
    expect(api.hintSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "same-person", subject: "o.smirnova@example.net|olga@example.org", decision: "never" }),
    );
    expect(peopleBook.duplicates).toEqual([]);
  });
});

describe("the book of the main window", () => {
  it("lists the people by name, finds one by any of his addresses and filters", async () => {
    await book([olga(), ivan(), person("Бюро", ["booking@example.com"], { hidden: true, manual: true })]);
    const root = show(PeopleView);
    const names = () => [...root.querySelectorAll(".pr .nm")].map((n) => n.textContent);
    expect(names()).toEqual(["Ольга Смирнова", "Иван Петров", "Бюро"]);
    const search = root.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "o.smirnova@";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(names()).toEqual(["Ольга Смирнова"]);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    [...root.querySelectorAll<HTMLButtonElement>(".fchip")].find((b) => b.textContent === "Скрытые")!.click();
    flushSync();
    expect(names()).toEqual(["Бюро"]);
  });

  it("opens at a person and the filter a link asked for", async () => {
    const formatted = person("Иван Петров", ["ivan@example.org"], { send_format: "plain" });
    await book([olga(), formatted]);
    app.peopleFocus = { email: "ivan@example.org", filter: "ruled" };
    const root = show(PeopleView);
    await tick();
    expect([...root.querySelectorAll(".pr .nm")].map((n) => n.textContent)).toEqual(["Иван Петров"]);
    expect(root.querySelector(".pd")?.textContent).toContain("Иван Петров");
    expect(app.peopleFocus).toBeNull();
  });

  it("turns an open book to the place a later request asks for", async () => {
    await book([olga(), person("Иван Петров", ["ivan@example.org"], { send_format: "plain" })]);
    const root = show(PeopleView);
    await tick();
    expect([...root.querySelectorAll(".pr .nm")]).toHaveLength(2);
    app.peopleFocus = { email: "ivan@example.org", filter: "ruled" };
    await tick();
    expect([...root.querySelectorAll(".pr .nm")].map((n) => n.textContent)).toEqual(["Иван Петров"]);
    expect(app.peopleFocus).toBeNull();
  });

});

describe("the keys of the book", () => {
  it("walks with the arrows, marks with Space and joins the marked with M", async () => {
    await book([olga(), ivan(), person("Мария", ["maria@example.org"])]);
    const root = show(PeopleView);
    const list = root.querySelector<HTMLElement>("[role=listbox]")!;
    list.focus();
    press(list, "ArrowDown");
    press(list, " ");
    press(list, "ArrowDown");
    press(list, " ");
    expect(root.querySelectorAll(".pr.flagged")).toHaveLength(2);
    expect(root.textContent).toContain("Отмечено: 2");
    press(list, "m");
    expect(peopleOps.dialog?.plan.people).toHaveLength(2);
  });

  it("shows the suggestion over the list, M joins the pair and N says they are two", async () => {
    await book([olga(), person("Смирнова Ольга", ["o.smirnova@example.net"]), ivan()]);
    const root = show(PeopleView);
    expect(root.querySelector(".banner")?.textContent).toContain("Возможно, это один человек");
    const list = root.querySelector<HTMLElement>("[role=listbox]")!;
    press(list, "m");
    expect(peopleOps.dialog?.plan.people.map((p) => p.name).sort()).toEqual(["Ольга Смирнова", "Смирнова Ольга"]);
    peopleOps.cancel();
    press(list, "n");
    await tick();
    expect(api.hintSave).toHaveBeenCalledWith(expect.objectContaining({ id: "same-person" }));
  });

  it("goes into the card on Enter and back on Esc", async () => {
    await book([olga(), ivan()]);
    const root = show(PeopleView);
    const list = root.querySelector<HTMLElement>("[role=listbox]")!;
    list.focus();
    press(list, "Enter");
    expect(document.activeElement).toBe(rowOf(root, "all"));
    press(rowOf(root, "all"), "Escape");
    expect(document.activeElement).toBe(list);
  });
});

describe("the merge dialog", () => {
  it("offers the defaults of the decisions and Enter takes them", async () => {
    const a = person("Ольга Смирнова", ["olga@example.org"], { send_format: "plain", uses: 31 });
    const b = person("Смирнова Ольга", ["o.smirnova@example.com"], { send_format: "markdown", view: "markdown", hidden: true, uses: 9 });
    await book([a, b]);
    api.personMerge.mockResolvedValue({ person: { ...a, emails: [...a.emails, ...b.emails] }, undo: { persons: [] } });
    peopleOps.merge([b, a]);
    const root = show(MergeDialog);
    expect(root.textContent).toContain("Объединить 2 контакта в один");
    // The format differs: the strictest, plain text, is chosen; the hiding differs: «Hide» wins.
    expect(root.querySelector<HTMLInputElement>('input[name="merge-format"]:checked')?.value).toBe("plain");
    expect(root.querySelector<HTMLInputElement>('input[name="merge-name"]:checked')?.value).toBe("Ольга Смирнова");
    expect(root.querySelector<HTMLInputElement>('input[name="merge-hidden"]:checked')?.value).toBe("true");
    press(document.body, "Enter");
    await vi.waitFor(() => expect(app.lastUndo?.text).toContain("Объединено"));
    expect(api.personMerge).toHaveBeenCalledWith({
      emails: ["olga@example.org", "o.smirnova@example.com"],
      name: "Ольга Смирнова",
      primary: "olga@example.org",
      send_format: "plain",
      view: "markdown",
      hidden: true,
    });
    expect(peopleOps.dialog).toBeNull();
    // The way back is on offer: the toast's button and Z.
    await app.undo();
    expect(api.personRestore).toHaveBeenCalledWith({ persons: [] });
  });

  it("joins nothing on Esc", async () => {
    const a = ivan();
    const b = olga();
    await book([a, b]);
    peopleOps.merge([a, b]);
    show(MergeDialog);
    press(document.body, "Escape");
    expect(peopleOps.dialog).toBeNull();
    expect(api.personMerge).not.toHaveBeenCalled();
  });
});

describe("the letters of a person with two addresses (#104 review)", () => {
  it("are all the letters of both addresses: «Last letters» and the search ask for every address", async () => {
    await book([olga()]);
    api.search.mockResolvedValue([]);
    show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {} });
    await tick();
    expect(api.search).toHaveBeenCalledWith("from:olga@example.org|o.smirnova@example.com");
    expect(peopleBook.allMail("O.Smirnova@example.com")).toBe("from:olga@example.org|o.smirnova@example.com");
    expect(peopleBook.allMail("stranger@example.org")).toBe("from:stranger@example.org");
  });

  it("are read again when an address joins the person", async () => {
    const lone = person("Ольга", ["olga@example.org"]);
    await book([lone]);
    show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {} });
    await tick();
    expect(api.search).toHaveBeenLastCalledWith("from:olga@example.org");
    await book([olga()]);
    await vi.waitFor(() => expect(api.search).toHaveBeenLastCalledWith("from:olga@example.org|o.smirnova@example.com"));
  });
});

describe("the card is neutral and has one «Write»", () => {
  it("names the rules plainly and prints no key", async () => {
    await book([olga()]);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    expect(root.textContent).toContain("Формат писем");
    expect(root.textContent).toContain("Показывать письма");
    expect(root.textContent).not.toContain("Писать ему");
    expect(root.querySelectorAll(".pc-acts button, .pc-foot button")).toHaveLength(2 + 0);
    expect([...root.querySelectorAll("[title], [aria-label]")].map((e) => `${e.getAttribute("title")} ${e.getAttribute("aria-label")}`).join(" ")).not.toMatch(/\((P|U)\)/);
    expect(root.textContent?.match(/Написать/g)).toHaveLength(1);
  });

  it("puts a single space round the dot of the head line", async () => {
    await book([olga()]);
    const root = show(PersonCard, { email: "olga@example.org", name: "", onAllMail: () => {}, inBook: true });
    expect(root.querySelector(".nt")?.textContent).toBe("olga@example.org · 6 писем");
  });
});

describe("removing a person added by hand", () => {
  const manual = () => person("Вручную", ["mine@example.org", "heard@example.org"], { manual: true });

  it("says the person stays when an address is in the letters, and offers to take it back", async () => {
    await book([manual()]);
    api.personForget.mockResolvedValue({ removed: false, unmarked: true, undo: { persons: [] } });
    const asked: { title?: string; text: string }[] = [];
    const choose = vi.spyOn(app, "choose").mockImplementation(async (q) => (asked.push(q), { answer: true } as never));
    const root = show(PersonCard, { email: "mine@example.org", name: "", onAllMail: () => {}, inBook: true });
    rowOf(root, "delete").click();
    await vi.waitFor(() => expect(app.lastUndo?.text).toContain("снята пометка"));
    expect(asked[0].text).toContain("останется в книге");
    await app.undo();
    expect(api.personRestore).toHaveBeenCalledWith({ persons: [] });
    choose.mockRestore();
  });

  it("asks by the backend's mark, not by the count of letters (#121, 3)", async () => {
    // The address is in the correspondence though no letter is counted: the backend only unmarks the person, and the question says so.
    const quiet = person("Вручную", ["mine@example.org"], { manual: true, uses: 0, emails: [{ email: "mine@example.org", primary: true, uses: 0, name: "" }] });
    await book([quiet]);
    api.personForget.mockResolvedValue({ removed: false, unmarked: true, undo: { persons: [] } });
    const asked: { text: string }[] = [];
    const choose = vi.spyOn(app, "choose").mockImplementation(async (q) => (asked.push(q), { answer: true } as never));
    const root = show(PersonCard, { email: "mine@example.org", name: "", onAllMail: () => {}, inBook: true });
    rowOf(root, "delete").click();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0].text).toContain("останется в книге");
    choose.mockRestore();
  });

  it("says everything goes when no address is in the letters", async () => {
    const lone = person("Вручную", ["mine@example.org"], { manual: true, heard: false, emails: [{ email: "mine@example.org", primary: true, uses: 0, name: "" }] });
    await book([lone]);
    api.personForget.mockResolvedValue({ removed: true, unmarked: false, undo: { persons: [] } });
    const asked: { text: string }[] = [];
    const choose = vi.spyOn(app, "choose").mockImplementation(async (q) => (asked.push(q), { answer: true } as never));
    const root = show(PersonCard, { email: "mine@example.org", name: "", onAllMail: () => {}, inBook: true });
    rowOf(root, "delete").click();
    await vi.waitFor(() => expect(app.lastUndo?.text).toContain("Удалено"));
    expect(asked[0].text).toContain("будут удалены");
    choose.mockRestore();
  });
});

describe("the list after a merge", () => {
  it("gets the focus back once the merge is done", async () => {
    const a = person("Ольга Смирнова", ["olga@example.org"]);
    const b = person("Смирнова Ольга", ["o.smirnova@example.net"]);
    await book([a, b]);
    api.personMerge.mockResolvedValue({ person: a, undo: {} });
    const root = show(PeopleView);
    const list = root.querySelector<HTMLElement>("[role=listbox]")!;
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    peopleOps.merge([a, b]);
    await peopleOps.confirm();
    await vi.waitFor(() => expect(document.activeElement).toBe(list));
  });

  it("says what went wrong when the follow-up of the caller throws, instead of dropping it silently (#121, 4)", async () => {
    const a = person("Ольга Смирнова", ["olga@example.org"]);
    const b = person("Смирнова Ольга", ["o.smirnova@example.net"]);
    await book([a, b]);
    api.personMerge.mockResolvedValue({ person: a, undo: {} });
    const fail = vi.spyOn(app, "fail").mockImplementation(() => {});
    const boom = new Error("после слияния");
    peopleOps.merge([a, b], () => {
      throw boom;
    });
    await peopleOps.confirm();
    expect(fail).toHaveBeenCalledWith(boom);
    fail.mockRestore();
  });

  it("does not offer a pair when the other person is filtered out", async () => {
    const a = person("Ольга Смирнова", ["olga@example.org"], { send_format: "plain" });
    const b = person("Смирнова Ольга", ["o.smirnova@example.net"]);
    await book([a, b]);
    const root = show(PeopleView);
    expect(root.querySelector(".banner")).not.toBeNull();
    [...root.querySelectorAll<HTMLButtonElement>(".fchip")].find((c) => c.textContent === "С особым форматом")!.click();
    flushSync();
    expect(root.querySelector(".banner")).toBeNull();
  });
});

describe("the book on the channel", () => {
  it("puts the focus into its search for the search command, and takes the subscription back with it", async () => {
    await book([olga()]);
    app.list.view = { kind: "people" };
    const root = show(PeopleView);
    await tick();
    expect(bus.count("people.search")).toBe(1);
    app.focusSearch();
    expect(document.activeElement).toBe(root.querySelector("input[type=search]"));
    app.list.view = { kind: "unified", role: "inbox" };
    unmount(view!);
    view = null;
    expect(bus.count("people.search")).toBe(0);
    expect(bus.count("people.merge-ended")).toBe(0);
  });

  it("gives the list the focus back when a merge ends", async () => {
    await book([olga(), ivan()]);
    const root = show(PeopleView);
    await tick();
    (document.activeElement as HTMLElement | null)?.blur();
    bus.emit("people.merge-ended");
    expect(document.activeElement).toBe(root.querySelector("[aria-multiselectable]"));
  });

  it("does not let a second book take the commands from the first", async () => {
    await book([olga()]);
    const first = show(PeopleView);
    const one = view!;
    const second = show(PeopleView);
    await tick();
    expect(bus.count("people.search")).toBe(2);
    unmount(view!);
    view = one;
    // The first still hears the command after the second went away.
    bus.emit("people.search");
    expect(document.activeElement).toBe(first.querySelector("input[type=search]"));
    expect(second).not.toBe(first);
  });
});
