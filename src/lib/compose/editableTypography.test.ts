// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TABLE } from "../../../plugins/typography/table";
import type { ReplacementKey } from "./typography";
import { typedReplacement } from "./editableTypography";

const EM_DASH = "\u2014";
const ELLIPSIS = "\u2026";

function editor(html = ""): HTMLDivElement {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function text(root: Element): Text {
  const node = root.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("no text node");
  return node as Text;
}

function caret(node: Node, offset: number): Range {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
}

function selection(node: Node, from: number, to: number): void {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function key(k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, cancelable: true, ...mods });
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("a replacement typed in the visual editor", () => {
  it("turns the typed hyphen into an em dash and selects the prefix it stands for", () => {
    const root = editor();
    const node = document.createTextNode("-");
    root.append(node);
    caret(node, 1);
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBe(EM_DASH);
    expect(e.defaultPrevented).toBe(true);
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    expect(sel.getRangeAt(0).startContainer).toBe(node);
    expect(sel.getRangeAt(0).endContainer).toBe(node);
    expect(sel.getRangeAt(0).toString()).toBe("-");
    expect(sel.getRangeAt(0).startOffset).toBe(0);
    expect(sel.getRangeAt(0).endOffset).toBe(1);
  });

  it("turns the third dot into an ellipsis, the two dots before it selected", () => {
    const root = editor();
    const node = document.createTextNode("a..");
    root.append(node);
    caret(node, 3);
    const e = key(".");

    expect(typedReplacement(e, root, TABLE)).toBe(ELLIPSIS);
    expect(e.defaultPrevented).toBe(true);
    expect(window.getSelection()!.getRangeAt(0).toString()).toBe("..");
    expect(window.getSelection()!.getRangeAt(0).startOffset).toBe(1);
    expect(window.getSelection()!.getRangeAt(0).endOffset).toBe(3);
  });
});

describe("the keys the table leaves to the editor", () => {
  it("leaves the key alone when the table is empty", () => {
    const root = editor();
    const node = document.createTextNode("-");
    root.append(node);
    caret(node, 1);
    const e = key("-");

    expect(typedReplacement(e, root, [])).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves a range of selected text alone", () => {
    const root = editor();
    const node = document.createTextNode("a-");
    root.append(node);
    selection(node, 0, 2);
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves the key alone without a selection", () => {
    const root = editor();
    root.append(document.createTextNode("-"));
    window.getSelection()!.removeAllRanges();
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves the caret's node alone when it is outside the editor", () => {
    const root = editor();
    const outside = document.createElement("div");
    document.body.append(outside);
    const node = document.createTextNode("-");
    outside.append(node);
    caret(node, 1);
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("the keys a replacement never answers", () => {
  it("leaves a modified key and a key of a composition alone", () => {
    const root = editor();
    const node = document.createTextNode("-");
    root.append(node);
    caret(node, 1);

    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      const e = key("-", mods);
      expect(typedReplacement(e, root, TABLE)).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    }
    const ime: ReplacementKey = { key: "-", ctrlKey: false, metaKey: false, altKey: false, keyCode: 229, preventDefault: vi.fn() };
    expect(typedReplacement(ime, root, TABLE)).toBeNull();
    expect(ime.preventDefault).not.toHaveBeenCalled();
  });
});

describe("the blocks the table leaves alone", () => {
  const cases: Array<[string, string]> = [
    ["pre", "<pre>-</pre>"],
    ["code", "<code>-</code>"],
    ["a link", '<a href="https://example.org">-</a>'],
    ["a locked block", '<span contenteditable="false">-</span>'],
  ];

  for (const [name, html] of cases) {
    it(`does not type in ${name}`, () => {
      const root = editor(html);
      const node = text(root.firstElementChild!);
      caret(node, 1);
      const e = key("-");

      expect(typedReplacement(e, root, TABLE)).toBeNull();
      expect(e.defaultPrevented).toBe(false);
    });
  }

  it("does not type while the editor is read-only", () => {
    const root = editor();
    root.setAttribute("contenteditable", "false");
    const node = document.createTextNode("-");
    root.append(node);
    caret(node, 1);
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("the node boundary of a replacement", () => {
  it("does not take a prefix whose characters lie in another element", () => {
    const root = editor("<span>--</span>");
    const empty = document.createTextNode("");
    root.append(empty);
    caret(empty, 0);
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBeNull();
    expect(e.defaultPrevented).toBe(false);
    expect(root.querySelector("span")!.textContent).toBe("--");
  });

  it("changes only the node the caret is in, never the one before it", () => {
    const root = editor("<span>-</span>");
    const node = document.createTextNode("-");
    root.append(node);
    caret(node, 1);
    const e = key("-");

    expect(typedReplacement(e, root, TABLE)).toBe(EM_DASH);
    expect(e.defaultPrevented).toBe(true);
    expect(root.querySelector("span")!.textContent).toBe("-");
    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(node);
  });
});

describe("a row of hyphens typed one key at a time", () => {
  it("turns four hyphens into two em dashes, one pair at a time", () => {
    const root = editor();
    const node = document.createTextNode("");
    root.append(node);
    caret(node, 0);
    let caretAt = 0;

    for (let i = 0; i < 4; i++) {
      const e = key("-");
      const insert = typedReplacement(e, root, TABLE);
      if (insert === null) {
        node.insertData(caretAt, "-");
        caretAt += 1;
        caret(node, caretAt);
        continue;
      }
      const range = window.getSelection()!.getRangeAt(0);
      node.deleteData(range.startOffset, range.endOffset - range.startOffset);
      node.insertData(range.startOffset, insert);
      caretAt = range.startOffset + insert.length;
      caret(node, caretAt);
    }
    expect(node.data).toBe(EM_DASH + EM_DASH);
  });
});
