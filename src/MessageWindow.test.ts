// @vitest-environment jsdom
// The window of one letter joins people as the main window does (#104 review): its card opens
// the same dialogs, and the sender's card and the way back from a merge have their keys here too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./lib/testing").then((m) => m.eventModule));
// The window's own controls ask the window many things; every one is answered with nothing, a listener with its off switch.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () =>
    new Proxy({}, { get: (_, name: string) => async () => (name.startsWith("on") ? () => {} : false) }),
}));
vi.mock("@tauri-apps/api/app", () => import("./lib/testing").then((m) => m.appModule));
vi.mock("./lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("./lib/testing")).api }));

// The reader, the dock and the window's buttons are not what is tried here: a component that draws nothing stands for each.
vi.mock("./components/Reader.svelte", () => ({ default: () => {} }));
vi.mock("./components/Dock.svelte", () => ({ default: () => {} }));
vi.mock("./components/WindowControls.svelte", () => ({ default: () => {} }));
vi.mock("@tauri-apps/api/webview", () => import("./lib/testing").then((m) => m.webviewModule));

import { flushSync, mount, unmount } from "svelte";
import MessageWindow from "./MessageWindow.svelte";
import { app } from "./lib/store.svelte";
import { i18n } from "./lib/i18n.svelte";
import { blankPerson } from "./lib/people";
import { peopleOps } from "./lib/peopleOps.svelte";
import { api, flush, opened, row, settings } from "./lib/testing";
import { registry } from "./plugin-host/registry.svelte";
import { extensions } from "./lib/extensions.svelte";
import { allCommands } from "./plugin-host/host.svelte";
import { bus } from "./lib/bus";

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  i18n.lang = "ru";
  app.settingsCtl.settings = settings();
  api.settings.mockResolvedValue(settings());
  api.language.mockResolvedValue("ru");
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(MessageWindow, { target, props: { id: 1 } });
  flushSync();
});

afterEach(() => {
  peopleOps.cancel();
  peopleOps.stopPicking();
  registry.removeOwner("snooze");
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

const people = () => [blankPerson("a@example.org"), blankPerson("b@example.org")].map((p, i) => ({ ...p, id: i + 1, name: i ? "Б" : "А" }));

describe("the window of one letter", () => {
  it("shows the merge dialog and the choice of the second person", async () => {
    peopleOps.merge(people());
    await vi.waitFor(() => expect(document.querySelector(".merge")).not.toBeNull());
    expect(document.querySelector(".merge")).not.toBeNull();
    peopleOps.cancel();
    peopleOps.pick(people()[0]);
    await vi.waitFor(() => expect(document.querySelector(".pick")).not.toBeNull());
  });

  it("opens the sender's card on its key and takes a merge back on Z", async () => {
    const asked = vi.fn();
    const off = bus.on("reader.sender-card", asked);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", bubbles: true, cancelable: true }));
    off();
    expect(asked).toHaveBeenCalledTimes(1);
    const undo = vi.spyOn(app, "undo").mockResolvedValue();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", bubbles: true, cancelable: true }));
    expect(undo).toHaveBeenCalled();
    undo.mockRestore();
  });

  // #125: a plugin's key (Snooze's h, Waiting's w) is found by the same table as in the main window and must run here too.
  it("runs a plugin's key as the main window does, and only while it applies (#125)", () => {
    const run = vi.fn();
    let applies = false;
    registry.add("keybindings", "snooze", { id: "snooze.open", title: () => "Отложить", key: "h", run, when: () => applies });
    const press = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", code: "KeyH", bubbles: true, cancelable: true }));
    press();
    expect(run).not.toHaveBeenCalled();
    applies = true;
    press();
    expect(run).toHaveBeenCalledTimes(1);
  });

  // #125 review: Ctrl+K opens the palette here too, with what a letter's window can do: no list, folders or search.
  it("opens the palette on Ctrl+K with the letter's commands only", async () => {
    app.mailboxes.folders = [];
    app.mailboxes.accounts = [];
    extensions.list = [];
    await flush();
    app.reader.opened = opened(row(1));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".palette")).not.toBeNull());
    const ids = allCommands().map((c) => c.id);
    expect(ids).toContain("core.reply");
    expect(ids.filter((id) => /^core\.(search|go\.|open\.|sort\.|show\.|ready\.|people$|settings|plugins|add-account|empty-folder)/.test(id))).toEqual([]);
    expect(document.querySelector(".palette")?.textContent).toContain("Ответить");
    app.reader.opened = null;
  });
});
