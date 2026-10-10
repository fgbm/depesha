import { describe, expect, it } from "vitest";
import type { Box } from "./lockedBlock";
import { BAR_GAP, pictureKey, placePicture } from "./pictureFrame";

// The editor's box on the screen, and the letter's scrolled area in it.
const wrap: Box = { left: 100, top: 200, right: 700, bottom: 600 };
const view: Box = { left: 115, top: 211, right: 685, bottom: 587 };
const BAR = 30;
const BAR_W = 200;

const pic = (top: number, bottom: number): Box => ({ left: 133, top, right: 667, bottom });

describe("placePicture", () => {
  it("a picture in sight keeps its frame and the panel under it", () => {
    const p = placePicture(pic(300, 400), view, wrap, BAR, BAR_W)!;
    expect(p.frame).toEqual({ left: 133 - 115, top: 300 - 211, width: 534, height: 100 });
    expect(p.bar).toEqual({ left: 33, top: 400 + BAR_GAP - 200 });
  });

  it("the frame is cut by the area in sight, not by the picture's own box", () => {
    // Taller than the area, its top scrolled away: the clip is the area, the frame sticks out of it.
    const p = placePicture(pic(-300, 400), view, wrap, BAR, BAR_W)!;
    expect(p.clip).toEqual({ left: 15, top: 11, width: 570, height: 376 });
    expect(p.frame.top).toBeLessThan(0);
    expect(p.clip.top).toBe(view.top - wrap.top);
  });

  it("the panel sticks to the bottom of the area when the picture goes below it", () => {
    const p = placePicture(pic(500, 900), view, wrap, BAR, BAR_W)!;
    expect(p.bar.top).toBe(view.bottom - BAR - wrap.top);
  });

  it("the panel never goes above the area", () => {
    const p = placePicture(pic(215, 230), { ...view, bottom: 230 }, wrap, 100, BAR_W)!;
    expect(p.bar.top).toBe(view.top - wrap.top);
  });

  it("nothing for a picture scrolled out of sight, above or below", () => {
    expect(placePicture(pic(-500, 100), view, wrap, BAR, BAR_W)).toBeNull();
    expect(placePicture(pic(211 - 50, 211), view, wrap, BAR, BAR_W)).toBeNull();
    expect(placePicture(pic(600, 900), view, wrap, BAR, BAR_W)).toBeNull();
  });

  it("the panel stays inside the area on the right for a picture at its edge", () => {
    const narrow: Box = { left: 600, top: 300, right: 680, bottom: 400 };
    const p = placePicture(narrow, view, wrap, BAR, BAR_W)!;
    expect(p.bar.left + BAR_W).toBeLessThanOrEqual(view.right - wrap.left);
  });

  it("the panel keeps the area's left edge when it is wider than the area", () => {
    const p = placePicture(pic(300, 400), { ...view, right: 215 }, wrap, BAR, BAR_W)!;
    expect(p.bar.left).toBe(view.left - wrap.left);
  });
});

describe("pictureKey", () => {
  const seen = placePicture(pic(300, 400), view, wrap, BAR, BAR_W);

  it("Delete and Backspace remove a picture in sight", () => {
    expect(pictureKey("Delete", seen)).toBe("remove");
    expect(pictureKey("Backspace", seen)).toBe("remove");
  });

  it("they leave a picture out of sight alone: it is not on the screen to be deleted", () => {
    expect(pictureKey("Delete", null)).toBe("keep");
    expect(pictureKey("Backspace", null)).toBe("keep");
  });

  it("any other key lets go of the picture", () => {
    expect(pictureKey("a", seen)).toBe("release");
    expect(pictureKey("a", null)).toBe("release");
  });
});
