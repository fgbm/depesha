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
import { api, resetFakes, settings } from "../lib/testing";
import type { AccountView, FolderInfo } from "../lib/types";

let view: ReturnType<typeof mount> | null = null;

const account = { id: "a", display_name: "Jane", email: "jane@example.com", status: null } as AccountView;
const folder = { name: "INBOX", display_name: "Входящие", total: 3, unread: 1 } as FolderInfo;

function show(component: typeof Tasks | typeof Wizard | typeof FolderProps, props: object = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(component as typeof Tasks, { target, props: props as Record<string, never> });
  flushSync();
  return target;
}

const esc = () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  flushSync();
};

beforeEach(() => {
  resetFakes();
  // The fakes stub a bare window; the cards listen on the real one.
  vi.unstubAllGlobals();
  i18n.lang = "ru";
  api.syncOverview.mockResolvedValue([]);
  api.oauthProviders.mockResolvedValue([]);
  app.settingsCtl.settings = settings();
  app.ui.tasksOpen = true;
  app.ui.settingsOpen = false;
  app.ui.confirmation = null;
});

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the background tasks window", () => {
  it("has the cross and no footer button, and the cross closes it", () => {
    const root = show(Tasks);
    expect(root.querySelector("footer")).toBeNull();
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Закрыть")).toBe(false);
    root.querySelector<HTMLButtonElement>("header button.shut")!.click();
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
  it("Esc is the cross once there is a mailbox to go back to", () => {
    app.mailboxes.accounts = [account];
    app.ui.wizard = { account: null } as never;
    show(Wizard);
    esc();
    expect(app.ui.wizard).toBeNull();
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
    root.querySelector<HTMLButtonElement>(".fcard .x")!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
    esc();
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
