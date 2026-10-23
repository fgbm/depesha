// @vitest-environment jsdom
// The question before an action on many letters (#196): the focus starts on «Отмена», Esc cancels,
// and Enter agrees even though the focus is not on the button that agrees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import Confirm from "./Confirm.svelte";
import { i18n } from "../lib/i18n.svelte";
import type { Confirmation } from "../lib/store.svelte";

let view: ReturnType<typeof mount> | null = null;

/** The question of a bulk action: its words, its two buttons, and where the focus goes. */
function ask(over: Partial<Confirmation> = {}) {
  const resolve = vi.fn();
  const q: Confirmation = {
    title: "Удалить 21 письмо?",
    text: "Действие можно отменить клавишей z или кнопкой в уведомлении.",
    okLabel: "Удалить",
    danger: true,
    enterConfirms: true,
    resolve,
    ...over,
  };
  view = mount(Confirm, { target: document.body, props: { q } });
  flushSync();
  return resolve;
}

const key = (name: string, init: KeyboardEventInit = {}) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  flushSync();
};

const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "";

beforeEach(() => {
  i18n.lang = "ru";
});

afterEach(() => {
  i18n.lang = "en";
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the question before an action on many letters (#196)", () => {
  it("starts the focus on Cancel, not on the button that agrees", () => {
    ask();
    expect(focused()).toBe("Отмена");
  });

  it("cancels on Esc", () => {
    const resolve = ask();
    key("Escape");
    expect(resolve).toHaveBeenCalledWith(null);
  });

  it("agrees on Enter, though the focus is on Cancel", () => {
    const resolve = ask();
    key("Enter");
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it("leaves Enter to the buttons of the dialogs that do not say it agrees", () => {
    const resolve = ask({ enterConfirms: false });
    key("Enter");
    expect(resolve).not.toHaveBeenCalled();
  });
});
