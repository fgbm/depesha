// @vitest-environment jsdom
// The engine's own interface — the menu of the right button, «select all», the keys that reload
// the page — stays out of the windows of the app. Fields, editors and text selected to copy keep
// it: that is where cut, copy, paste and the spelling corrections live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rulesFor, useStyles } from "./cssTesting";
import { EDITORS, engineKey, engineMenuWanted, keepEngineHandsOff, keepEngineMenuOut, SELECTABLE, selectAllWanted } from "./engine";

/** The elements of the window the engine's own things are asked about. */
function element(html: string): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = html;
  document.body.append(box);
  return box.firstElementChild as HTMLElement;
}

/** A right click on `el`, as the window's document gets it. */
function menuOn(el: Element): MouseEvent {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/** A press in the window, as its document gets it. */
function pressOn(el: EventTarget, key: string, mod = false, shift = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: mod, shiftKey: shift });
  el.dispatchEvent(e);
  return e;
}

/** What the user has chosen: the document's selection, told as the engine would see it. */
function chosen(on: boolean) {
  const text = on ? "Тема письма" : "";
  vi.spyOn(document, "getSelection").mockReturnValue({ isCollapsed: !on, toString: () => text } as unknown as Selection);
}

describe("the menu of the right button", () => {
  let off = () => {};
  beforeEach(() => (off = keepEngineMenuOut(document)));
  afterEach(() => {
    off();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("belongs over a field, an editor and text chosen to copy", () => {
    chosen(false);
    for (const html of ["<input>", "<textarea></textarea>", "<div contenteditable='true'></div>", "<div><div class='cm-editor'><div class='cm-line'>x</div></div></div>"]) {
      const field = element(html);
      expect(engineMenuWanted(field.querySelector("*") ?? field, false), html).toBe(true);
    }
    chosen(true);
    expect(menuOn(element("<span class='selectable'>Привет</span>")).defaultPrevented).toBe(false);
  });

  it("is stopped everywhere else: the list, the sidebar, a button, a heading, a menu", () => {
    chosen(false);
    for (const html of ["<div class='row'>Письмо</div>", "<button class='btn'>Ответить</button>", "<div class='side'>Папки</div>", "<h1>Тема</h1>", "<div class='pop'><button class='mi'>Удалить</button></div>"]) {
      expect(menuOn(element(html)).defaultPrevented, html).toBe(true);
    }
  });

  it("keeps the menu of a row of Depesha's own, which the row itself opens", () => {
    chosen(false);
    const row = element("<div class='row'></div>");
    row.addEventListener("contextmenu", (e) => e.preventDefault());
    expect(menuOn(row).defaultPrevented).toBe(true);
  });
});

describe("the keys of the document", () => {
  it("keeps Ctrl+A to fields, editors and the text the user may select", () => {
    chosen(false);
    expect(selectAllWanted(element("<input>"))).toBe(true);
    expect(selectAllWanted(element("<textarea></textarea>"))).toBe(true);
    expect(selectAllWanted(element("<div contenteditable='true'></div>"))).toBe(true);
    expect(selectAllWanted(element("<div class='selectable'>Текст письма</div>"))).toBe(true);
    expect(selectAllWanted(element("<div class='row'>Письмо</div>"))).toBe(false);
    expect(selectAllWanted(document.body)).toBe(false);
    expect(selectAllWanted(null)).toBe(false);
  });

  it("takes «select all» of the window and leaves it to a field", () => {
    const release = keepEngineHandsOff(document, true);
    const input = element("<input>");
    const row = element("<div class='row'></div>");
    expect(pressOn(row, "a", true).defaultPrevented).toBe(true);
    expect(pressOn(document.body, "a", true).defaultPrevented).toBe(true);
    expect(pressOn(input, "a", true).defaultPrevented).toBe(false);
    release();
  });

  it("takes the reload and the inspector of a built app, and leaves them in `dev`", () => {
    for (const [key, mod, shift] of [["F5", false, false], ["F12", false, false], ["r", true, false], ["i", true, true]] as const) {
      expect(engineKey(new KeyboardEvent("keydown", { key, ctrlKey: mod, shiftKey: shift }), true), key).toBe(true);
      expect(engineKey(new KeyboardEvent("keydown", { key, ctrlKey: mod, shiftKey: shift }), false), key).toBe(false);
    }
    // A letter, a menu, the app's own keys: none of them is the engine's.
    expect(engineKey(new KeyboardEvent("keydown", { key: "r" }), true)).toBe(false);
    expect(engineKey(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }), true)).toBe(false);
    const release = keepEngineHandsOff(document, true);
    expect(pressOn(document.body, "F5").defaultPrevented).toBe(true);
    expect(pressOn(document.body, "p", true).defaultPrevented).toBe(false);
    release();
  });
});

describe("the selection of the window", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "../app.css")));
  afterEach(() => unstyle());

  it("is the app's surface by default: the root takes no selection", () => {
    const [root] = rulesFor("body");
    expect(root.style.getPropertyValue("user-select")).toBe("none");
    // A WKWebView of before Safari 15.4 knows only the prefixed name.
    expect(root.style.getPropertyValue("-webkit-user-select")).toBe("none");
    expect(root.style.getPropertyValue("-webkit-tap-highlight-color")).toBe("transparent");
  });

  it("is given to the text the user may copy: fields, editors and the selectable zones", () => {
    const all = [...document.styleSheets].flatMap((s) => [...s.cssRules]) as CSSStyleRule[];
    const zones = all.filter((r) => (r.selectorText ?? "").split(/\s*,\s*/).includes("[contenteditable]"));
    expect(zones).toHaveLength(1);
    for (const zone of [...EDITORS.split(", "), SELECTABLE]) expect(zones[0].selectorText.split(/\s*,\s*/), zone).toContain(zone);
    // A WKWebView of before Safari 15.4 knows only the prefixed name.
    expect(zones[0].style.getPropertyValue("-webkit-user-select")).toBe("text");
    // The list, the buttons and the menu are not text of the user's.
    const selectors = all.filter((r) => r.style?.getPropertyValue("user-select") === "text").flatMap((r) => r.selectorText.split(/\s*,\s*/));
    expect(selectors.filter((s) => /\.row$|\.btn$|\.mi$|\.side$/.test(s))).toEqual([]);
  });

  it("takes its colour from the theme, in every look", () => {
    const [selection] = rulesFor("::selection");
    expect(selection.style.getPropertyValue("background")).toContain("var(--accent-text)");
    expect(selection.style.getPropertyValue("color")).toBe("var(--ink)");
  });
});
