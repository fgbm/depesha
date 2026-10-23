// @vitest-environment jsdom
// Letters dragged out of the list onto a folder of the sidebar (letterDrag.svelte.ts). The engine's
// own drag never starts on Windows, so the press is followed by hand: the press, the movement past
// the slop, and the pointer up over a folder are what is tried here.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/webview", () => import("./testing").then((m) => m.webviewModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { dropTarget, letterDrag } from "./letterDrag.svelte";
import { app } from "./store.svelte";
import { api, flush, resetFakes, row } from "./testing";

/** A press of the left button in the list, as MessageList.svelte hands it over. */
function pressOn(target: Element, ids: number[] = [1, 2], account_id = "a", button = 0) {
  const e = new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, button });
  target.dispatchEvent(e);
  letterDrag.press(e as unknown as PointerEvent, ids, account_id);
}

const moveTo = (x: number, y: number) => window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));
const upOn = (el: Element) => el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

/** A row of the sidebar: FolderRow.svelte and FavouriteRow.svelte carry this much. */
function folderRow(account_id: string, folder: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "folder-row";
  el.dataset.account = account_id;
  el.dataset.folder = folder;
  el.dataset.dropFolder = folder;
  document.body.append(el);
  return el;
}

const listRow = () => document.body.append(document.createElement("div")) ?? document.body.lastElementChild!;

/** The move of the app, in place of the backend: the drop is where the two meet. */
let move: MockInstance<(folder: string, ids?: number[]) => Promise<void>>;

beforeEach(() => {
  resetFakes();
  // The pointer listeners are the window's own here, not the stand-ins for the backend's events.
  vi.unstubAllGlobals();
  api.move.mockImplementation(async (ids: number[]) => [{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ids.map(String), unseen: [], snoozed: [], waits: [] }]);
  app.list.messages = [row(1), row(2), row(3, { folder: "Archive" }), row(4, { account_id: "b" })];
  move = vi.spyOn(app.actions, "moveTo").mockResolvedValue(undefined);
});

afterEach(() => {
  // A drag left in hand would follow the next test's pointer.
  upOn(document.body);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("letters dragged onto a folder", () => {
  it("is no drag until the pointer travels: a press that stays is the list's click", () => {
    pressOn(listRow());
    moveTo(101, 101);
    expect(letterDrag.dragging).toBeNull();
    upOn(folderRow("a", "Archive"));
    expect(move).not.toHaveBeenCalled();
  });

  it("carries the letters of the press, and the folder under the pointer says where", async () => {
    pressOn(listRow());
    moveTo(200, 40);
    expect(letterDrag.dragging?.ids).toEqual([1, 2]);
    const archive = folderRow("a", "Archive");
    // The row of the sidebar says the pointer is over it (FolderRow.svelte).
    letterDrag.hover("a", "Archive");
    expect(letterDrag.dragging?.over).toBe("Archive");
    upOn(archive);
    expect(move).toHaveBeenCalledWith("Archive", [1, 2]);
    expect(letterDrag.dragging).toBeNull();
  });

  it("says which folder the pointer is over, and forgets the one it left", () => {
    folderRow("a", "Archive");
    pressOn(listRow());
    moveTo(200, 40);
    letterDrag.hover("a", "Archive");
    expect(letterDrag.dragging?.over).toBe("Archive");
    letterDrag.hover("a", "INBOX");
    letterDrag.left("a", "Archive");
    expect(letterDrag.dragging?.over).toBe("INBOX");
    letterDrag.left("a", "INBOX");
    expect(letterDrag.dragging?.over).toBeNull();
  });

  it("leaves the letters where they are, dropped on the folder they are in", () => {
    pressOn(listRow());
    moveTo(200, 40);
    upOn(folderRow("a", "INBOX"));
    expect(move).not.toHaveBeenCalled();
  });

  it("keeps the letters of one mailbox out of a folder of another", () => {
    pressOn(listRow());
    moveTo(200, 40);
    const other = folderRow("b", "Archive");
    letterDrag.hover("b", "Archive");
    expect(letterDrag.dragging?.over).toBeNull();
    upOn(other);
    expect(move).not.toHaveBeenCalled();
  });

  it("drops nothing anywhere but on a folder", () => {
    pressOn(listRow());
    moveTo(200, 40);
    upOn(document.body);
    expect(move).not.toHaveBeenCalled();
    expect(letterDrag.dragging).toBeNull();
  });

  it("carries the rows chosen with the pressed one", () => {
    pressOn(listRow(), [3, 7]);
    moveTo(200, 40);
    upOn(folderRow("a", "Archive"));
    expect(move).toHaveBeenCalledWith("Archive", [3, 7]);
  });
});

describe("the drop and the move of the app", () => {
  it("reaches the backend with the letters and the folder as they were", async () => {
    // The move itself, not a stand-in for it: the drop is where the two meet.
    move.mockRestore();
    pressOn(listRow());
    moveTo(200, 40);
    upOn(folderRow("a", "Archive"));
    await flush();
    expect(api.move.mock.calls[0]).toEqual([[1, 2], "Archive"]);
  });
});

describe("a press the list keeps for itself", () => {
  it("is no drag of a button of the row, nor of a press but the left one", () => {
    const count = document.createElement("button");
    pressOn(count);
    moveTo(200, 40);
    expect(letterDrag.dragging).toBeNull();
    pressOn(listRow(), [1], "a", 2);
    moveTo(200, 40);
    expect(letterDrag.dragging).toBeNull();
  });
});

describe("the folder a row of the sidebar stands for", () => {
  it("is its mailbox and its name, read from the row of a button inside it", () => {
    const rowEl = folderRow("a", "Archive");
    const inner = document.createElement("button");
    rowEl.append(inner);
    expect(dropTarget(inner)).toEqual({ account_id: "a", folder: "Archive" });
  });

  it("is nothing for a row of the list, or for nothing at all", () => {
    expect(dropTarget(listRow())).toBeNull();
    expect(dropTarget(null)).toBeNull();
    expect(dropTarget(document.body)).toBeNull();
  });
});
