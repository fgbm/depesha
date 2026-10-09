// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import Preferences from "./Preferences.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, settings } from "../lib/testing";

// jsdom has no CSS.escape; the window uses it to find a row by its id.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function open(page: string) {
  app.settings = settings();
  app.accounts = [];
  app.settingsPage = page;
  app.settingsOpen = true;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(Preferences, { target });
  flushSync();
}

const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  flushSync();
  return e;
};

const heading = () => target.querySelector(".pane h2")?.textContent;
const row = (id: string) => target.querySelector<HTMLElement>(`.rw[data-row="${id}"]`)!;

beforeEach(() => {
  i18n.lang = "ru";
  api.people.mockResolvedValue([]);
  api.settingsPatch.mockResolvedValue(undefined);
  api.language.mockResolvedValue("ru");
  api.hints.mockResolvedValue([]);
  api.backgroundStatus.mockResolvedValue({ tray: "present" });
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("the settings window keeps what is typed (#102)", () => {
  it("saves a field that is being typed in before Ctrl+PgDn turns the page", async () => {
    open("storage");
    const field = row("large_mb").querySelector("input")!;
    field.focus();
    field.value = "300";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    key(field, "PageDown", { ctrlKey: true });
    await vi.waitFor(() => expect(heading()).not.toBe("Хранение"));
    expect(api.settingsPatch).toHaveBeenCalledWith({ large_mb: 300 });
  });
});

describe("Ctrl+Z in the settings window (#102)", () => {
  it("takes back the changes of the open page only", async () => {
    open("reading");
    row("threads").querySelector<HTMLElement>(".sw")!.click();
    await vi.waitFor(() => expect(api.settingsPatch).toHaveBeenCalledTimes(1));
    target.querySelector<HTMLElement>(".tab[data-page='storage']")!.click();
    await vi.waitFor(() => expect(heading()).toBe("Хранение"));
    key(row("offline"), "z", { ctrlKey: true });
    await tick();
    expect(api.settingsPatch).toHaveBeenCalledTimes(1);
    target.querySelector<HTMLElement>(".tab[data-page='reading']")!.click();
    await vi.waitFor(() => expect(heading()).toBe("Чтение и список"));
    key(row("threads"), "z", { ctrlKey: true });
    await vi.waitFor(() => expect(api.settingsPatch).toHaveBeenCalledTimes(2));
  });

  it("leaves the key to a text field", async () => {
    open("storage");
    const field = row("large_mb").querySelector("input")!;
    field.focus();
    expect(key(field, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

describe("Tab at the end of a page (#102, 4.1 Б)", () => {
  it("goes to the menu: the foot is a line of text, not a stop", async () => {
    open("start");
    const rows = [...target.querySelectorAll<HTMLElement>(".content .rw[data-row]")];
    const last = rows.at(-1)!;
    last.setAttribute("tabindex", "0");
    last.focus();
    const e = key(last, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(target.querySelector(".tab[data-page='start']"));
  });
});

describe("the search field", () => {
  it("prints no key: keys are not written in the interface", () => {
    open("reading");
    expect(target.querySelector(".psearch kbd")).toBeNull();
    expect(target.querySelector(".psearch")?.textContent).not.toContain("Ctrl");
  });
});
