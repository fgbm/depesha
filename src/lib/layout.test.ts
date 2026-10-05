import { describe, expect, it } from "vitest";
import { Layout, MEDIUM_FROM, SNAP, STRIP, WIDE_FROM, readPanes, sizeOf } from "./layout.svelte";

function make(saved: object | null = null, width = 1280) {
  const store = { value: saved ? JSON.stringify(saved) : null };
  const l = new Layout({ get: () => store.value, set: (v) => (store.value = v) });
  l.resize(width);
  return { l, saved: () => JSON.parse(store.value ?? "null") };
}

describe("the window's width", () => {
  it("picks one of three layouts", () => {
    expect(sizeOf(1440)).toBe("wide");
    expect(sizeOf(WIDE_FROM)).toBe("wide");
    expect(sizeOf(WIDE_FROM - 1)).toBe("medium");
    expect(sizeOf(MEDIUM_FROM)).toBe("medium");
    expect(sizeOf(MEDIUM_FROM - 1)).toBe("narrow");
    expect(sizeOf(520)).toBe("narrow");
  });

  it("folds the sidebar into the strip below the wide size and unfolds it again", () => {
    const { l } = make();
    expect(l.strip).toBe(false);
    expect(l.sideWidth).toBe(248);
    l.resize(960);
    expect(l.strip).toBe(true);
    expect(l.sideWidth).toBe(STRIP);
    expect(l.single).toBe(false);
    l.resize(640);
    expect(l.single).toBe(true);
    l.resize(1280);
    expect(l.strip).toBe(false);
    expect(l.single).toBe(false);
  });

  it("narrows the list before the letter gets unreadable", () => {
    const { l } = make({ list: 500 });
    expect(l.listWidth).toBe(500);
    l.resize(MEDIUM_FROM);
    // 760 - 56 strip - 2 hairlines - 400 for the letter.
    expect(l.listWidth).toBe(302);
    l.resize(600);
    expect(l.listWidth).toBe(280);
  });
});

describe("folding the sidebar by hand", () => {
  it("is kept at any width and between launches", () => {
    const { l, saved } = make();
    l.toggleSidebar();
    expect(l.strip).toBe(true);
    expect(saved()).toEqual({ side: 248, list: 380, collapsed: true });
    l.resize(900);
    l.resize(1600);
    expect(l.strip).toBe(true);
    const again = make(saved()).l;
    expect(again.strip).toBe(true);
  });

  it("unfolds in a medium window until the window crosses a threshold", () => {
    const { l, saved } = make(null, 960);
    expect(l.strip).toBe(true);
    l.toggleSidebar();
    expect(l.strip).toBe(false);
    // Resizing within the same size keeps the choice.
    l.resize(1000);
    expect(l.strip).toBe(false);
    // A narrower window folds it all the same.
    l.resize(700);
    expect(l.strip).toBe(true);
    l.resize(960);
    expect(l.strip).toBe(true);
    // Not remembered as folded: a wide window shows the full sidebar.
    expect(saved().collapsed).toBe(false);
    l.resize(1280);
    expect(l.strip).toBe(false);
  });

  it("folds when the edge is dragged narrower than the snap point and opens past it", () => {
    const { l, saved } = make();
    l.dragSide(200);
    expect(l.side).toBe(200);
    l.dragSide(SNAP - 1);
    expect(l.strip).toBe(true);
    // Its width is kept for the way back.
    expect(l.side).toBe(200);
    l.dragSide(SNAP + 10);
    expect(l.strip).toBe(false);
    expect(l.side).toBe(180);
    l.dragSide(SNAP - 20);
    l.save();
    expect(saved().collapsed).toBe(true);
  });

  it("opens from the strip by dragging in a medium window, for as long as the window keeps its size", () => {
    const { l } = make(null, 960);
    l.dragSide(260);
    expect(l.strip).toBe(false);
    expect(l.collapsed).toBe(false);
    l.resize(700);
    expect(l.strip).toBe(true);
  });
});

describe("saved widths", () => {
  it("survive a broken or odd entry", () => {
    expect(readPanes("{oops")).toEqual({ side: 248, list: 380, collapsed: false });
    expect(readPanes(JSON.stringify({ side: 5000, list: "wide", collapsed: "yes" }))).toEqual({ side: 420, list: 380, collapsed: false });
    expect(readPanes(null)).toEqual({ side: 248, list: 380, collapsed: false });
    // Entries of earlier versions had no `collapsed`.
    expect(readPanes(JSON.stringify({ side: 300, list: 400 }))).toEqual({ side: 300, list: 400, collapsed: false });
  });
});

describe("a narrow window: the list and the letter in turn", () => {
  it("shows the list until a letter is opened", () => {
    const { l } = make(null, 640);
    expect(l.column(true)).toBe("list");
    l.showLetter();
    expect(l.column(true)).toBe("message");
    // Nothing to show (the list emptied, several rows selected): the list.
    expect(l.column(false)).toBe("list");
  });

  it("opens the selected letter by Enter and goes back by Esc", () => {
    const { l } = make(null, 640);
    expect(l.enter(0)).toBe(false);
    expect(l.enter(2)).toBe(false);
    expect(l.enter(1)).toBe(true);
    expect(l.column(true)).toBe("message");
    expect(l.back(true)).toBe(true);
    expect(l.column(true)).toBe("list");
    // On the list Esc is not taken: it is free for whatever else listens.
    expect(l.back(true)).toBe(false);
  });

  it("leaves Enter and Esc alone in a wider window", () => {
    const { l } = make(null, 960);
    expect(l.enter(1)).toBe(false);
    l.showLetter();
    expect(l.back(true)).toBe(false);
  });

  it("keeps the letter on screen across a resize back to narrow", () => {
    const { l } = make(null, 640);
    l.enter(1);
    l.resize(1280);
    l.resize(640);
    expect(l.column(true)).toBe("message");
  });
});
