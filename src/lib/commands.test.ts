import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { coreCommands } from "./commands";
import { app } from "./store.svelte";
import { i18n } from "./i18n.svelte";
import { api, opened, resetFakes, row } from "./testing";
import type { AttachmentInfo, FolderInfo, Notice } from "./types";

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

const ics: AttachmentInfo = { index: 4, name: "invite.ics", mime: "text/calendar", size: 2600, content_id: null, inline: false };

const invite = (over: Partial<Notice> = {}, link: string | null = "https://meet.example.org/room-1"): Notice => ({
  method: "request",
  cancelled: false,
  sequence: 0,
  file: 4,
  problem: null,
  previous: null,
  events: [
    {
      uid: "u1@example.org",
      sequence: 0,
      title: "Планёрка по выпуску",
      cancelled: false,
      start: { year: 2026, month: 11, day: 6, hour: 15, minute: 0, all_day: false, zone: "Europe/Moscow", offset: 3 * 3600 },
      end: { year: 2026, month: 11, day: 6, hour: 16, minute: 0, all_day: false, zone: "Europe/Moscow", offset: 3 * 3600 },
      all_day: false,
      location: "Переговорная 2",
      link,
      organizer: { name: "Анна Соколова", email: "anna@example.org" },
      attendees: [],
      repeat: null,
      description: "",
    },
  ],
  ...over,
});

/** The open letter, with the calendar of the meeting and the file it came as. */
function meetingLetter(notice: Notice | null, files: AttachmentInfo[] = notice ? [ics] : []): void {
  const o = opened(row(7, { folder: "INBOX" }));
  o.view = { ...o.view, attachments: files, calendar: notice };
  app.reader.opened = o;
}

describe("the card's actions in the palette (0.8.13, 1.1 А)", () => {
  it("offers the calendar, the file and the link of the open letter's meeting", () => {
    meetingLetter(invite());
    const ids = coreCommands().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["core.meeting-add", "core.meeting-save", "core.meeting-link"]));
  });

  it("hands the file to the calendar of the system, not to one of its own", () => {
    meetingLetter(invite());
    coreCommands()
      .find((c) => c.id === "core.meeting-add")!
      .run();
    expect(api.attachmentOpen).toHaveBeenCalledWith(7, 4);
  });

  it("saves the file of a cancelled meeting but offers neither the calendar nor the link", () => {
    meetingLetter(invite({ method: "cancel", cancelled: true }));
    const ids = coreCommands().map((c) => c.id);
    expect(ids).not.toContain("core.meeting-add");
    expect(ids).not.toContain("core.meeting-link");
    expect(ids).toContain("core.meeting-save");
  });

  it("says nothing of a meeting when the letter holds none", () => {
    meetingLetter(null);
    const ids = coreCommands().map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("core.meeting-"))).toEqual([]);
  });
});
