// @vitest-environment jsdom
// Windows that only inform close with the cross and Esc, with no «Close» button in a footer (#170).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import Tasks from "./Tasks.svelte";
import Wizard from "./Wizard.svelte";
import FolderProps from "./prefs/FolderProps.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import Preferences from "./Preferences.svelte";
import { labels } from "../lib/labels.svelte";
import { windowOpen } from "../lib/overlay";
import { api, resetFakes, settings } from "../lib/testing";
import type { AccountView, FolderInfo } from "../lib/types";

let views: ReturnType<typeof mount>[] = [];

const account = { id: "a", display_name: "Jane", email: "jane@example.com", status: null } as AccountView;
const folder = { name: "INBOX", display_name: "Входящие", total: 3, unread: 1 } as FolderInfo;

function show(component: typeof Tasks | typeof Wizard | typeof FolderProps | typeof Preferences, props: object = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  views.push(mount(component as typeof Tasks, { target, props: props as Record<string, never> }));
  flushSync();
  return target;
}

const cross = (root: ParentNode) => root.querySelector<HTMLButtonElement>("button[aria-label='Закрыть'][title='Закрыть (Esc)']")!;

const esc = (init: KeyboardEventInit = {}) => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }));
  flushSync();
};

beforeEach(() => {
  resetFakes();
  // The fakes stub a bare window; the cards listen on the real one.
  vi.unstubAllGlobals();
  i18n.lang = "ru";
  api.syncOverview.mockResolvedValue([]);
  api.oauthProviders.mockResolvedValue([]);
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  api.language.mockResolvedValue("ru");
  api.backgroundStatus.mockResolvedValue({ tray: "present" });
  app.settingsCtl.settings = settings();
  app.ui.tasksOpen = true;
  app.ui.settingsOpen = false;
  app.ui.confirmation = null;
});

afterEach(async () => {
  for (const v of views) await unmount(v);
  views = [];
  document.body.innerHTML = "";
});

describe("the background tasks window", () => {
  it("has the cross and no footer button, and the cross closes it", () => {
    const root = show(Tasks);
    expect(root.querySelector("footer")).toBeNull();
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Закрыть")).toBe(false);
    cross(root).click();
    expect(app.ui.tasksOpen).toBe(false);
  });

  it("Esc closes it, unless a question is on top", () => {
    show(Tasks);
    app.ui.confirmation = {} as never;
    esc();
    expect(app.ui.tasksOpen).toBe(true);
    app.ui.confirmation = null;
    esc();
    expect(app.ui.tasksOpen).toBe(false);
  });

  it("a press on the dimmed ground closes it, a press inside does not", () => {
    const root = show(Tasks);
    root.querySelector(".modal")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(app.ui.tasksOpen).toBe(true);
    root.querySelector(".modal-backdrop")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(app.ui.tasksOpen).toBe(false);
  });
});

describe("the new mailbox form", () => {
  it("Esc is the cross once there is a mailbox to go back to", async () => {
    app.mailboxes.accounts = [account];
    app.ui.wizard = { account: null } as never;
    show(Wizard);
    esc();
    await vi.waitFor(() => expect(app.ui.wizard).toBeNull());
  });

  it("Esc does nothing on the first start, when there is nowhere to go back to", () => {
    app.mailboxes.accounts = [];
    app.ui.wizard = { account: null } as never;
    show(Wizard);
    esc();
    expect(app.ui.wizard).not.toBeNull();
  });
});

describe("the folder card", () => {
  it("the cross and Esc close it", () => {
    const onclose = vi.fn();
    const root = show(FolderProps, { at: { x: 10, y: 10 }, account, folder, onclose });
    cross(root).click();
    expect(onclose).toHaveBeenCalledTimes(1);
    esc();
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});

const input = (root: ParentNode, css: string, value: string) => {
  const el = root.querySelector<HTMLInputElement>(css)!;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

describe("the way out of the new mailbox form", () => {
  beforeEach(() => {
    app.mailboxes.accounts = [account];
    app.ui.wizard = { account: null } as never;
  });

  it("Esc and the cross ask before a typed password is lost, and the window stays", async () => {
    const root = show(Wizard);
    input(root, "input[type=password]", "secret");
    esc();
    await vi.waitFor(() => expect(app.ui.confirmation).not.toBeNull());
    expect(app.ui.wizard).not.toBeNull();
    app.ui.confirmation?.resolve?.(false);
  });

  it("Esc with nothing typed closes it, the cross too", async () => {
    const root = show(Wizard);
    cross(root).click();
    await vi.waitFor(() => expect(app.ui.wizard).toBeNull());
  });

  it("Esc on the second step goes back to the first, not out", async () => {
    api.detect.mockResolvedValue({ username: "", imap: null, smtp: null, source: "guess", notes: [] } as never);
    const root = show(Wizard);
    input(root, "input[type=email]", "jane@example.com");
    input(root, "input[type=password]", "secret");
    root.querySelector<HTMLButtonElement>("footer .btn.primary")!.click();
    await vi.waitFor(() => expect(root.querySelector(".imap, [data-step=settings]") ?? root.textContent?.includes("Проверить и сохранить")).toBeTruthy());
    esc();
    expect(app.ui.wizard).not.toBeNull();
    expect(root.textContent).not.toContain("Проверить и сохранить");
    expect(app.ui.confirmation).toBeNull();
  });

  it("the cross has a name and Esc under input method composition is left alone", async () => {
    const root = show(Wizard);
    expect(cross(root).getAttribute("aria-label")).toBe("Закрыть");
    esc({ isComposing: true });
    await Promise.resolve();
    expect(app.ui.wizard).not.toBeNull();
  });
});

describe("Esc over other windows", () => {
  it("«Tasks» over the settings: Esc closes only the tasks", async () => {
    app.ui.settingsOpen = true;
    show(Preferences);
    show(Tasks);
    esc();
    await vi.waitFor(() => expect(app.ui.tasksOpen).toBe(false));
    expect(app.ui.settingsOpen).toBe(true);
  });

  it("Esc leaves «Tasks» alone while a menu is open over it, and under composition", () => {
    show(Tasks);
    const pop = document.createElement("div");
    pop.className = "pop";
    document.body.append(pop);
    esc();
    expect(app.ui.tasksOpen).toBe(true);
    pop.remove();
    esc({ isComposing: true });
    expect(app.ui.tasksOpen).toBe(true);
  });

  it("the card of a folder keeps the main window's keys: an open card counts as an open window", () => {
    app.ui.settingsOpen = false;
    app.ui.tasksOpen = false;
    labels.card = null;
    expect(windowOpen()).toBe(false);
    labels.card = { accountId: "a", folder: "INBOX" };
    expect(windowOpen()).toBe(true);
    labels.card = null;
  });

  it("Esc takes back the explainer of the labels check first, the card next", () => {
    const onclose = vi.fn();
    const root = show(FolderProps, { at: { x: 10, y: 10 }, account, folder, onclose });
    root.querySelector<HTMLButtonElement>(".hint .link")?.click();
    flushSync();
    expect(root.ownerDocument.querySelector(".cdlg")).not.toBeNull();
    esc();
    expect(root.ownerDocument.querySelector(".cdlg")).toBeNull();
    expect(onclose).not.toHaveBeenCalled();
    esc();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe("the focus goes back to what opened the window", () => {
  for (const [name, make] of [
    ["the tasks", () => show(Tasks)],
    ["the new mailbox form", () => { app.mailboxes.accounts = [account]; app.ui.wizard = { account: null } as never; return show(Wizard); }],
    ["the card of a folder", () => show(FolderProps, { at: { x: 1, y: 1 }, account, folder, onclose: () => {} })],
  ] as const) {
    it(name, async () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      const inside = make().querySelector<HTMLElement>("button, input")!;
      inside.focus();
      expect(document.activeElement).not.toBe(opener);
      await unmount(views.pop()!);
      expect(document.activeElement).toBe(opener);
    });
  }
});
