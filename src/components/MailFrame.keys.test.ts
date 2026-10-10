// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MailFrame from "./MailFrame.svelte";

let view: ReturnType<typeof mount> | null = null;

function frameOf(html = "<p>письмо <a href='https://example.com/x'>ссылка</a></p>", onLink = () => {}) {
  view = mount(MailFrame, { target: document.body, props: { html, allowRemote: false, onLink } });
  flushSync();
  return document.querySelector("iframe") as HTMLIFrameElement;
}

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the keys and the links of a letter's frame", () => {
  it("replays a key pressed inside the frame to the window, once, however often the frame loads", () => {
    const frame = frameOf();
    // WebKitGTK loads the frame's document before `bind:this` has told the component its element:
    // the handler must work from the load event's own element.
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
    const heard = vi.fn((e: KeyboardEvent) => e.preventDefault());
    window.addEventListener("keydown", heard);
    try {
      const own = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true });
      frame.contentDocument!.body.dispatchEvent(own);
      expect(heard).toHaveBeenCalledOnce();
      const copy = heard.mock.calls[0][0];
      expect(copy.target).toBe(frame);
      expect([copy.key, copy.code, copy.ctrlKey]).toEqual(["k", "KeyK", true]);
      // The window took the key (Ctrl+K opened the palette): the frame's own default is cancelled too.
      expect(own.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("keydown", heard);
    }
  });

  it("leaves plain arrows to the frame, and a key nobody takes to the frame's own default", () => {
    const frame = frameOf();
    frame.dispatchEvent(new Event("load"));
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    try {
      frame.contentDocument!.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      expect(heard).not.toHaveBeenCalled();
      const own = new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, bubbles: true, cancelable: true });
      frame.contentDocument!.body.dispatchEvent(own);
      expect(heard).toHaveBeenCalledOnce();
      expect(own.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener("keydown", heard);
    }
  });

  it("hands a clicked link to the app instead of following it", () => {
    const onLink = vi.fn();
    const frame = frameOf(undefined, onLink);
    frame.dispatchEvent(new Event("load"));
    const doc = frame.contentDocument!;
    doc.body.innerHTML = "<a href='https://example.com/x'>ссылка</a>";
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    doc.querySelector("a")!.dispatchEvent(click);
    expect(onLink).toHaveBeenCalledWith("https://example.com/x");
    expect(click.defaultPrevented).toBe(true);
  });
});
