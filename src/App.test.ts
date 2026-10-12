// @vitest-environment jsdom
// The main window's shell (#176): the action panel's search stands before the list and the
// panel's buttons after it, so the keyboard goes search → list → buttons; «/» puts the focus
// into that search box.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => new Proxy({}, { get: (_, name: string) => async () => (name.startsWith("on") ? () => {} : false) }),
}));
vi.mock("@tauri-apps/api/app", () => import("./lib/testing").then((m) => m.appModule));
vi.mock("@tauri-apps/api/webview", () => import("./lib/testing").then((m) => m.webviewModule));
vi.mock("./lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("./lib/testing")).api }));

// The list, the reader and the shell's furniture are not what is tried here: a component that
// draws nothing stands for each, and the shell's own markup stays.
vi.mock("./components/Sidebar.svelte", () => ({ default: () => {} }));
vi.mock("./components/MessageList.svelte", () => ({ default: () => {} }));
vi.mock("./components/Reader.svelte", () => ({ default: () => {} }));
vi.mock("./components/Dock.svelte", () => ({ default: () => {} }));
vi.mock("./components/WindowControls.svelte", () => ({ default: () => {} }));
vi.mock("./components/Wizard.svelte", () => ({ default: () => {} }));
vi.mock("./components/Preferences.svelte", () => ({ default: () => {} }));
vi.mock("./components/Tasks.svelte", () => ({ default: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import App from "./App.svelte";
import { app } from "./lib/store.svelte";
import { layout } from "./lib/layout.svelte";
import { i18n } from "./lib/i18n.svelte";
import { shortcuts } from "./lib/shortcuts.svelte";
import { api, flush, settings } from "./lib/testing";
import type { KeySettings } from "./lib/types";

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

let view: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
  i18n.lang = "ru";
  shortcuts.use(() => ({ custom: {}, dismissed: [] }) as KeySettings);
  layout.width = 1280;
  app.settingsCtl.settings = settings();
  app.reader.opened = null;
  app.selection.selected = new Set();
  api.settings.mockResolvedValue(settings());
  api.language.mockResolvedValue("ru");
  api.accounts.mockResolvedValue([]);
  api.folders.mockResolvedValue([]);
  api.outbox.mockResolvedValue([]);
  api.messages.mockResolvedValue([]);
  api.tasks.mockResolvedValue([]);
  api.extensions.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  api.people.mockResolvedValue([]);
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(App, { target });
  flushSync();
  await flush();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the keyboard order of the main window (0.8.3, #176)", () => {
  it("goes search → list → the panel's buttons", () => {
    const search = document.querySelector(".unibar-search");
    const list = document.querySelectorAll(".pane")[0];
    const actions = document.querySelector(".unibar");
    expect(search).not.toBeNull();
    expect(list).not.toBeNull();
    expect(actions).not.toBeNull();
    // The search stands before the list, the panel's buttons after it.
    expect(search!.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list!.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts the focus into the search box of the panel on «/»", async () => {
    // No mailbox is set up here: the first-run wizard would take the key. The shell is what is tried.
    app.ui.wizard = null;
    flushSync();
    expect(document.activeElement).not.toBe(document.querySelector(".unibar-search input"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", code: "Slash", bubbles: true, cancelable: true }));
    await flush();
    expect(document.activeElement).toBe(document.querySelector(".unibar-search input"));
  });
});
