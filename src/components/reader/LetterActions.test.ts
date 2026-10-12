// @vitest-environment jsdom
// The letter's own buttons and their menu (0.8.3, #176): one copy for the action panel above
// the list and for the toolbar of a narrow window or a letter opened in a window of its own.
// The panel's row never wraps: on a narrower panel the labels go and the icons stay (decision
// 1.9 В), nothing leaves for «Ещё» by width, and the labels come back as the row grows again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import LetterActions from "./LetterActions.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { shortcuts } from "../../lib/shortcuts.svelte";
import { opened, resetFakes, row, settings } from "../../lib/testing";
import { registry } from "../../plugin-host/registry.svelte";
import type { KeySettings } from "../../lib/types";

// jsdom has no layout: a ResizeObserver a test can fire by hand, and widths it can set.
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

function mountActions(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(LetterActions, { target, props: { msg: opened(row(1)), account: undefined, isDraft: false, message: null } });
  flushSync();
  return target;
}

const WIDE = 100; // a button with its label
const ICON = 40; // the same button with the label out of the flow
const LABEL = 54; // 40 + 6 + 54 = 100

/**
 * A realistic row: the browser gives `scrollWidth >= clientWidth`, and every button is as wide
 * as the DOM says — with its label in the flow, or icon-only with the label taken out of it.
 */
function resize(t: HTMLElement, avail: number) {
  const rowEl = t.querySelector(".row")!;
  const icons = rowEl.classList.contains("icons");
  const kids = [...rowEl.children].filter((c) => !c.classList.contains("sp"));
  const content = kids.length * WIDE + (kids.length - 1) * 4;
  Object.defineProperty(rowEl, "clientWidth", { value: avail, configurable: true });
  Object.defineProperty(rowEl, "scrollWidth", { value: Math.max(avail, content), configurable: true });
  for (const kid of kids) Object.defineProperty(kid, "offsetWidth", { value: icons ? ICON : WIDE, configurable: true });
  for (const label of rowEl.querySelectorAll(".lbl, .lbl2")) Object.defineProperty(label, "offsetWidth", { value: LABEL, configurable: true });
  FakeRO.last!.fire();
  flushSync();
}

const menuText = () => document.querySelector(".pop")?.textContent?.replace(/\s+/g, " ") ?? "";
const icons = (t: HTMLElement) => t.querySelector(".row")!.classList.contains("icons");

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  shortcuts.use(() => ({ custom: {}, dismissed: [] }) as KeySettings);
  app.settingsCtl.settings = settings();
});

afterEach(() => {
  registry.removeOwner("probe");
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the letter's buttons in one row (decision 1.9 В)", () => {
  it("keeps the labels while the row has room for them", async () => {
    const t = mountActions();
    await tick();
    resize(t, 400);
    expect(icons(t)).toBe(false);
  });

  it("hides the labels and keeps the icons when the row has no room", async () => {
    const t = mountActions();
    await tick();
    resize(t, 200);
    expect(icons(t)).toBe(true);
    // The label stays in the row (out of the flow) so its width can be measured, and the icons stay.
    expect(t.querySelector(".lbl")).not.toBeNull();
    expect(t.querySelector('[data-key="delete"]')).not.toBeNull();
  });

  it("brings the labels back when the row grows again — the spacer does not count as room", async () => {
    const t = mountActions();
    await tick();
    resize(t, 200);
    expect(icons(t)).toBe(true);
    resize(t, 400);
    expect(icons(t)).toBe(false);
  });

  it("does not flicker on the boundary", async () => {
    const t = mountActions();
    await tick();
    resize(t, 308); // exactly what the row needs with its labels
    expect(icons(t)).toBe(false);
    resize(t, 308);
    expect(icons(t)).toBe(false);
    resize(t, 300);
    expect(icons(t)).toBe(true);
    resize(t, 300);
    expect(icons(t)).toBe(true);
  });
});

describe("the letter's menu", () => {
  it("stands a plugin's menu item in «Ещё» — the same copy the message window's toolbar uses", async () => {
    registry.add("messageActions", "probe", { id: "probe.act", title: () => "Прибрать", run: () => {} });
    const t = mountActions();
    await tick();
    t.querySelector<HTMLButtonElement>('button[aria-label="Ещё"]')!.click();
    flushSync();
    expect(menuText()).toContain("Прибрать");
  });

  it("is part of the window's drag region, like the reader's own toolbar", () => {
    const t = mountActions();
    expect(t.querySelector(".row")!.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(t.querySelector(".row [data-tauri-drag-region]")).not.toBeNull();
  });
});

describe("the toolbar's own look (the reader of a narrow window)", () => {
  it("keeps «Готово» with its .lbl2 and «Удалить» and «Ещё» as icons alone", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(LetterActions, { target, props: { msg: opened(row(1)), account: undefined, isDraft: false, message: null, compact: true } });
    flushSync();
    await tick();
    expect(target.querySelector(".lbl2")).not.toBeNull();
    expect(target.querySelector("button[aria-label='Удалить'] .lbl")).toBeNull();
    expect(target.querySelector("button[aria-label='Ещё'] .lbl")).toBeNull();
    // No row fitting and no spacer: the toolbar keeps its own separator.
    expect(target.querySelector(".sp")).toBeNull();
  });
});
