// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { anchorOf, keyAnchor, placeMenu, placeSide } from "./anchor";

const win = { w: 1000, h: 700 };
const menu = { w: 240, h: 300 };
/** A list row 56 high whose top is at `top`. */
const row = (top: number) => anchorOf({ left: 300, top, height: 56 });

describe("a menu opened by a key hangs on the selected row (#96)", () => {
  it("under the row near the top of the list", () => {
    const p = placeMenu(row(100), menu, win);
    expect(p.below).toBe(true);
    expect(p.top).toBe(100 + 56 + 4);
    expect(p.left).toBe(316);
  });

  it("over the row near the bottom, its lower edge a gap above the row", () => {
    const p = placeMenu(row(600), menu, win);
    expect(p.below).toBe(false);
    expect(p.top).toBe(600 - 4 - 300);
    // The row itself is not covered.
    expect(p.top + menu.h).toBeLessThanOrEqual(600);
  });

  it("on the side with more room, shortened, when it fits on neither", () => {
    const tall = { w: 240, h: 900 };
    const above = placeMenu(row(400), tall, win);
    expect(above.below).toBe(false);
    expect(above.maxHeight).toBe(400 - 4 - 8);
    expect(above.top).toBe(400 - 4 - above.maxHeight);
    expect(placeMenu(row(100), tall, win).below).toBe(true);
  });

  it("to the left of the row's mark near the right edge, inside the window", () => {
    const p = placeMenu(anchorOf({ left: 900, top: 100, height: 56 }), menu, win);
    expect(p.left).toBe(916 - 240);
    expect(p.left + menu.w).toBeLessThanOrEqual(win.w - 8);
  });

  it("a bare point, as a context menu has it, keeps touching the menu", () => {
    expect(placeMenu({ x: 200, y: 200 }, menu, win).top).toBe(200);
    expect(placeMenu({ x: 200, y: 650 }, menu, win).top).toBe(650 - 300);
  });
});

describe("a submenu beside its parent", () => {
  const parent = { left: 300, right: 540, top: 200, bottom: 520 };

  it("to the right, level with the parent's top, the parent stays in sight", () => {
    const p = placeSide(parent, { w: 220, h: 200 }, win);
    expect(p.left).toBe(544);
    expect(p.top).toBe(196);
  });

  it("to the left where the window ends", () => {
    const p = placeSide({ ...parent, left: 700, right: 940 }, { w: 220, h: 200 }, win);
    expect(p.left).toBe(700 - 4 - 220);
  });

  it("not below the window's bottom", () => {
    const p = placeSide({ ...parent, top: 600, bottom: 660 }, { w: 220, h: 200 }, win);
    expect(p.top + 200).toBeLessThanOrEqual(win.h - 8);
  });
});

describe("the selected row", () => {
  it("is found on the page, and the middle of the window stands in when none is drawn", () => {
    document.body.innerHTML = '<div class="row"></div><div class="row selected"></div>';
    const el = document.querySelector<HTMLElement>(".row.selected")!;
    el.getBoundingClientRect = () => ({ left: 300, top: 120, height: 56 }) as DOMRect;
    expect(keyAnchor(document, win)).toEqual({ x: 316, y: 120, h: 56 });
    document.body.innerHTML = "";
    expect(keyAnchor(document, win)).toEqual({ x: 380, y: 120 });
  });
});
