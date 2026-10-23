// Letters dragged out of the list onto a folder of the sidebar. The engine's own drag does not
// start here: on Windows Tauri takes the WebView2 drag handler for the files a letter takes
// (dragDropEnabled in tauri.conf.json), and HTML5 drag and drop stays dead there. So the press is
// followed by hand: movement past SLOP makes it a drag, the folder under the pointer says where
// the letters go. Covered by letterDrag.test.ts.

import { app } from "./store.svelte";

/** How far the pointer travels before a press on a row becomes a drag, in pixels. */
const SLOP = 4;

/** What is dragged: the letters, their mailbox, and the folder under the pointer. */
export interface Drag {
  ids: number[];
  account_id: string;
  /** The folder of the sidebar the pointer is over; null between the rows. */
  over: string | null;
}

/** The folder a row of the sidebar stands for, or null: the row carries its mailbox and the name
 *  of a folder that takes letters. A label, a folder read-only and a heading take none. */
export function dropTarget(el: EventTarget | null): { account_id: string; folder: string } | null {
  const row = (el as Element | null)?.closest?.(".folder-row") as HTMLElement | null | undefined;
  const account_id = row?.dataset.account;
  const folder = row?.dataset.dropFolder;
  return account_id && folder ? { account_id, folder } : null;
}

class LetterDrag {
  /** The letters in hand; null when the pointer only walks. */
  dragging = $state<Drag | null>(null);
  private stop: (() => void) | null = null;

  /** A press on a row: the drag begins once the pointer has travelled SLOP pixels. */
  press(e: PointerEvent, ids: number[], account_id: string) {
    if (e.button !== 0 || !ids.length || !(e.target as Element | null)?.closest) return;
    // A button of the row (its thread counter) takes the press for itself.
    if ((e.target as Element).closest("button")) return;
    this.end();
    const x = e.clientX;
    const y = e.clientY;
    const move = (ev: PointerEvent) => {
      if (!this.dragging) {
        if (Math.abs(ev.clientX - x) < SLOP && Math.abs(ev.clientY - y) < SLOP) return;
        this.dragging = { ids, account_id, over: null };
      }
    };
    const up = (ev: PointerEvent) => this.drop(ev);
    window.addEventListener("pointermove", move);
    // Not in the capture phase: the row of a folder that takes the drop goes first.
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    this.stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }

  /** The pointer is over the folder `folder` of `account_id`: the letters go there if they are of it. */
  hover(account_id: string, folder: string) {
    const live = this.dragging;
    if (live && live.account_id === account_id) live.over = folder;
  }

  /** Forgets the folder the pointer left, so no folder stays lit behind it. */
  left(account_id: string, folder: string) {
    const live = this.dragging;
    if (live && live.account_id === account_id && live.over === folder) live.over = null;
  }

  /** The pointer comes up: over a folder of the letters' own mailbox, the letters go into it. */
  private drop(e: PointerEvent) {
    const live = this.dragging;
    this.end();
    if (!live) return;
    const to = dropTarget(e.target);
    if (!to || to.account_id !== live.account_id) return;
    // The folder the letters are in already: a drop there says nothing.
    if (live.ids.every((id) => app.list.messages.find((m) => m.id === id)?.folder === to.folder)) return;
    void app.actions.moveTo(to.folder, live.ids);
  }

  private end() {
    this.stop?.();
    this.stop = null;
    this.dragging = null;
  }
}

export const letterDrag = new LetterDrag();
