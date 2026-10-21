// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import Conversation from "./Conversation.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { api, settings } from "../../lib/testing";
import type { AttachmentInfo, MessageRow, Notice, OpenedMessage } from "../../lib/types";

const row = (id: number): MessageRow =>
  ({ id, account_id: "a", folder: "INBOX", marks: [], date: 1000, size: 10, flags: { seen: true }, from: { name: "Банк", email: "security@bank.ru" } }) as unknown as MessageRow;

const opened = (id: number, extra: Partial<OpenedMessage>): OpenedMessage =>
  ({
    row: row(id),
    view: { summary: { subject: "Hi", from: { name: "Банк", email: "security@bank.ru" }, to: [], cc: [], date: 1000 }, attachments: [] },
    trusted_sender: false,
    sender_unverified: true,
    why_unverified: null,
    ...extra,
  }) as unknown as OpenedMessage;

const flush = () => new Promise((r) => setTimeout(r, 0));

const ics: AttachmentInfo = { index: 3, name: "invite.ics", mime: "text/calendar", size: 2600, content_id: null, inline: false };

const invite: Notice = {
  method: "request",
  cancelled: false,
  sequence: 0,
  file: 3,
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
      link: null,
      organizer: { name: "Анна Соколова", email: "anna@example.org" },
      attendees: [],
      repeat: null,
      description: "",
    },
  ],
};

/** A letter with a calendar and its files; without one it has its files alone. */
function letter(id: number, calendar: Notice | null, files: AttachmentInfo[] = []): OpenedMessage {
  const o = opened(id, {});
  o.view = { ...o.view, attachments: files, calendar };
  return o;
}

let view: ReturnType<typeof mount> | null = null;
function draw(messages: MessageRow[], focusId: number) {
  app.settingsCtl.settings = settings();
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(Conversation, { target, props: { messages, focusId, onReply() {}, onForward() {} } });
  flushSync();
  return target;
}

beforeEach(() => {
  i18n.lang = "ru";
  vi.clearAllMocks();
  api.people.mockResolvedValue([]);
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("a letter unfolded in the conversation (#167)", () => {
  it("checks a trusted sender the mailbox's server said nothing about", async () => {
    api.open.mockResolvedValueOnce(opened(2, { why_unverified: "checking" })).mockResolvedValueOnce(opened(2, { trusted_sender: true, sender_unverified: false }));
    api.checkSender.mockResolvedValue(true);
    const t = draw([row(2), row(1)], 1);
    t.querySelector<HTMLButtonElement>(".head")!.click();
    await flush();
    await flush();
    expect(api.checkSender).toHaveBeenCalledWith(2);
    expect(api.open).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a sender that needs no check", async () => {
    api.open.mockResolvedValue(opened(2, { why_unverified: "server" }));
    const t = draw([row(2), row(1)], 1);
    t.querySelector<HTMLButtonElement>(".head")!.click();
    await flush();
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.checkSender).not.toHaveBeenCalled();
  });
});

describe("a letter of the conversation with a meeting invitation (0.8.13, 1.1 А)", () => {
  it("stands as the card of the meeting, and its .ics is no chip", async () => {
    api.open.mockResolvedValue(letter(2, invite, [ics]));
    const t = draw([row(2), row(1)], 1);
    t.querySelector<HTMLButtonElement>(".head")!.click();
    await flush();
    expect(t.querySelector(".cal-t")?.textContent).toBe("Планёрка по выпуску");
    expect(t.querySelector(".cal-h")?.textContent).toContain("Приглашение");
    // The file's place is the card's: the chip below would say the same thing twice.
    expect(t.querySelector(".file")).toBeNull();
    expect([...t.querySelectorAll<HTMLElement>(".cal-a .btn")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toContain(
      "Добавить в календарь",
    );
  });

  it("keeps the chip of a file that is no meeting", async () => {
    api.open.mockResolvedValue(letter(2, null, [{ ...ics, name: "отчёт.pdf", mime: "application/pdf" }]));
    const t = draw([row(2), row(1)], 1);
    t.querySelector<HTMLButtonElement>(".head")!.click();
    await flush();
    expect(t.querySelector(".cal")).toBeNull();
    expect(t.querySelector(".file")?.textContent).toContain("отчёт.pdf");
  });
});
