// @vitest-environment jsdom
// The viewer of an attachment belongs to the letter it was opened on: another letter opened
// closes it, and the first letter opened again shows its text, not the old attachment.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync } from "svelte";
import { app } from "../../lib/store.svelte";
import type { OpenedMessage } from "../../lib/types";
import { AttachmentViewerState, type AttachmentViewerHost } from "./useAttachmentViewer.svelte";

const letter = (id: number) => ({ row: { id, account_id: "a" }, view: { attachments: [] } }) as unknown as OpenedMessage;

let stop = () => {};
afterEach(() => {
  stop();
  app.reader.opened = null;
});

describe("the attachment viewer", () => {
  it("closes when another letter opens, and stays closed when the first one comes back", () => {
    app.reader.opened = letter(1);
    let state!: AttachmentViewerState;
    stop = $effect.root(() => {
      state = new AttachmentViewerState({} as AttachmentViewerHost);
    });
    state.viewingId = 1;
    flushSync();
    expect(state.viewing).toBe(true);
    app.reader.opened = letter(2);
    flushSync();
    expect(state.viewing).toBe(false);
    app.reader.opened = letter(1);
    flushSync();
    expect(state.viewing).toBe(false);
  });

  it("stays open while the same letter is read again", () => {
    app.reader.opened = letter(1);
    let state!: AttachmentViewerState;
    stop = $effect.root(() => {
      state = new AttachmentViewerState({} as AttachmentViewerHost);
    });
    state.viewingId = 1;
    app.reader.opened = letter(1);
    flushSync();
    expect(state.viewing).toBe(true);
  });

  it("keeps what was written while nothing read it, for the reader that comes later", () => {
    app.reader.opened = letter(1);
    let state!: AttachmentViewerState;
    const seen: boolean[] = [];
    let drop = () => {};
    stop = $effect.root(() => {
      state = new AttachmentViewerState({} as AttachmentViewerHost);
      drop = $effect.root(() => {
        $effect(() => void seen.push(state.viewing));
      });
    });
    flushSync();
    drop();
    state.viewingId = 1;
    flushSync();
    const late = $effect.root(() => {
      $effect(() => void seen.push(state.viewing));
    });
    flushSync();
    late();
    expect(seen).toEqual([false, true]);
    expect(state.viewing).toBe(true);
  });
});
