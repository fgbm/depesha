// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TABLE } from "../../../plugins/typography/table";
import { keyReplacement, matchReplacement, replaceOnKey } from "./typography";

const EM_DASH = "\u2014";
const ELLIPSIS = "\u2026";

function field(value = "", start = value.length, end = start): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  document.body.append(el);
  el.value = value;
  el.setSelectionRange(start, end);
  return el;
}

function key(k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: k, cancelable: true, ...mods });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the entries of the typography table", () => {
  it("answers the last character of an entry and gives the range of the ones before it", () => {
    expect(matchReplacement("-", 1, "-", TABLE)).toEqual({ start: 0, end: 1, insert: EM_DASH });
    expect(matchReplacement("a..", 3, ".", TABLE)).toEqual({ start: 1, end: 3, insert: ELLIPSIS });
  });

  it("does nothing on the first character of an entry", () => {
    expect(matchReplacement("", 0, "-", TABLE)).toBeNull();
    expect(matchReplacement("a.", 2, ".", TABLE)).toBeNull();
  });

  it("does nothing for another key, for no table, or with the caret away from the prefix", () => {
    expect(matchReplacement("-", 1, "x", TABLE)).toBeNull();
    expect(matchReplacement("-", 1, "-", [])).toBeNull();
    expect(matchReplacement("--", 0, "-", TABLE)).toBeNull();
  });

  it("takes the longest entry that fits", () => {
    const table = [
      { from: "..", to: "A" },
      { from: "...", to: "B" },
    ];
    expect(matchReplacement("..", 2, ".", table)?.insert).toBe("B");
    expect(matchReplacement(".", 1, ".", table)?.insert).toBe("A");
  });

  it("keeps the first entry of equal length, so the order of the tables and of their entries decides", () => {
    const first = [{ from: "--", to: "1" }];
    const second = [{ from: "--", to: "2" }];
    expect(matchReplacement("-", 1, "-", [...first, ...second])?.insert).toBe("1");
    const inside = [
      { from: "...", to: "A" },
      { from: "...", to: "B" },
    ];
    expect(matchReplacement("..", 2, ".", inside)?.insert).toBe("A");
  });

  it("takes an entry for a literal sequence, not for a pattern", () => {
    const table = [{ from: "a.c", to: "X" }];
    expect(matchReplacement("ab", 2, "c", table)).toBeNull();
    expect(matchReplacement("a.", 2, "c", table)).toEqual({ start: 0, end: 2, insert: "X" });
  });

  it("leaves text already in the field alone", () => {
    expect(matchReplacement("--", 2, "", TABLE)).toBeNull();
    expect(matchReplacement("a -- b", 6, "b", TABLE)).toBeNull();
  });

  it("turns four hyphens into two dashes, one pair at a time", () => {
    let text = "";
    let caret = 0;
    for (let i = 0; i < 4; i++) {
      const match = matchReplacement(text, caret, "-", TABLE);
      if (!match) {
        text = text.slice(0, caret) + "-" + text.slice(caret);
        caret += 1;
        continue;
      }
      text = text.slice(0, match.start) + match.insert + text.slice(match.end);
      caret = match.start + match.insert.length;
    }
    expect(text).toBe(EM_DASH + EM_DASH);
  });
});

describe("the table a match reads", () => {
  it("keeps the table, its entries and their order as they were", () => {
    const table = [
      { from: "--", to: "A" },
      { from: "...", to: "B" },
    ];
    expect(matchReplacement("-", 1, "-", table)?.insert).toBe("A");
    expect(matchReplacement("..", 2, ".", table)?.insert).toBe("B");
    expect(table).toEqual([
      { from: "--", to: "A" },
      { from: "...", to: "B" },
    ]);
  });
});

describe("the guard a plain field and the Markdown editor share", () => {
  it("reaches the table only from an unmodified key outside a composition", () => {
    expect(keyReplacement({ key: "-", ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn() }, "-", 1, TABLE)).toEqual({ start: 0, end: 1, insert: EM_DASH });
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(keyReplacement({ key: "-", ctrlKey: false, metaKey: false, altKey: false, ...mods, preventDefault: vi.fn() }, "-", 1, TABLE)).toBeNull();
    }
    expect(keyReplacement({ key: "-", ctrlKey: false, metaKey: false, altKey: false, isComposing: true, preventDefault: vi.fn() }, "-", 1, TABLE)).toBeNull();
    expect(keyReplacement({ key: "-", ctrlKey: false, metaKey: false, altKey: false, keyCode: 229, preventDefault: vi.fn() }, "-", 1, TABLE)).toBeNull();
    expect(keyReplacement({ key: "-", ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn() }, "-", 1, [])).toBeNull();
  });
});

describe("the key a replacement answers", () => {
  it("puts the replacement in place of the prefix, keeps the caret after it and tells the field of the change", () => {
    const el = field("-", 1);
    const input = vi.fn();
    el.addEventListener("input", input);
    const e = key("-");

    expect(replaceOnKey(e, el, TABLE)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(el.value).toBe(EM_DASH);
    expect(el.selectionStart).toBe(1);
    expect(el.selectionEnd).toBe(1);
    expect(input).toHaveBeenCalled();
  });

  it("types through the field's own insert command when it has one, so the change is undone as one", () => {
    const el = field("-", 1);
    el.focus();
    const exec = vi.fn((_command: string, _ui: boolean, text: string) => {
      const target = document.activeElement as HTMLTextAreaElement;
      target.setRangeText(text, target.selectionStart, target.selectionEnd, "end");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    try {
      expect(replaceOnKey(key("-"), el, TABLE)).toBe(true);
      expect(exec).toHaveBeenCalledWith("insertText", false, EM_DASH);
      expect(el.value).toBe(EM_DASH);
      expect(el.selectionStart).toBe(1);
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("lets a modified key go", () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const el = field("-", 1);
      const e = key("-", mods);
      expect(replaceOnKey(e, el, TABLE)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(el.value).toBe("-");
    }
  });

  it("lets a key of a composition go", () => {
    const composing = field("-", 1);
    expect(replaceOnKey(key("-", { isComposing: true }), composing, TABLE)).toBe(false);
    expect(composing.value).toBe("-");

    const legacy = field("-", 1);
    const fake = { key: "-", ctrlKey: false, metaKey: false, altKey: false, keyCode: 229, preventDefault: vi.fn() };
    expect(replaceOnKey(fake, legacy, TABLE)).toBe(false);
    expect(fake.preventDefault).not.toHaveBeenCalled();
    expect(legacy.value).toBe("-");
  });

  it("leaves a range of selected text alone", () => {
    const el = field("-", 0, 1);
    const e = key("-");
    expect(replaceOnKey(e, el, TABLE)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(el.value).toBe("-");
  });
});
