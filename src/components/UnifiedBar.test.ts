// @vitest-environment jsdom
// The action panel over the list and the letter (0.8.3, #176): the letter's set or the set for
// several chosen rows, and no buttons at all when nothing is open (1.3 Б). The buttons stand
// only for the letter actually on screen, so the one leaving the pane never shows its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import UnifiedBar from "./UnifiedBar.svelte";
import { app } from "../lib/store.svelte";
import { layout } from "../lib/layout.svelte";
import { i18n } from "../lib/i18n.svelte";
import { shortcuts } from "../lib/shortcuts.svelte";
import { opened, resetFakes, row, rows, settings } from "../lib/testing";
import type { KeySettings } from "../lib/types";

// jsdom has no layout; the row's own fitting is tried in the letter's actions' test.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

let view: ReturnType<typeof mount> | null = null;

function mountBar(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(UnifiedBar, { target });
  flushSync();
  return target;
}

const buttons = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>(".actions button")].map((b) => b.textContent!.replace(/\s+/g, " ").trim());

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  shortcuts.use(() => ({ custom: {}, dismissed: [] }) as KeySettings);
  app.settingsCtl.settings = settings();
  layout.width = 1440;
  layout.list = 380;
  app.reader.opened = null;
  app.reader.opening = false;
  app.reader.openingRow = null;
  app.selection.selected = new Set();
  app.list.messages = [];
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the panel without a letter", () => {
  it("is an empty strip: no buttons at all (1.3 Б)", () => {
    const t = mountBar();
    expect(t.querySelectorAll(".actions button").length).toBe(0);
  });
});

describe("the panel with one open letter", () => {
  beforeEach(() => {
    app.reader.opened = opened(row(1));
    app.selection.selected = new Set([1]);
  });

  it("shows the letter's actions, every button with its label (1.6 Б)", () => {
    const t = mountBar();
    expect(buttons(t)).toEqual(expect.arrayContaining(["Готово", "Удалить", "Ещё"]));
  });

  it("shows no buttons while another letter is being opened (the previous one's must not linger)", () => {
    app.reader.opening = true;
    app.reader.openingRow = row(2);
    const t = mountBar();
    expect(t.querySelectorAll(".actions button").length).toBe(0);
  });

  it("keeps the buttons while the same letter is loaded again", () => {
    app.reader.opening = true;
    app.reader.openingRow = row(1);
    const t = mountBar();
    expect(buttons(t)).toEqual(expect.arrayContaining(["Готово", "Удалить"]));
  });
});

describe("the panel with several chosen rows", () => {
  beforeEach(() => {
    app.list.messages = rows(1, 3);
    app.selection.selected = new Set([1, 2, 3]);
  });

  it("switches to the set for many, every button with its label (1.4 Б)", () => {
    const t = mountBar();
    const text = buttons(t).join(" | ");
    expect(text).toContain("Готово");
    expect(text).toContain("Прочитано");
    expect(text).toContain("Не прочитано");
    expect(text).toContain("Флаг");
    expect(text).toContain("Удалить");
  });

  it("offers «Выбрать все найденные» in a search that has more rows than are chosen", () => {
    app.list.view = { kind: "search", text: "x" };
    app.list.messages = rows(1, 5);
    const t = mountBar();
    expect(buttons(t).join(" | ")).toContain("Выбрать все найденные (5)");
  });
});

describe("the panel as a control", () => {
  it("is a labelled group, not a toolbar role: no arrow-key navigation is added", () => {
    const t = mountBar();
    const actions = t.querySelector(".actions")!;
    expect(actions.getAttribute("aria-label")).toBe("Действия");
    expect(actions.getAttribute("role")).toBeNull();
  });

  it("is part of the window's drag region, like the reader's own toolbar", () => {
    app.reader.opened = opened(row(1));
    app.selection.selected = new Set([1]);
    const t = mountBar();
    expect(t.querySelector(".actions")!.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(t.querySelector(".actions [data-tauri-drag-region]")).not.toBeNull();
  });
});
