// @vitest-environment jsdom
// A frame in a conversation takes the height its own letter reports: the letter gets no scroll of
// its own, and the pane keeps the only one (#А7).
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MailFrame from "./MailFrame.svelte";
import { FRAME_MAX_HEIGHT } from "../lib/frameRelay";

let view: ReturnType<typeof mount> | null = null;

function frameOf(props: Record<string, unknown> = {}) {
  view = mount(MailFrame, { target: document.body, props: { html: "<p>длинное письмо</p>", allowRemote: false, onLink: () => {}, ...props } });
  flushSync();
  return document.querySelector("iframe") as HTMLIFrameElement;
}

/** What the relay of a frame sends, from the window a test names: its own, or a stranger's. */
function from(data: unknown, source: MessageEventSource | null) {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

const heightOf = (frame: HTMLIFrameElement) => frame.style.height;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the height a frame takes from its letter", () => {
  it("gives the frame of a conversation the height its own letter reports", () => {
    const frame = frameOf({ fit: true });
    from({ depeshaFrame: 1, type: "height", height: 2400 }, frame.contentWindow);
    flushSync();
    expect(heightOf(frame)).toBe("2400px");
    // A letter that shrinks, a quote folded back: the frame follows down as well as up.
    from({ depeshaFrame: 1, type: "height", height: 900 }, frame.contentWindow);
    flushSync();
    expect(heightOf(frame)).toBe("900px");
  });

  it("keeps its own box for a letter read alone, whatever that letter says", () => {
    const frame = frameOf();
    from({ depeshaFrame: 1, type: "height", height: 2400 }, frame.contentWindow);
    flushSync();
    expect(heightOf(frame)).toBe("");
  });

  it("hears no height from another window", () => {
    const frame = frameOf({ fit: true });
    from({ depeshaFrame: 1, type: "height", height: 2400 }, frame.contentWindow);
    flushSync();
    from({ depeshaFrame: 1, type: "height", height: 100 }, window);
    from({ depeshaFrame: 1, type: "height", height: 120 }, null);
    flushSync();
    expect(heightOf(frame)).toBe("2400px");
  });

  it("leaves a value that is no height of a letter alone, and keeps the one it had", () => {
    const frame = frameOf({ fit: true });
    from({ depeshaFrame: 1, type: "height", height: 1500 }, frame.contentWindow);
    flushSync();
    for (const height of ["2400", Number.NaN, Number.POSITIVE_INFINITY, -1, FRAME_MAX_HEIGHT + 1, null, 1500.4]) {
      from({ depeshaFrame: 1, type: "height", height }, frame.contentWindow);
      flushSync();
      expect(heightOf(frame)).toBe("1500px");
    }
    // A whole number of pixels is the one the frame draws with.
    from({ depeshaFrame: 1, type: "height", height: 1500.6 }, frame.contentWindow);
    flushSync();
    expect(heightOf(frame)).toBe("1501px");
  });
});
