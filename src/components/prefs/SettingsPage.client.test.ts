// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import SettingsPage from "./SettingsPage.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { PAGES } from "../../lib/settingsCatalog";
import { SettingsAutosave } from "../../lib/settingsAutosave.svelte";
import { api, settings } from "../../lib/testing";
import type { AccountView } from "../../lib/types";

/** The page drawn in a real DOM, with a store that keeps what is written, as the app's does. */
function setup(id: string, over: object = {}, accounts: AccountView[] = []) {
  app.settings = { ...settings(), ...over };
  app.accounts = accounts;
  const patches: Record<string, unknown>[] = [];
  const auto = new SettingsAutosave({
    settings: () => JSON.parse(JSON.stringify(app.settings)) as Record<string, unknown>,
    patch: async (patch) => {
      patches.push(patch);
      app.settings = { ...app.settings, ...patch };
    },
    toast: () => 0,
    dismiss: () => {},
  });
  const target = document.createElement("div");
  document.body.append(target);
  const spec = PAGES.find((p) => p.id === id)!;
  const went: string[] = [];
  const view = mount(SettingsPage, { target, props: { page: spec, auto, sections: [], go: (p: string) => void went.push(p) } });
  flushSync();
  const row = (rowId: string) => target.querySelector<HTMLElement>(`.rw[data-row="${rowId}"]`)!;
  return { target, patches, auto, row, went, destroy: () => unmount(view) };
}

const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  flushSync();
  return e;
};

const acc = (id: string, label: string) =>
  ({ id, label, display_name: label, email: `${id}@example.com`, username: id, imap: { host: "h", port: 993, security: "tls" }, smtp: { host: "h", port: 465, security: "tls" }, save_sent_copy: true, status: null }) as unknown as AccountView;

// jsdom has no CSS.escape; the page uses it to find a row by its id.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

let page: ReturnType<typeof setup> | null = null;

beforeEach(() => {
  i18n.lang = "ru";
  api.people.mockResolvedValue([]);
});

afterEach(() => {
  page?.destroy();
  page = null;
  document.body.innerHTML = "";
});

describe("Tab inside an open row (#102)", () => {
  it("goes from the first field of the thresholds to the second, and back with Shift", async () => {
    page = setup("storage");
    const fields = page.row("quota_levels").querySelectorAll("input");
    expect(fields).toHaveLength(2);
    fields[0].focus();
    const e = key(fields[0], "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fields[1]);
    key(fields[1], "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(fields[0]);
  });

  it("goes from the number of the large letter to its unit", async () => {
    page = setup("storage");
    const field = page.row("large_mb").querySelector("input")!;
    const unit = page.row("large_mb").querySelector<HTMLElement>(".trigger")!;
    field.focus();
    key(field, "Tab");
    expect(document.activeElement).toBe(unit);
  });

  it("leaves the keys alone at the end of the row, and on the row itself", async () => {
    page = setup("storage");
    const fields = page.row("quota_levels").querySelectorAll("input");
    expect(key(fields[1], "Tab").defaultPrevented).toBe(false);
    expect(key(page.row("quota_levels"), "Tab").defaultPrevented).toBe(false);
  });

  it("saves the second threshold on Enter", async () => {
    page = setup("storage", { quota_levels: [80, 95] });
    const second = page.row("quota_levels").querySelectorAll("input")[1];
    second.focus();
    second.value = "98";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    key(second, "Enter");
    await vi.waitFor(() => expect(page!.patches).toEqual([{ quota_levels: [80, 98] }]));
  });
});

describe("two mailboxes of one name (#102)", () => {
  it("both stand in the menu of the link", async () => {
    page = setup("later", {}, [acc("a", "Работа"), acc("b", "Работа")]);
    page.row("waiting").querySelector<HTMLElement>(".lnk")!.click();
    await tick();
    expect(document.querySelectorAll(".pop .mi")).toHaveLength(2);
  });
});

describe("the weekdays (#102, 4.2)", () => {
  it("take the cursor on the first press of Enter and switch the day only on the second", async () => {
    page = setup("later", { work_days: [1, 2, 3, 4, 5] });
    const row = page.row("work_days");
    row.focus();
    key(row, "Enter");
    expect(page.patches).toEqual([]);
    expect(row.querySelector(".day.cur")?.textContent).toMatch(/Пн/);
    key(row, "Enter");
    await vi.waitFor(() => expect(page!.patches).toEqual([{ work_days: [2, 3, 4, 5] }]));
  });

  it("do the same for the Space key", async () => {
    page = setup("later", { work_days: [1, 2, 3, 4, 5] });
    const row = page.row("work_days");
    row.focus();
    key(row, " ");
    expect(page.patches).toEqual([]);
    expect(row.querySelector(".day.cur")).not.toBeNull();
  });
});

describe("arrows after a click (#102, 4.1)", () => {
  it("walk the rows from the switch the click left the focus on", async () => {
    page = setup("reading");
    const sw = page.row("threads").querySelector<HTMLElement>(".sw")!;
    sw.focus();
    const e = key(sw, "ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.row).toBe("list_avatars");
  });

  it("leave the arrows of a field to the field", async () => {
    page = setup("storage");
    const field = page.row("large_mb").querySelector("input")!;
    field.focus();
    key(field, "ArrowDown");
    expect(document.activeElement).toBe(field);
  });
});

describe("a refused value (#102)", () => {
  it("is cleared when the saved value changes from elsewhere", async () => {
    page = setup("storage", { large_mb: 100 });
    const field = page.row("large_mb").querySelector("input")!;
    field.focus();
    field.value = "abc";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    key(field, "Enter");
    await vi.waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
    app.settings = { ...app.settings, large_mb: 200 };
    await vi.waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("false"));
    expect(page.row("large_mb").textContent).not.toContain("Нужно число");
  });
});

describe("the background with no tray icon (#102)", () => {
  it("is not agreed to by choosing it: the row asks, and the consent is the answer", async () => {
    api.backgroundStatus.mockResolvedValue({ tray: "absent" });
    page = setup("start", { close_action: "ask" });
    await vi.waitFor(() => expect(page!.row("close_action")).not.toBeNull());
    page.row("close_action").querySelector<HTMLElement>("[role=radio]:nth-child(1)")?.click();
    app.settings = { ...app.settings, close_action: "background" };
    await vi.waitFor(() => expect(page!.row("tray_consent")).not.toBeNull());
    expect(page.patches).toEqual([]);
    const ask = page.row("tray_consent");
    expect(ask.textContent).toContain("Значка в трее нет");
    ask.focus();
    key(ask, "Enter");
    await vi.waitFor(() => expect(page!.patches).toEqual([{ background_without_tray: true }]));
    await vi.waitFor(() => expect(page!.row("tray_consent")).toBeNull());
    await vi.waitFor(() => expect((document.activeElement as HTMLElement).dataset.row).toBe("close_action"));
  });

  it("asks nothing where there is a tray icon, or the background is not chosen", async () => {
    api.backgroundStatus.mockResolvedValue({ tray: "present" });
    page = setup("start", { close_action: "background" });
    await tick();
    expect(page.row("tray_consent")).toBeNull();
  });
});

describe("the way to the format of individual people (#102)", () => {
  it("is on the page though nobody has a format of their own yet, and leads to the people", async () => {
    page = setup("writing");
    const way = page.row("layer_format");
    expect(way.textContent).toContain("Задать для отдельных контактов");
    way.querySelector<HTMLElement>(".lnk")!.click();
    expect(page.went).toEqual(["people"]);
  });
});

describe("the notes the page keeps (#102)", () => {
  it("say how the warnings repeat, where the folder of attachments is, and that updates are signed", () => {
    page = setup("storage");
    expect(page.row("quota_repeat").textContent).toContain("Одно предупреждение на порог");
    page.destroy();
    page = setup("writing");
    expect(page.row("attachments_dir").textContent).toContain("Пусто — спрашивать каждый раз");
    page.destroy();
    page = setup("start");
    expect(page.row("updates").textContent).toContain("подписано ключом проекта");
  });
});
