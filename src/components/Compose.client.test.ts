// @vitest-environment jsdom
// A composition window answers the quit's "keep every draft" through the channel (#71, #139).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

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

function open(reply: boolean) {
  const draft = emptyDraft({ name: "Me", email: "me@example.com" });
  draft.to = [{ name: "Иван", email: "ivan@example.com" }];
  draft.subject = "Re: Акт";
  draft.text = reply ? `\n\n${QUOTE}` : "";
  const id = app.compose.open({ account_id: "a", draft, draft_id: null, unsaved: true });
  const win = app.compose.windows.find((w) => w.id === id)!;
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(Compose, { target, props: { c: win } });
  flushSync();
  return { win, target };
}

const dots = (t: HTMLElement) => t.querySelector<HTMLButtonElement>("button.dots");
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
    expect(labels(target)).toEqual(["К:", "Копия:", "Тема:"]);
    await vi.waitFor(() => expect(focused()).toBe("Копия:"));
    altKey(target, "b");
    await tick();
    expect(labels(target)).toEqual(["К:", "Копия:", "Скрытая:", "Тема:"]);
    await vi.waitFor(() => expect(focused()).toBe("Скрытая:"));
    expect(links(target)).toHaveLength(0);
  });

  it("names the fields in short", () => {
    const { target } = open(false);
    expect(labels(target)).toEqual(["К:", "Тема:"]);
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
