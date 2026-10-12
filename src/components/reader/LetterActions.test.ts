// @vitest-environment jsdom
// The letter's own buttons and their menu (0.8.3, #176): one copy for the action panel above
// the list and for the toolbar of a narrow window or a letter opened in a window of its own.
// The row never wraps: on a narrower panel the labels go and the icons stay (decision 1.9 В),
// nothing leaves for «Ещё» by width.
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

/** Gives the row a width and its content a width (with and without the labels), then fits it again. */
function resize(t: HTMLElement, avail: number, withLabels: number, iconOnly: number) {
  const row = t.querySelector(".row")!;
  Object.defineProperty(row, "clientWidth", { value: avail, configurable: true });
  Object.defineProperty(row, "scrollWidth", { value: row.classList.contains("icons") ? iconOnly : withLabels, configurable: true });
  for (const l of t.querySelectorAll(".lbl")) Object.defineProperty(l, "offsetWidth", { value: 30, configurable: true });
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
    resize(t, 400, 340, 160);
    expect(icons(t)).toBe(false);
  });

  it("hides the labels and keeps the icons when the row has no room", async () => {
    const t = mountActions();
    await tick();
    resize(t, 120, 340, 160);
    expect(icons(t)).toBe(true);
    // The label stays in the row (out of the flow) so its width can be measured, and the icons stay.
    expect(t.querySelector(".lbl")).not.toBeNull();
    expect(t.querySelector('[data-key="delete"]')).not.toBeNull();
  });

  it("brings the labels back when there is room again", async () => {
    const t = mountActions();
    await tick();
    resize(t, 120, 340, 160);
    expect(icons(t)).toBe(true);
    resize(t, 400, 340, 160);
    expect(icons(t)).toBe(false);
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
