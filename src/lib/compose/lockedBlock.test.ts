import { describe, expect, it } from "vitest";
import { BAR_LIFT, placeLockedBlock, type Box, type Placed } from "./lockedBlock";

// The editor's box on the screen, and the letter's scrolled area in it.
const wrap: Box = { left: 100, top: 200, right: 700, bottom: 600 };
const view: Box = { left: 115, top: 211, right: 685, bottom: 587 };
const BAR = 22;

const box = (top: number, bottom: number): Box => ({ left: 133, top, right: 667, bottom });

/** A box placed in the editor's box, back on the screen. */
const onScreen = (p: Placed, at: { left: number; top: number }): Box => ({
  left: at.left + p.left,
  top: at.top + p.top,
  right: at.left + p.left + p.width,
  bottom: at.top + p.top + p.height,
});

/** The bar's box on the screen; its width does not matter here. */
const barBox = (right: number, top: number): Box => ({ left: wrap.right - right - 120, top: wrap.top + top, right: wrap.right - right, bottom: wrap.top + top + BAR });

const inside = (b: Box, outer: Box) => b.left >= outer.left && b.top >= outer.top && b.right <= outer.right && b.bottom <= outer.bottom;

describe("placeLockedBlock", () => {
  it("puts the bar across the top edge of a block in sight", () => {
    const p = placeLockedBlock(box(400, 480), view, wrap, BAR)!;
    expect(p.bar.top).toBe(400 - BAR_LIFT - wrap.top);
    expect(p.bar.right).toBe(wrap.right - 667);
  });

  it("cuts the tint by the letter's area", () => {
    const p = placeLockedBlock(box(150, 300), view, wrap, BAR)!;
    const clip = onScreen(p.clip, wrap);
    expect(clip).toEqual(view);
    // The tint is the block's own, laid in the clip: the clip cuts what sticks out.
    expect(onScreen(p.hover, clip)).toEqual(box(150, 300));
  });

  it("moves the bar to the bottom of the part in sight when the top is scrolled away", () => {
    const p = placeLockedBlock(box(150, 300), view, wrap, BAR)!;
    const bar = barBox(p.bar.right, p.bar.top);
    expect(inside(bar, view)).toBe(true);
    expect(bar.bottom).toBe(300 + BAR_LIFT);
  });

  it("keeps the bar at the bottom of the area when neither edge is in sight", () => {
    const p = placeLockedBlock(box(100, 900), view, wrap, BAR)!;
    const bar = barBox(p.bar.right, p.bar.top);
    expect(bar.bottom).toBe(view.bottom);
    expect(inside(bar, view)).toBe(true);
  });

  it("moves the bar down when the top edge is in sight but too close to the area's edge", () => {
    const p = placeLockedBlock(box(view.top + 4, 400), view, wrap, BAR)!;
    expect(inside(barBox(p.bar.right, p.bar.top), view)).toBe(true);
    expect(p.bar.top + wrap.top).toBe(400 + BAR_LIFT - BAR);
  });

  it("keeps the bar in sight for a block whose top just shows at the bottom", () => {
    const p = placeLockedBlock(box(580, 700), view, wrap, BAR)!;
    expect(inside(barBox(p.bar.right, p.bar.top), view)).toBe(true);
  });

  it("gives nothing for a block out of sight", () => {
    expect(placeLockedBlock(box(50, 211), view, wrap, BAR)).toBeNull();
    expect(placeLockedBlock(box(587, 700), view, wrap, BAR)).toBeNull();
  });
});
