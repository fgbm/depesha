// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MailFrame from "./MailFrame.svelte";
import { app } from "../lib/store.svelte";
import type { FrameKey } from "../lib/frameRelay";

let view: ReturnType<typeof mount> | null = null;

function frameOf(html = "<p>письмо <a href='https://example.com/x'>ссылка</a></p>", onLink: (href: string) => void = () => {}, props = {}) {
  view = mount(MailFrame, { target: document.body, props: { html, allowRemote: false, onLink, ...props } });
  flushSync();
  return document.querySelector("iframe") as HTMLIFrameElement;
}

/** What the frame's own relay sends (#124): the parent sees it on its window. */
function fromFrame(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow as MessageEventSource }));
}

const key = (extra: Record<string, unknown> = {}) => ({
  depeshaFrame: 1,
  type: "key",
  key: "k",
  code: "KeyK",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...extra,
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the keys and the links of a letter's frame", () => {
  it("replays a key the frame sends on the window, as the iframe element's own", () => {
    const frame = frameOf();
    const heard = vi.fn((e: KeyboardEvent) => e.preventDefault());
    window.addEventListener("keydown", heard);
    try {
      fromFrame(frame, key());
      expect(heard).toHaveBeenCalledOnce();
      const copy = heard.mock.calls[0][0];
      expect(copy.target).toBe(frame);
      expect([copy.key, copy.code, copy.ctrlKey, copy.bubbles, copy.cancelable]).toEqual(["k", "KeyK", true, true, true]);
    } finally {
      window.removeEventListener("keydown", heard);
    }
  });

  it("hands a link of the letter over instead of following it", () => {
    const onLink = vi.fn();
    frameOf(undefined, onLink);
    fromFrame(document.querySelector("iframe") as HTMLIFrameElement, { depeshaFrame: 1, type: "link", href: "https://example.com/x" });
    expect(onLink).toHaveBeenCalledWith("https://example.com/x");
  });

  it("leaves an address without a link, and an anchor of the letter, alone", () => {
    // The relay never sends these; a message is a stranger's word, and the app does not go more
    // on it than it did on the letter's own click (#124).
    const onLink = vi.fn();
    const frame = frameOf(undefined, onLink);
    for (const href of ["", "#part", "#"]) fromFrame(frame, { depeshaFrame: 1, type: "link", href });
    expect(onLink).not.toHaveBeenCalled();
  });

  it("shows the address of the link under the pointer, and clears it", () => {
    const frame = frameOf();
    const status = () => document.querySelector(".status")?.textContent ?? "";
    fromFrame(frame, { depeshaFrame: 1, type: "hover", href: "https://example.com/x" });
    flushSync();
    expect(status()).toBe("https://example.com/x");
    fromFrame(frame, { depeshaFrame: 1, type: "hover", href: "" });
    flushSync();
    expect(status()).toBe("");
  });
});

describe("a message from anywhere but the frame's own window", () => {
  it("is ignored, whatever it asks for", () => {
    const onLink = vi.fn();
    const frame = frameOf(undefined, onLink);
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    try {
      const stranger = { postMessage: () => {} } as unknown as MessageEventSource;
      window.dispatchEvent(new MessageEvent("message", { data: key(), source: stranger }));
      window.dispatchEvent(new MessageEvent("message", { data: { depeshaFrame: 1, type: "link", href: "https://evil.example/" } }));
      window.dispatchEvent(new MessageEvent("message", { data: { depeshaFrame: 1, type: "link", href: 7 }, source: frame.contentWindow as MessageEventSource }));
      window.dispatchEvent(new MessageEvent("message", { data: { depeshaFrame: 1, type: "key", key: "k" }, source: frame.contentWindow as MessageEventSource }));
    } finally {
      window.removeEventListener("keydown", heard);
    }
    expect(heard).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
  });
});

describe("the keys the frame is told about", () => {
  afterEach(() => {
    app.windowOf = null;
  });

  const told = (frame: HTMLIFrameElement): FrameKey[] => {
    const sent = vi.spyOn(frame.contentWindow as Window, "postMessage");
    frame.dispatchEvent(new Event("load"));
    const msg = sent.mock.calls.at(-1)?.[0] as { type: string; keys: FrameKey[] };
    expect(msg.type).toBe("keys");
    return msg.keys;
  };

  it("are the main window's: print, select all, the menu of a row", () => {
    const keys = told(frameOf());
    expect(keys).toContainEqual({ code: "KeyP", mod: true, alt: false, shift: false });
    expect(keys).toContainEqual({ code: "KeyA", mod: true, alt: false, shift: false });
    expect(keys).toContainEqual({ key: "ContextMenu", mod: false, alt: false, shift: false });
  });

  it("leave the letter text to «Select all» in its own window, which has no rows", () => {
    // The window of a letter runs no core.select-all (App.svelte): there Ctrl+A selects the
    // text of the letter, so the frame must not stop it (#124).
    app.windowOf = 7;
    const keys = told(frameOf());
    expect(keys).toContainEqual({ code: "KeyP", mod: true, alt: false, shift: false });
    expect(keys).not.toContainEqual({ code: "KeyA", mod: true, alt: false, shift: false });
  });

  it("take the surroundings' own keys as well", () => {
    const frame = frameOf(undefined, () => {}, { takes: ["ArrowLeft", "Mod+s"] });
    const keys = told(frame);
    expect(keys).toContainEqual({ key: "ArrowLeft", mod: false, alt: false, shift: false });
    expect(keys).toContainEqual({ code: "KeyS", mod: true, alt: false, shift: false });
  });
});

describe("the theme of a themed frame", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is sent again when the theme changes, without reloading the letter", async () => {
    const css = { colorScheme: "dark", getPropertyValue: (v: string) => `colour of ${v}` };
    vi.stubGlobal("getComputedStyle", () => css);
    vi.stubGlobal("matchMedia", () => ({ addEventListener: () => {}, removeEventListener: () => {} }));
    const frame = frameOf(undefined, () => {}, { themed: true });
    const sent = vi.spyOn(frame.contentWindow as Window, "postMessage");
    document.documentElement.dataset.theme = "night";
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.mock.calls.at(-1)?.[0]).toEqual({
      depeshaFrame: 1,
      type: "theme",
      colorScheme: "dark",
      vars: { "--ink": "colour of --ink", "--muted": "colour of --muted", "--line": "colour of --line", "--link": "colour of --link" },
    });
    delete document.documentElement.dataset.theme;
  });
});
