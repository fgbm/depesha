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
import { api, settings } from "../../lib/testing";
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

describe("saving every file of a letter (4.5, #111)", () => {
  const withFiles = (id: number) =>
    ({
      row: { id, account_id: "a" },
      view: {
        attachments: [
          { index: 0, name: "счёт.pdf", size: 2048, inline: false, content_id: null },
          { index: 1, name: "акт.pdf", size: 1024, inline: false, content_id: null },
        ],
      },
    }) as unknown as OpenedMessage;

  it("tells the toast which folder the files went to, not only how many there are", async () => {
    app.settingsCtl.settings = { ...settings(), attachments_dir: "/tmp/Мои вложения" };
    app.reader.opened = withFiles(1);
    api.attachmentsSaveAll.mockResolvedValue({ dir: "/tmp/Мои вложения", saved: 2 });
    const said: [number, string][] = [];
    const state = new AttachmentViewerState({
      savedAll: (n: number, dir: string) => void said.push([n, dir]),
    } as unknown as AttachmentViewerHost);
    await state.saveAll();
    // The folder from the settings goes without a dialog, and the answer names it.
    expect(api.pickFolder).not.toHaveBeenCalled();
    expect(api.attachmentsSaveAll).toHaveBeenCalledWith(1, null);
    expect(said).toEqual([[2, "/tmp/Мои вложения"]]);
  });
});
