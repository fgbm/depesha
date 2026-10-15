// @vitest-environment jsdom
// A composition window answers the quit's "keep every draft" through the channel (#71, #139).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { readFileSync } from "node:fs";
import { flushSync, mount, tick, unmount } from "svelte";
import Compose from "./Compose.svelte";
import { app } from "../lib/store.svelte";
import { bus } from "../lib/bus";
import { peopleBook } from "../lib/peopleBook.svelte";
import { emptyDraft } from "../lib/compose";
import { i18n } from "../lib/i18n.svelte";
import { api, settings } from "../lib/testing";

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
// jsdom has no layout observers; the window watches its size and its editor.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  i18n.lang = "ru";
  for (const m of Object.values(api)) m.mockReset();
  api.draftSave.mockResolvedValue({ id: 7, message_id: "<m@x>" });
  app.settingsCtl.settings = settings();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the composition window on the channel", () => {
  it("keeps its draft when the quit asks every window, and answers no more once closed", async () => {
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    draft.subject = "Не потерять";
    const id = app.compose.open({ account_id: "a", draft, draft_id: null, unsaved: true });
    const win = app.compose.windows.find((w) => w.id === id)!;
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(Compose, { target, props: { c: win } });
    flushSync();
    await tick();
    expect(bus.count("compose.save-all")).toBe(1);

    await app.compose.saveAll(1000);
    expect(api.draftSave).toHaveBeenCalledTimes(1);
    expect(api.draftSave.mock.calls[0][1]).toMatchObject({ subject: "Не потерять" });

    unmount(view);
    view = null;
    expect(bus.count("compose.save-all")).toBe(0);
  });
});

const QUOTE = "Иван писал(а):\n> Пришлите акт сверки.";

beforeEach(() => {
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  peopleBook.list = [];
});

const SIGNED = "\n\n-- \nКэрол, отдел ИТ";

function open(reply: boolean, signed = false) {
  const draft = emptyDraft({ name: "Me", email: "me@example.com" });
  draft.to = [{ name: "Иван", email: "ivan@example.com" }];
  draft.subject = "Re: Акт";
  draft.text = `${signed ? SIGNED : ""}${reply ? `\n\n${QUOTE}` : ""}`;
  const id = app.compose.open({ account_id: "a", draft, draft_id: null, unsaved: true });
  const win = app.compose.windows.find((w) => w.id === id)!;
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(Compose, { target, props: { c: win } });
  flushSync();
  return { win, target };
}

const dots = (t: HTMLElement) => t.querySelector<HTMLButtonElement>("button.dots");
const sig = (t: HTMLElement) => t.querySelector<HTMLElement>(".sig-plain");
const quote = (t: HTMLElement) => t.querySelector<HTMLTextAreaElement>("textarea.quote-text");
const labels = (t: HTMLElement) => [...t.querySelectorAll(".fields .label")].map((l) => l.textContent);
const links = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>(".fields .lnk")];
const focused = () => document.activeElement?.closest(".row")?.querySelector(".label")?.textContent;
const altKey = (t: HTMLElement, k: string) => {
  t.querySelector(".compose")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, altKey: true, bubbles: true, cancelable: true }));
  flushSync();
};


describe("the quote of a reply", () => {
  it("folds the quote of a reply behind the dots, which open it by click, Alt+Q and as a button", async () => {
    const { target } = open(true);
    expect(dots(target)).not.toBeNull();
    expect(dots(target)!.textContent?.trim()).toBe("•••");
    expect(dots(target)!.getAttribute("aria-expanded")).toBe("false");
    expect(quote(target)).toBeNull();
    dots(target)!.click();
    flushSync();
    expect(quote(target)?.value).toContain("> Пришлите акт сверки.");
    expect(dots(target)!.getAttribute("aria-expanded")).toBe("true");
    dots(target)!.click();
    flushSync();
    expect(quote(target)).toBeNull();
    altKey(target, "q");
    expect(quote(target)).not.toBeNull();
    altKey(target, "q");
    expect(quote(target)).toBeNull();
    expect(dots(target)!.tagName).toBe("BUTTON");
  });

  it("draws no dots in a new letter", () => {
    const { target } = open(false);
    expect(dots(target)).toBeNull();
    expect(target.querySelector(".quote-chip")).toBeNull();
  });

});

describe("the fields of the letter", () => {
  it("opens Cc and Bcc by the words and by the keys, and the caret goes into the new field", async () => {
    const { target } = open(false);
    expect(links(target).map((b) => b.textContent?.trim())).toEqual(["Копия", "Скрытая копия"]);
    links(target)[0].click();
    await tick();
    expect(labels(target)).toEqual(["Кому:", "Копия:", "Тема:"]);
    await vi.waitFor(() => expect(focused()).toBe("Копия:"));
    altKey(target, "b");
    await tick();
    expect(labels(target)).toEqual(["Кому:", "Копия:", "Скрытая копия:", "Тема:"]);
    await vi.waitFor(() => expect(focused()).toBe("Скрытая копия:"));
    expect(links(target)).toHaveLength(0);
  });

  it("names the fields in full", () => {
    const { target } = open(false);
    expect(labels(target)).toEqual(["Кому:", "Тема:"]);
  });

  it("puts every label in one column and every value in the next, so the values start on one vertical", async () => {
    const { target } = open(false);
    links(target)[0].click();
    await tick();
    links(target)[0].click();
    await tick();
    const rows = [...target.querySelectorAll<HTMLElement>(".fields > .field-row")];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.firstElementChild?.classList.contains("field-label")).toBe(true);
      expect(row.children[1].classList.contains("field-value")).toBe(true);
    }
    expect(target.querySelectorAll(".fields .field-label")).toHaveLength(4);
    expect(target.querySelector(".fields")!.classList.contains("field-grid")).toBe(true);
  });

  it("keeps Cc and Bcc on the line of the first row of the To field", () => {
    const { target } = open(false);
    const first = links(target)[0];
    expect(first.closest(".field-row")).toBe(target.querySelector(".fields > .field-row"));
    expect(first.parentElement!.classList.contains("field-trailing")).toBe(true);
  });

});

describe("the text area of a letter with dots", () => {
  it("is as tall as its text: the dots follow it at once, and it has no least height of its own", () => {
    const { target } = open(false, true);
    const area = target.querySelector<HTMLElement>(".body-area")!;
    const field = area.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field.rows).toBe(1);
    expect(field.style.minHeight).toBe("");
    // jsdom draws no layout, so the rules of the area are read as written: no least height of the field or the editor under the dots.
    const css = readFileSync("src/components/Compose.svelte", "utf8");
    for (const rule of css.matchAll(/(\.body-area\.signed[^{,]*(?:textarea|md-editor)[^{,]*)\{([^}]*)\}/g)) expect(rule[2], rule[1]).not.toContain("min-height");
    expect(field.nextElementSibling).toBe(dots(target)!.parentElement);
    expect(field.nextElementSibling!.classList.contains("dots-line")).toBe(true);
  });

  it("puts the caret at the end of the text by a click on the empty place below it", () => {
    const { win, target } = open(false, true);
    win.draft.text = `Первая строка.${SIGNED}`;
    flushSync();
    const field = target.querySelector<HTMLTextAreaElement>(".body-area textarea")!;
    expect(field.value).toBe("Первая строка.");
    field.blur();
    field.setSelectionRange(0, 0);
    target.querySelector<HTMLElement>(".body-area")!.click();
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it("does not take the click on the dots for the empty place", () => {
    const { target } = open(false, true);
    (document.activeElement as HTMLElement | null)?.blur();
    dots(target)!.click();
    flushSync();
    expect(document.activeElement).not.toBe(target.querySelector(".body-area textarea"));
  });
});

describe("the letter with a folded quote", () => {
  it("sends the quote with the letter when it is folded", async () => {
    const send = vi.spyOn(app.compose, "send").mockResolvedValue(undefined as never);
    const { win, target } = open(true);
    expect(quote(target)).toBeNull();
    win.draft.text = `Ответ.\n\n${QUOTE}`;
    target.querySelector<HTMLButtonElement>("footer .btn.primary")!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1].text).toContain("> Пришлите акт сверки.");
    send.mockRestore();
  });
});

describe("the dots under the text of the letter", () => {
  it("stand inside the body area and fold the signature and the quote together", () => {
    const { target } = open(true, true);
    expect(dots(target)!.closest(".body-area")).not.toBeNull();
    expect(sig(target)).toBeNull();
    expect(quote(target)).toBeNull();
    dots(target)!.click();
    flushSync();
    expect(sig(target)?.textContent).toContain("Кэрол, отдел ИТ");
    expect(quote(target)?.value).toContain("> Пришлите акт сверки.");
    altKey(target, "q");
    expect(sig(target)).toBeNull();
    expect(quote(target)).toBeNull();
  });

  it("fold the signature of a new letter, and are not there without a signature and a quote", () => {
    const { target } = open(false, true);
    expect(dots(target)!.closest(".body-area")).not.toBeNull();
    expect(sig(target)).toBeNull();
    altKey(target, "q");
    expect(sig(target)).not.toBeNull();
    expect(quote(target)).toBeNull();
    unmount(view!);
    view = null;
    document.body.innerHTML = "";
    expect(dots(open(false).target)).toBeNull();
  });

  it("send the folded signature with the letter", async () => {
    const send = vi.spyOn(app.compose, "send").mockResolvedValue(undefined as never);
    const { win, target } = open(false, true);
    expect(sig(target)).toBeNull();
    win.draft.text = `Ответ.${SIGNED}`;
    target.querySelector<HTMLButtonElement>("footer .btn.primary")!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1].text).toContain("Кэрол, отдел ИТ");
    send.mockRestore();
  });
});
