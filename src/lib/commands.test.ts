import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { coreCommands } from "./commands";
import { app } from "./store.svelte";
import { i18n } from "./i18n.svelte";
import { opened, resetFakes, row } from "./testing";
import type { FolderInfo } from "./types";

const folder = (name: string, role: FolderInfo["role"]): FolderInfo =>
  ({ account_id: "a", name, display_name: name, delimiter: "/", role, selectable: true, hidden: false, total: 1, unread: 0 }) as FolderInfo;

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
});
afterEach(() => {
  app.reader.opened = null;
  app.mailboxes.folders = [];
});

describe("the moves the palette offers (А8)", () => {
  it("leaves out the letter's own folder and the folders a letter is not moved into by hand", () => {
    app.mailboxes.folders = [
      folder("INBOX", "inbox"),
      folder("Archive", "archive"),
      folder("Snoozed", "snoozed"),
      folder("Drafts", "drafts"),
      folder("Sent", "sent"),
      folder("Trash", "trash"),
      folder("Work", null),
    ];
    app.reader.opened = opened(row(1, { folder: "INBOX" }));
    const moves = coreCommands().filter((c) => c.id.startsWith("core.move."));
    expect(moves.map((c) => c.id)).toEqual(["core.move.Archive", "core.move.Trash", "core.move.Work"]);
  });
});
