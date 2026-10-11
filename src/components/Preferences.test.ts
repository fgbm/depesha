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
import { bus } from "../lib/bus";
import { api, settings } from "../lib/testing";
import { useStyles } from "../lib/cssTesting";
import { registry } from "../plugin-host/registry.svelte";
import type { PluginContext } from "../plugin-api";
import type { Account, AccountView } from "../lib/types";

// jsdom has no CSS.escape; the window uses it to find a row by its id.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function open(page: string, accounts: AccountView[] = []) {
  app.settingsCtl.settings = settings();
  app.mailboxes.accounts = accounts;
  app.ui.settingsPage = page;
  app.ui.settingsOpen = true;
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

describe("the settings window on the channel", () => {
  it("turns an open window to the page openSettings asks for, and stops listening when it goes", async () => {
    open("reading");
    expect(heading()).not.toBe("Хранение");
    app.ui.openSettings("storage");
    await vi.waitFor(() => expect(heading()).toBe("Хранение"));
    expect(bus.count("settings.open")).toBe(1);
    unmount(view!);
    view = null;
    expect(bus.count("settings.open")).toBe(0);
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

  it("leaves the key to a plugin's group, which is not the page's", async () => {
    open("reading");
    row("threads").querySelector<HTMLElement>(".sw")!.click();
    await vi.waitFor(() => expect(api.settingsPatch).toHaveBeenCalledTimes(1));
    const group = document.createElement("section");
    group.dataset.g = "plugin";
    group.innerHTML = "<button>plugin</button>";
    target.querySelector(".content")!.append(group);
    expect(key(group.querySelector("button")!, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(api.settingsPatch).toHaveBeenCalledTimes(1);
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

describe("Ctrl+Z on a mailbox's page (#102)", () => {
  it("takes the colour back from the radio button the pick left the focus on", async () => {
    let stored = { id: "a", label: "", color: "", display_name: "Jane", email: "j@x.test", username: "j", imap: { host: "i", port: 993, security: "tls" }, smtp: { host: "s", port: 465, security: "tls" }, save_sent_copy: true } as unknown as Account;
    api.accounts.mockImplementation(async () => [{ ...stored, status: null } as AccountView]);
    api.accountPatchOwn.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      stored = { ...stored, ...patch } as Account;
      return stored;
    });
    open("account:a", [{ ...stored, status: null } as AccountView]);
    await vi.waitFor(() => expect(target.querySelector(".account-page")).not.toBeNull());
    const swatch = target.querySelectorAll<HTMLInputElement>(".colors input[type=radio]")[1];
    swatch.focus();
    swatch.click();
    await vi.waitFor(() => expect(stored.color).not.toBe(""));
    expect(key(swatch, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(stored.color).toBe(""));
  });
});

describe("the people moved to the main window (#104)", () => {
  it("has no page «People» in the menu", () => {
    open("reading");
    const tabs = [...target.querySelectorAll<HTMLElement>(".tab[data-page]")].map((t) => t.dataset.page);
    expect(tabs).not.toContain("people");
    expect(tabs).toContain("accounts");
  });

  it("opens the book, narrowed to the people with a format of their own, from the way on the format's row", async () => {
    const book = vi.spyOn(app, "openPeople").mockResolvedValue();
    open("writing");
    row("layer_format").querySelector<HTMLElement>(".lnk")!.click();
    await vi.waitFor(() => expect(book).toHaveBeenCalledWith({ email: undefined, filter: "ruled" }));
    book.mockRestore();
  });

  it("opens the book on a hit of the search on a field of the card", async () => {
    const book = vi.spyOn(app, "openPeople").mockResolvedValue();
    open("reading");
    const field = target.querySelector<HTMLInputElement>("input[type=search]")!;
    field.value = "формат писем";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const hit = [...target.querySelectorAll<HTMLElement>(".hit")].find((h) => h.textContent?.includes("Контакты"))!;
    hit.click();
    await vi.waitFor(() => expect(book).toHaveBeenCalled());
    book.mockRestore();
  });

});

const shut = () => target.querySelector<HTMLElement>(".shut")!;
const backdrop = () => target.querySelector<HTMLElement>(".modal-backdrop")!;
const press = (el: Element) => {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  flushSync();
};
/** A value typed into a field of the page and not yet left. */
const typeValue = () => {
  const field = row("large_mb").querySelector("input")!;
  field.focus();
  field.value = "300";
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("the way out (#165)", () => {
  it("has a cross with a name and the key in the hint, and it closes the window", async () => {
    open("reading");
    expect(shut().getAttribute("aria-label")).toBe("Закрыть");
    expect(shut().title).toContain("Esc");
    shut().click();
    await vi.waitFor(() => expect(app.ui.settingsOpen).toBe(false));
  });

  it("closes on a press on the dimmed ground, not inside the window", async () => {
    open("reading");
    press(target.querySelector(".prefs h2")!);
    press(target.querySelector(".prefs")!);
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
    press(backdrop());
    await vi.waitFor(() => expect(app.ui.settingsOpen).toBe(false));
  });

});

describe("the way out keeps what is typed (#165)", () => {
  it("saves a value that is being typed before the cross closes the window", async () => {
    open("storage");
    typeValue();
    shut().click();
    await vi.waitFor(() => expect(app.ui.settingsOpen).toBe(false));
    expect(api.settingsPatch).toHaveBeenCalledWith({ large_mb: 300 });
  });

  it("saves a value that is being typed before a press on the ground closes the window", async () => {
    open("storage");
    typeValue();
    press(backdrop());
    await vi.waitFor(() => expect(app.ui.settingsOpen).toBe(false));
    expect(api.settingsPatch).toHaveBeenCalledWith({ large_mb: 300 });
  });

});

describe("the way out yields to what is on top (#165)", () => {
  it("leaves a menu on top alone: a press on the ground does not close the window", async () => {
    open("reading");
    const menu = document.createElement("div");
    menu.className = "pop";
    document.body.append(menu);
    press(backdrop());
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
    menu.remove();
    press(backdrop());
    await vi.waitFor(() => expect(app.ui.settingsOpen).toBe(false));
  });

  it("leaves a question on top alone: a press on the ground does not close the window", async () => {
    open("reading");
    app.ui.confirmation = { text: "?" } as never;
    press(backdrop());
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
    app.ui.confirmation = null;
  });
});

describe("the way out waits for the page's own say, like Esc (#165)", () => {
  const hold = () => {
    let answer: ((ok: boolean) => void) | null = null;
    app.ui.settingsLeave = () => new Promise<boolean>((r) => (answer = r));
    return async (ok: boolean) => {
      await vi.waitFor(() => expect(answer).not.toBeNull());
      answer!(ok);
    };
  };
  afterEach(() => (app.ui.settingsLeave = null));

  it("the cross", async () => {
    open("reading");
    const answer = hold();
    shut().click();
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
    await answer(false);
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
  });

  it("the press on the ground", async () => {
    open("reading");
    const answer = hold();
    press(backdrop());
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
    await answer(false);
    await tick();
    expect(app.ui.settingsOpen).toBe(true);
  });
});

describe("the window as it is drawn (#165)", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./Preferences.svelte")));
  afterEach(() => unstyle());

  it("marks the open page of the menu by the ground, with no bar", () => {
    open("reading");
    const tab = target.querySelector<HTMLElement>(".tab[aria-selected='true']")!;
    expect(getComputedStyle(tab).background).toBe("var(--selected)");
    expect(getComputedStyle(tab).boxShadow).toBe("");
  });

  it("has no footer under any page, so the window gives its height to the page", () => {
    for (const page of ["reading", "storage", "keys"]) {
      open(page);
      expect(target.querySelector(".prefs footer")).toBeNull();
      unmount(view!);
      view = null;
      target.remove();
    }
  });
});

// A component is a function of the anchor and the props: this one draws its text before the anchor.
const group = (text: string) => ((anchor: Comment) => void anchor.before(document.createTextNode(text))) as never;
const put = (owner: string, title: string, page?: string, text = title + " body") =>
  registry.add("settingsSections", owner, { title: () => title, component: group(text), props: { ctx: {} as PluginContext }, ...(page ? { page } : {}) } as never);

/** The groups of the three plugins, two of them naming a page of the old kind; taken away after each test. */
function pluginGroups() {
  beforeEach(() => {
    // jsdom has no scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
    put("followups", "Напоминания", "later");
    put("templates", "Шаблоны ответов", "writing");
    put("thirdparty", "Сторонний");
  });

  afterEach(() => {
    for (const o of ["followups", "templates", "thirdparty"]) registry.removeOwner(o);
  });
}

describe("the plugins' groups stand on the plugins' page (0.8.2)", () => {
  pluginGroups();

  it("shows them on the plugins' page, those that name a page too", () => {
    open("plugins");
    const text = target.querySelector(".content")!.textContent;
    expect(text).toContain("Напоминания body");
    expect(text).toContain("Шаблоны ответов body");
    expect(text).toContain("Сторонний body");
  });

  it("does not show them on «Snooze and waiting» or «Writing»", () => {
    for (const page of ["later", "writing"]) {
      open(page);
      const text = target.querySelector(".content")!.textContent;
      expect(text).not.toContain("Напоминания body");
      expect(text).not.toContain("Шаблоны ответов body");
      unmount(view!);
      view = null;
      document.body.innerHTML = "";
    }
  });

  it("drops a group when its plugin is switched off", () => {
    open("plugins");
    expect(target.querySelector("section[data-plugin='templates']")).not.toBeNull();
    registry.removeOwner("templates");
    flushSync();
    expect(target.querySelector("section[data-plugin='templates']")).toBeNull();
    expect(target.querySelector(".content")!.textContent).not.toContain("Шаблоны ответов body");
    expect(target.querySelector("section[data-plugin='followups']")).not.toBeNull();
  });
});

describe("the search over the plugins' groups (0.8.2)", () => {
  pluginGroups();

  it("finds a plugin's group in the search and opens the plugins' page", async () => {
    open("reading");
    const field = target.querySelector<HTMLInputElement>("input[type=search]")!;
    field.value = "напоминания";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const hit = [...target.querySelectorAll<HTMLElement>(".hit")].find((h) => h.textContent?.includes("Напоминания"))!;
    hit.click();
    await vi.waitFor(() => expect(heading()).toBe("Все плагины"));
    expect(target.querySelector(".content")!.textContent).toContain("Напоминания body");
  });

  it("scrolls to the group the hit names and lights it", async () => {
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    open("reading");
    const field = target.querySelector<HTMLInputElement>("input[type=search]")!;
    field.value = "напоминания";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    [...target.querySelectorAll<HTMLElement>(".hit")].find((h) => h.textContent?.includes("Напоминания"))!.click();
    const grp = () => target.querySelector<HTMLElement>("section[data-plugin='followups']")!;
    await vi.waitFor(() => expect(scroll.mock.contexts).toContain(grp()));
    await vi.waitFor(() => expect(grp().classList.contains("flash")).toBe(true));
    expect(target.querySelector("section[data-plugin='templates']")!.classList.contains("flash")).toBe(false);
  });

  it("sets the group and the plugin tag apart in a hit by a spaced dot", () => {
    open("reading");
    const field = target.querySelector<HTMLInputElement>("input[type=search]")!;
    field.value = "напоминания";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const hit = [...target.querySelectorAll<HTMLElement>(".hit")].find((h) => h.textContent?.includes("Напоминания"))!;
    expect(hit.querySelector(".grp")!.textContent!.replace(/\s/g, " ")).toBe("Все плагины · плагин");
  });
});
