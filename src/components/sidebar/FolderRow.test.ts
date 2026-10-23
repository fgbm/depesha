// @vitest-environment jsdom
// One folder of the sidebar as a place to drop letters (letterDrag.svelte.ts): the row says it
// takes them while the pointer is over it, and the pointer up there moves them into it.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import FolderRow from "./FolderRow.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { letterDrag } from "../../lib/letterDrag.svelte";
import { app } from "../../lib/store.svelte";
import { resetFakes, row } from "../../lib/testing";
import type { AccountView, FolderInfo } from "../../lib/types";

const account = { id: "a", label: "Я", display_name: "Я", email: "me@example.com" } as unknown as AccountView;
const folder = (name: string): FolderInfo =>
  ({ account_id: "a", name, display_name: name, delimiter: "/", role: null, selectable: true, hidden: false, total: 0, unread: 0 }) as FolderInfo;

let view: ReturnType<typeof mount> | null = null;
/** The move of the app, in place of the backend: the drop is where the two meet. */
let move: MockInstance<(folder: string, ids?: number[]) => Promise<void>>;

function draw(name = "Archive"): HTMLElement {
  const target = document.createElement("div");
  target.className = "side";
  document.body.append(target);
  view = mount(FolderRow, { target, props: { account, folder: folder(name) } });
  flushSync();
  return target.querySelector<HTMLElement>(".folder-row")!;
}

/** A press on a row of the list, and the pointer leaving it for the folder. */
function dragFromList(ids: number[] = [1, 2]) {
  const from = document.createElement("div");
  document.body.append(from);
  const down = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 });
  from.dispatchEvent(down);
  letterDrag.press(down as unknown as PointerEvent, ids, "a");
  window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 40 }));
}

beforeEach(() => {
  i18n.lang = "ru";
  resetFakes();
  // The pointer listeners are the window's own here.
  vi.unstubAllGlobals();
  app.list.messages = [row(1), row(2)];
  move = vi.spyOn(app.actions, "moveTo").mockResolvedValue(undefined);
});

afterEach(() => {
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  if (view) unmount(view);
  view = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a folder of the sidebar and the letters dragged onto it", () => {
  it("says it takes them while the pointer is over it, and only for its own mailbox", () => {
    const rowEl = draw("Archive");
    const over = () => rowEl.classList.contains("drop");
    expect(over()).toBe(false);
    dragFromList();
    rowEl.dispatchEvent(new MouseEvent("pointerenter"));
    flushSync();
    expect(over()).toBe(true);
    rowEl.dispatchEvent(new MouseEvent("pointerleave"));
    flushSync();
    expect(over()).toBe(false);
    // Another mailbox's letters: the folder of this one takes nothing.
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    dragFromList([1]);
    letterDrag.dragging!.account_id = "b";
    rowEl.dispatchEvent(new MouseEvent("pointerenter"));
    flushSync();
    expect(over()).toBe(false);
  });

  it("takes them on the pointer up: the move names this folder", () => {
    const rowEl = draw("Archive");
    dragFromList();
    rowEl.dispatchEvent(new MouseEvent("pointerenter"));
    flushSync();
    rowEl.querySelector("button")!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(move).toHaveBeenCalledWith("Archive", [1, 2]);
    expect(letterDrag.dragging).toBeNull();
  });

  it("carries its mailbox and name for the drop", () => {
    const rowEl = draw("Archive");
    expect(rowEl.dataset.account).toBe("a");
    expect(rowEl.dataset.folder).toBe("Archive");
    expect(rowEl.dataset.dropFolder).toBe("Archive");
  });

  it("is clicked as it was when no letters are in hand", () => {
    const rowEl = draw("Archive");
    rowEl.dispatchEvent(new MouseEvent("pointerenter"));
    rowEl.querySelector("button")!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    flushSync();
    expect(rowEl.classList.contains("drop")).toBe(false);
  });
});
