// @vitest-environment jsdom
// The one action panel over the list and the letter (0.8.3, #176): the search on the left,
// over the list column, the actions to its right, one row. An empty strip when nothing is
// open (1.3 Б), the letter's set with every label (1.6 Б, 1.8 Б), the set for several chosen
// rows with the count (1.4 Б), and the search slot sized by the list column (1.2 Б).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import UnifiedBar from "./UnifiedBar.svelte";
import { app } from "../lib/store.svelte";
import { layout } from "../lib/layout.svelte";
import { i18n } from "../lib/i18n.svelte";
import { shortcuts } from "../lib/shortcuts.svelte";
import { api, flush, opened, resetFakes, row, rows, settings } from "../lib/testing";
import type { KeySettings } from "../lib/types";

let view: ReturnType<typeof mount> | null = null;

function mountBar(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  const search = createRawSnippet(() => ({ render: () => "<input class='probe' />" }));
  view = mount(UnifiedBar, { target, props: { search } });
  flushSync();
  return target;
}

const labels = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>(".actions .lbl")].map((e) => e.textContent!.trim());
const buttons = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>(".actions button")].map((b) => b.textContent!.replace(/\s+/g, " ").trim());

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  shortcuts.use(() => ({ custom: {}, dismissed: [] }) as KeySettings);
  app.settingsCtl.settings = settings();
  layout.width = 1440;
  layout.list = 380;
  app.reader.opened = null;
  app.selection.selected = new Set();
  app.list.messages = [];
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the panel without a letter", () => {
  it("is an empty strip: the search, and no buttons at all (1.3 Б)", () => {
    const t = mountBar();
    expect(t.querySelector(".probe")).not.toBeNull();
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
    expect(labels(t)).toEqual(expect.arrayContaining(["Готово", "Удалить", "Ещё"]));
  });

  it("puts «Ещё» at the right edge, after a spacer (1.8 Б)", () => {
    const t = mountBar();
    const acts = t.querySelector(".actions")!;
    expect(acts.querySelector(".sp")).not.toBeNull();
    expect(acts.lastElementChild!.classList.contains("anchor")).toBe(true);
    expect(acts.lastElementChild!.textContent).toContain("Ещё");
  });

  it("archives the open letter from the «Готово» button", async () => {
    const t = mountBar();
    [...t.querySelectorAll<HTMLButtonElement>(".actions button")].find((b) => b.textContent!.includes("Готово"))!.click();
    flushSync();
    await flush();
    expect(api.archive).toHaveBeenCalled();
  });
});

describe("the panel with several chosen rows", () => {
  beforeEach(() => {
    app.list.messages = rows(1, 3);
    app.selection.selected = new Set([1, 2, 3]);
  });

  it("switches to the set for many, every button with its label (1.4 Б, 1.6 Б)", () => {
    const t = mountBar();
    const text = buttons(t).join(" | ");
    expect(text).toContain("Готово");
    expect(text).toContain("Прочитано");
    expect(text).toContain("Не прочитано");
    expect(text).toContain("Флаг");
    expect(text).toContain("Удалить");
  });
});

describe("the search slot", () => {
  it("is the list column less its 12 px on each side, and follows the separator (1.2 Б)", () => {
    const t = mountBar();
    const slot = t.querySelector(".slot")!;
    expect(slot.getAttribute("style")).toContain(`width: ${380 - 24}px`);
    layout.list = 600;
    flushSync();
    expect(slot.getAttribute("style")).toContain(`width: ${600 - 24}px`);
  });
});
