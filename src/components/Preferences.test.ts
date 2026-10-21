// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {}, lightOf: () => "light" }));

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
/** Types a query into the search over the settings. */
const find = (q: string) => {
  const field = target.querySelector<HTMLInputElement>(".psearch input")!;
  field.value = q;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};
/** A found row that leads elsewhere: its label and its link. */
const hitRow = (label: string) => [...target.querySelectorAll<HTMLElement>(".content .rw")].find((r) => r.querySelector(".t")?.textContent?.includes(label))!;


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
    await vi.waitFor(() => expect(heading()).toBe("Чтение"));
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
    open("notify");
    const rows = [...target.querySelectorAll<HTMLElement>(".content .rw[data-row]")];
    const last = rows.at(-1)!;
    last.setAttribute("tabindex", "0");
    last.focus();
    const e = key(last, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(target.querySelector(".tab[data-page='notify']"));
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
    const people = vi.spyOn(app, "openPeople").mockResolvedValue();
    open("reading");
    find("формат писем");
    const book = [...target.querySelectorAll<HTMLElement>(".content section")].find((g) => g.querySelector("h4")?.textContent === "Контакты")!;
    book.querySelector<HTMLElement>(".rw .lnk")!.click();
    await vi.waitFor(() => expect(people).toHaveBeenCalled());
    people.mockRestore();
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

describe("the plugins' groups stand on the plugin's own page (0.8.12, 6.1 Б)", () => {
  pluginGroups();

  it("shows a plugin's groups on its page, not on the list of the plugins", () => {
    open("plugins");
    expect(target.querySelector(".content")!.textContent).not.toContain("Напоминания body");
    unmount(view!);
    open("plugin:followups");
    expect(heading()).not.toBe("");
    const text = target.querySelector(".content")!.textContent;
    expect(text).toContain("Напоминания body");
    expect(text).not.toContain("Шаблоны ответов body");
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

  it("drops the plugin from the menu when it is switched off", () => {
    open("plugins");
    expect(target.querySelector(".tab[data-page='plugin:templates']")).not.toBeNull();
    registry.removeOwner("templates");
    flushSync();
    expect(target.querySelector(".tab[data-page='plugin:templates']")).toBeNull();
    expect(target.querySelector(".tab[data-page='plugin:followups']")).not.toBeNull();
  });
});

describe("the search over the plugins' groups (0.8.2)", () => {
  pluginGroups();

  it("finds a plugin's group, and its link opens the plugin's page at the group, lit", async () => {
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    open("reading");
    find("напоминания");
    hitRow("Напоминания").querySelector<HTMLElement>(".lnk")!.click();
    const grp = () => target.querySelector<HTMLElement>("section[data-plugin='followups']")!;
    await vi.waitFor(() => expect(grp()).not.toBeNull());
    expect(target.querySelector(".content")!.textContent).toContain("Напоминания body");
    await vi.waitFor(() => expect(scroll.mock.contexts).toContain(grp()));
    await vi.waitFor(() => expect(grp().classList.contains("flash")).toBe(true));
  });
});

const mailbox = (id: string, label: string, email: string, color: string) =>
  ({ id, label, email, color, display_name: "Анна", username: email, imap: { host: "i", port: 993, security: "tls" }, smtp: { host: "s", port: 465, security: "tls" }, save_sent_copy: true, status: null }) as unknown as AccountView;
const mailboxes = [mailbox("a", "Работа", "anna@example.org", "#3f7fca"), mailbox("b", "Личный", "anna.k@mail.example", "")];
const tabs = () => [...target.querySelectorAll<HTMLElement>(".pages .tab[data-page]")].map((t) => t.dataset.page);
const tab = (page: string) => target.querySelector<HTMLElement>(`.pages .tab[data-page='${page}']`)!;

describe("the mailboxes and the plugins under their entries in the menu (0.8.12, screen 7)", () => {
  pluginGroups();
  beforeEach(() => api.accounts.mockResolvedValue(mailboxes));

  it("shows every mailbox, a dot of its colour and its name, while «Mailboxes» or one of them is open (6.2 А)", () => {
    open("reading", mailboxes);
    expect(tabs().filter((p) => p!.startsWith("account:"))).toEqual([]);
    unmount(view!);
    open("accounts", mailboxes);
    expect(tabs().filter((p) => p!.startsWith("account:"))).toEqual(["account:a", "account:b"]);
    expect(tab("account:a").textContent).toContain("Работа");
    expect(tab("account:a").querySelector(".kdot")).not.toBeNull();
  });

  it("marks the open mailbox by the ground of the choice alone", () => {
    open("account:a", mailboxes);
    expect(tab("account:a").getAttribute("aria-selected")).toBe("true");
    expect(tab("accounts").getAttribute("aria-selected")).toBe("false");
  });

  it("shows only the plugins that have settings of their own (6.1 Б)", () => {
    open("plugins", mailboxes);
    expect(tabs().filter((p) => p!.startsWith("plugin:"))).toEqual(["plugin:followups", "plugin:templates", "plugin:thirdparty"]);
    expect(tabs()).not.toContain("plugin:snooze");
  });
});

describe("the keys of the menu (0.8.12, the table of screen 7)", () => {
  beforeEach(() => api.accounts.mockResolvedValue(mailboxes));
  const focused = () => (document.activeElement as HTMLElement | null)?.dataset?.page;

  it("walks the entries and the open sub-entries with ↑/↓, the page opening at once", async () => {
    open("keys", mailboxes);
    tab("keys").focus();
    key(tab("keys"), "ArrowDown");
    await vi.waitFor(() => expect(focused()).toBe("accounts"));
    expect(heading()).toBe("Ящики");
    key(tab("accounts"), "ArrowDown");
    await vi.waitFor(() => expect(focused()).toBe("account:a"));
    expect(heading()).toBe("Работа");
  });

  it("folds the entry with ← on a sub-entry and goes back to it; → unfolds it, → again goes into the page", async () => {
    open("account:b", mailboxes);
    tab("account:b").focus();
    key(tab("account:b"), "ArrowLeft");
    await vi.waitFor(() => expect(focused()).toBe("accounts"));
    expect(tabs()).not.toContain("account:a");
    key(tab("accounts"), "ArrowRight");
    expect(tabs()).toContain("account:a");
    expect(focused()).toBe("accounts");
    key(tab("accounts"), "ArrowRight");
    await vi.waitFor(() => expect(target.querySelector(".content")!.contains(document.activeElement)).toBe(true));
  });

  it("folds an open entry with ←", async () => {
    open("accounts", mailboxes);
    tab("accounts").focus();
    key(tab("accounts"), "ArrowLeft");
    expect(tabs()).not.toContain("account:a");
  });

  it("turns through the sub-entries of an open entry with Ctrl+PgDn", async () => {
    open("accounts", mailboxes);
    key(target.querySelector(".prefs")!, "PageDown", { ctrlKey: true });
    await vi.waitFor(() => expect(heading()).toBe("Работа"));
  });

  it("goes into the page with Enter, and back to the sub-entry with Alt+←", async () => {
    open("account:a", mailboxes);
    tab("account:a").focus();
    key(tab("account:a"), "Enter");
    await vi.waitFor(() => expect(target.querySelector(".content")!.contains(document.activeElement)).toBe(true));
    key(document.activeElement!, "ArrowLeft", { altKey: true });
    expect(focused()).toBe("account:a");
  });
});

describe("the search shows the rows found, alive (0.8.12, 4.1 Б, 4.2 А, 4.3 А)", () => {
  beforeEach(() => {
    api.accounts.mockResolvedValue(mailboxes);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("puts the cursor in the search when the window opens", async () => {
    open("reading");
    await vi.waitFor(() => expect(document.activeElement).toBe(target.querySelector(".psearch input")));
  });

  it("draws a found row as it is on its page, and its value is changed in place", async () => {
    open("storage");
    find("цепочки");
    const found = row("threads");
    expect(found).not.toBeNull();
    found.querySelector<HTMLElement>(".sw")!.click();
    await vi.waitFor(() => expect(api.settingsPatch).toHaveBeenCalledWith(expect.objectContaining({ threads: expect.any(Boolean) })));
    expect(heading()).toBe("Найти настройку");
  });

  it("walks from the search to the first row found with ↓ and changes it with the arrows", async () => {
    open("reading");
    find("формат новых");
    key(target.querySelector(".psearch input")!, "ArrowDown");
    expect(document.activeElement).toBe(row("compose_format"));
    key(row("compose_format"), "ArrowRight");
    await vi.waitFor(() => expect(api.settingsPatch).toHaveBeenCalledWith(expect.objectContaining({ compose_format: expect.any(String) })));
  });

  it("finds a field of a mailbox's page, and its link opens the page at the field", async () => {
    open("reading", mailboxes);
    find("подпис");
    const hit = hitRow("Подписи");
    expect(hit.closest("section")!.querySelector("h4")!.textContent).toBe("Работа");
    hit.querySelector<HTMLElement>(".lnk")!.click();
    await vi.waitFor(() => expect(target.querySelector(".account-page [data-settings='acc-signatures']")).not.toBeNull());
    expect(heading()).toBe("Работа");
  });

  it("finds a command of «Keys», and its link opens «Keys» at the command", async () => {
    open("reading", mailboxes);
    find("архив");
    hitRow("Готово: убрать в архив").querySelector<HTMLElement>(".lnk")!.click();
    await vi.waitFor(() => expect(heading()).toBe("Клавиши"));
    await vi.waitFor(() => expect(target.querySelector(".kr[data-command='core.archive']")).not.toBeNull());
  });
});
