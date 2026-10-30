// @vitest-environment jsdom
// Another document is another iframe: WebKitGTK does not reload an iframe whose `srcdoc` changed
// (docs/dev-notes.md), so the letter is drawn again only by a new frame. What belonged to the old
// document — the link under the pointer, the height, the relay — belongs to it alone.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MailFrame from "./MailFrame.svelte";

let view: ReturnType<typeof mount> | null = null;

/** Renders the props as they stand now and gives the frame that was drawn. */
function draw() {
  flushSync();
  return document.querySelector("iframe") as HTMLIFrameElement;
}

/** What the frame's own relay sends (#124): the parent hears it on its window. */
function fromFrame(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow as MessageEventSource }));
}

const status = () => document.querySelector(".status")?.getAttribute("title") ?? null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("a letter drawn in a frame", () => {
  it("is drawn again as another iframe, not as another srcdoc of the same one", () => {
    const props = $state({ html: "<p>без картинок</p>", allowRemote: false, onLink: () => {} });
    view = mount(MailFrame, { target: document.body, props });
    const first = draw();
    expect(first.getAttribute("srcdoc")).toContain("без картинок");

    // The same letter read again with its pictures allowed: the backend answers with other HTML.
    props.allowRemote = true;
    props.html = '<p>с картинками</p><img src="https://bank.example/p.png">';
    const second = draw();
    expect(second).not.toBe(first);
    expect(second.getAttribute("srcdoc")).toContain("bank.example");
  });

  it("leaves no link of the old document under the pointer", () => {
    const props = $state({ html: "<p><a href='https://bank.example/x'>x</a></p>", allowRemote: false, onLink: () => {} });
    view = mount(MailFrame, { target: document.body, props });
    fromFrame(draw(), { depeshaFrame: 1, type: "hover", href: "https://bank.example/x" });
    flushSync();
    expect(status()).toBe("https://bank.example/x");

    props.html = "<p>другой текст</p>";
    draw();
    expect(status()).toBeNull();
  });

  it("keeps the height of a letter whose text came again, and drops it for another letter", () => {
    const props = $state({ html: "<p>письмо</p>", allowRemote: false, onLink: () => {}, fit: true, letter: 5 });
    view = mount(MailFrame, { target: document.body, props });
    fromFrame(draw(), { depeshaFrame: 1, type: "height", height: 2400 });
    flushSync();
    expect(document.querySelector<HTMLIFrameElement>("iframe")!.style.height).toBe("2400px");

    // The pictures allowed: the letter is the same, so it keeps the height it had a moment ago.
    props.html = '<p>письмо</p><img src="https://bank.example/p.png">';
    expect(draw().style.height).toBe("2400px");

    // Another letter is another height: the old one would stretch it until its relay speaks.
    props.letter = 6;
    expect(draw().style.height).toBe("");
  });

  it("hears the relay of the frame it drew, and no one of the frame before", async () => {
    const props = $state({ html: "<p>письмо</p>", allowRemote: false, onLink: () => {} });
    view = mount(MailFrame, { target: document.body, props });
    const first = draw();
    props.html = "<p>другое письмо</p>";
    const second = draw();

    // The keys the app takes reach the new frame: the relay has to know them before a press.
    const heard: Array<{ type?: string }> = [];
    second.contentWindow!.addEventListener("message", (e) => heard.push(e.data as { type?: string }));
    await new Promise((done) => setTimeout(done, 20));
    expect(heard.some((m) => m.type === "keys")).toBe(true);

    // A message of the old document is a stranger's now, as any other window's.
    fromFrame(first, { depeshaFrame: 1, type: "hover", href: "https://old.example/x" });
    flushSync();
    expect(status()).toBeNull();
  });
});
