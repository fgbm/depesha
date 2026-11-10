// @vitest-environment jsdom
// The typography of a visual letter: a pair of hyphens becomes a dash and three dots an
// ellipsis, by the editor's own insert command so the change is undone as one typing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import RichEditor from "./RichEditor.svelte";
import { registry } from "../plugin-host/registry.svelte";
import { TABLE } from "../../plugins/typography/table";

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const EM_DASH = "\u2014";
const ELLIPSIS = "\u2026";

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
let exec: ReturnType<typeof vi.fn>;
/** The props the block is mounted with: the letter's html comes back here after an edit. */
let bound: { html: string } | null = null;

/** jsdom has no insert command: it puts the value over the selection, as the browser does. */
function installExec() {
  const run = vi.fn((command: string, _ui: boolean, value?: string) => {
    if (command !== "insertText" || value == null) return true;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(value);
    range.insertNode(node);
    const after = document.createRange();
    after.setStart(node, node.length);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: run });
  return run;
}

function show(given: { html?: string; locked?: string; readonly?: boolean; replacements?: boolean } = {}) {
  const { replacements: typed = true, ...rest } = given;
  target = document.createElement("div");
  document.body.append(target);
  // The letter's window passes the live table; the signature editor passes nothing at all.
  const props = $state({
    label: "Письмо",
    html: "",
    ...rest,
    replacements: typed ? () => registry.composeReplacements() : undefined,
  });
  bound = props;
  view = mount(RichEditor, { target, props });
  flushSync();
  view.element()!.focus();
  return view;
}

function root(): HTMLDivElement {
  return view!.element()!;
}

function caret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** A key with the insertion the browser would make when no handler stops it. */
function press(k: string): KeyboardEvent {
  const el = root();
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  flushSync();
  if (e.defaultPrevented) return e;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return e;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(k);
  range.insertNode(node);
  const after = document.createRange();
  after.setStart(node, node.length);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  return e;
}

function type(keys: string): void {
  for (const k of keys) press(k);
}

/** A key with nothing typed after it: the DOM is left as it is. */
function down(k: string): KeyboardEvent {
  const el = root();
  el.focus();
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  flushSync();
  return e;
}

beforeEach(() => {
  exec = installExec();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  bound = null;
  registry.removeOwner("typography");
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "execCommand");
});

describe("the typography of a visual letter", () => {
  it("turns the second hyphen into an em dash through the editor's insert command", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: "<div>a-</div>" });
    await tick();
    const body = root().querySelector("div")!;
    caret(body.firstChild!, 2);

    const e = press("-");
    expect(e.defaultPrevented).toBe(true);
    expect(exec).toHaveBeenCalledWith("insertText", false, EM_DASH);
    expect(body.textContent).toBe(`a${EM_DASH}`);
    expect(root().textContent).toBe(`a${EM_DASH}`);
    expect(bound!.html).toBe(`<div>a${EM_DASH}</div>`);
  });

  it("turns the third dot into an ellipsis", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: "<div>a..</div>" });
    await tick();
    const body = root().querySelector("div")!;
    caret(body.firstChild!, 3);

    expect(press(".").defaultPrevented).toBe(true);
    expect(exec).toHaveBeenCalledWith("insertText", false, ELLIPSIS);
    expect(body.textContent).toBe(`a${ELLIPSIS}`);
    expect(bound!.html).toBe(`<div>a${ELLIPSIS}</div>`);
  });

  it("turns four hyphens into two em dashes, one pair at a time", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: "<div></div>" });
    await tick();
    const body = root().querySelector("div")!;
    caret(body, 0);

    type("----");
    expect(body.textContent).toBe(EM_DASH + EM_DASH);
  });
});

describe("the table of an open letter", () => {
  it("leaves the text alone while the typography plugin is off", async () => {
    show({ html: "<div>-</div>" });
    await tick();
    const body = root().querySelector("div")!;
    caret(body.firstChild!, 1);

    expect(press("-").defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalledWith("insertText", false, EM_DASH);
    expect(body.textContent).toBe("--");
  });

  it("starts at once when the plugin is switched on and stops when it is switched off", async () => {
    show({ html: "<div></div>" });
    await tick();
    const body = root().querySelector("div")!;
    caret(body, 0);

    type("-");
    expect(body.textContent).toBe("-");

    registry.add("composeReplacements", "typography", TABLE);
    flushSync();
    type("-");
    expect(body.textContent).toBe(EM_DASH);

    registry.removeOwner("typography");
    flushSync();
    type("--");
    expect(body.textContent).toBe(`${EM_DASH}--`);
  });

  it("does not rewrite a double hyphen that came into the block whole", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: "<div>Ставка -- 5%</div>" });
    await tick();
    const body = root().querySelector("div")!;

    body.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(exec).not.toHaveBeenCalledWith("insertText", false, EM_DASH);
    expect(body.textContent).toBe("Ставка -- 5%");
  });
});

describe("the blocks a typed replacement leaves alone", () => {
  it("does not type in the locked signature", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: '<div class="depesha-signature">-</div>', locked: "depesha-signature" });
    await tick();
    const signature = root().querySelector(".depesha-signature")!;
    // jsdom does not reflect contentEditable onto the attribute, so the lock is set as the browser does.
    signature.setAttribute("contenteditable", "false");
    caret(signature.firstChild!, 1);

    const e = down("-");
    expect(e.defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalledWith("insertText", false, EM_DASH);
    expect(signature.textContent).toBe("-");
  });

  it("does not type while the letter is read-only", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: "<div>-</div>", readonly: true });
    await tick();
    expect(root().getAttribute("contenteditable")).toBe("false");
    const body = root().querySelector("div")!;
    caret(body.firstChild!, 1);

    const e = down("-");
    expect(e.defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalledWith("insertText", false, EM_DASH);
    expect(body.textContent).toBe("-");
  });

  it("does not rewrite a pair of hyphens or three dots of a block given no table", async () => {
    registry.add("composeReplacements", "typography", TABLE);
    show({ html: "<div></div>", replacements: false });
    await tick();
    const body = root().querySelector("div")!;
    caret(body, 0);

    type("-");
    expect(press("-").defaultPrevented).toBe(false);
    expect(body.textContent).toBe("--");

    type("..");
    expect(press(".").defaultPrevented).toBe(false);
    expect(body.textContent).toBe("--...");

    expect(exec).not.toHaveBeenCalledWith("insertText", false, EM_DASH);
    expect(exec).not.toHaveBeenCalledWith("insertText", false, ELLIPSIS);
  });
});
