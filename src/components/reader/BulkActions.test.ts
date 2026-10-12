// @vitest-environment jsdom
// The set for several chosen rows (0.8.3, #176): every button keeps a name for the mode without
// labels (decision 1.9 В), the key hint goes with the words, and «В папку» opens its menu under
// its own button, not under the whole row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import BulkActions from "./BulkActions.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { shortcuts } from "../../lib/shortcuts.svelte";
import { rows, resetFakes, settings } from "../../lib/testing";
import { useStyles } from "../../lib/cssTesting";
import type { KeySettings } from "../../lib/types";

class FakeRO {
  static last: FakeRO | null = null;
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeRO.last = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.cb();
  }
}
vi.stubGlobal("ResizeObserver", FakeRO);

let view: ReturnType<typeof mount> | null = null;

function mountBulk(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(BulkActions, { target });
  flushSync();
  return target;
}

/** A row too narrow for the labels: the icons stay, every button keeps its name (1.9 В). */
function forceIcons(t: HTMLElement) {
  const rowEl = t.querySelector(".row")!;
  Object.defineProperty(rowEl, "clientWidth", { value: 50, configurable: true });
  for (const kid of rowEl.children) Object.defineProperty(kid, "offsetWidth", { value: 100, configurable: true });
  FakeRO.last!.fire();
  flushSync();
}

const rect = (top: number, bottom: number, left = 0, right = 600): DOMRect =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  shortcuts.use(() => ({ custom: {}, dismissed: [] }) as KeySettings);
  app.settingsCtl.settings = settings();
  app.list.view = { kind: "search", text: "x" };
  app.list.messages = rows(1, 5);
  app.selection.selected = new Set([1, 2]);
  app.mailboxes.folders = [{ account_id: "a", name: "Archive", display_name: "Архив", role: "archive", selectable: true, hidden: false }] as never;
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the set for several chosen rows", () => {
  it("gives every button a name, so the icons alone still say what they do (1.9 В)", () => {
    const t = mountBulk();
    forceIcons(t);
    expect(t.querySelector(".row")!.classList.contains("icons")).toBe(true);
    const buttons = [...t.querySelectorAll<HTMLButtonElement>(".row button")];
    expect(buttons.length).toBeGreaterThan(3);
    for (const b of buttons) {
      const name = (b.getAttribute("aria-label") ?? "").trim() || (b.getAttribute("title") ?? "").trim();
      expect(name, `кнопка без имени: «${b.textContent?.replace(/\s+/g, " ").trim()}»`).not.toBe("");
    }
  });

  it("hides the key hint of «Выбрать все» together with its words", () => {
    const unstyle = useStyles(import.meta.url, "./BulkActions.svelte");
    const t = mountBulk();
    const kbd = t.querySelector(".row kbd");
    expect(kbd).not.toBeNull();
    expect(getComputedStyle(kbd!).visibility).toBe("visible");
    forceIcons(t);
    expect(getComputedStyle(kbd!).visibility).toBe("hidden");
    unstyle();
  });

  it("opens the folder menu under its own button, not under the whole row", async () => {
    // The stand-in window of the tests has no size; the menu's place is computed from it.
    Object.assign(window, { innerWidth: 1280, innerHeight: 800 });
    const t = mountBulk();
    const rowEl = t.querySelector<HTMLElement>(".row")!;
    const anchor = t.querySelector<HTMLElement>(".anchor")!;
    rowEl.getBoundingClientRect = () => rect(0, 40);
    anchor.getBoundingClientRect = () => rect(100, 130, 200, 300);
    t.querySelector<HTMLButtonElement>('button[aria-label="В папку…"]')!.click();
    flushSync();
    await tick();
    flushSync();
    const pop = document.querySelector<HTMLElement>(".pop");
    expect(pop).not.toBeNull();
    // 130 (the button's bottom) + the 4 px gap; the row's bottom (40) would have given 44.
    expect(pop!.style.top).toBe("134px");
  });
});
