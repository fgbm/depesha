// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import MessageList from "./MessageList.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, settings } from "../lib/testing";
import type { AccountView, MessageRow } from "../lib/types";

// jsdom has no layout: `bind:clientHeight` listens through a ResizeObserver.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const account = { id: "a", label: "Я", display_name: "Я", email: "me@x" } as unknown as AccountView;
const row = (id: number, from: string, over: Partial<MessageRow> = {}): MessageRow =>
  ({
    id, account_id: "a", folder: "INBOX", uid: id, message_id: `<${id}@x>`, in_reply_to: null, references: [], subject: `Тема ${id}`,
    from: { name: null, email: from }, to: [{ name: null, email: "me@x" }], cc: [], reply_to: [], date: 1000 + id, size: 10,
    flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false },
    has_attachments: false, thread: `t${id}`, bulk: false, thread_count: 1, thread_date: 1000 + id, thread_senders: [], thread_draft: false,
    snoozed_until: null, followup_due: null, dmarc: false, thread_voices: [], ...over,
  }) as MessageRow;

let view: ReturnType<typeof mount> | null = null;
function draw(rows: MessageRow[], over: object = {}) {
  app.settings = { ...settings(), ...over };
  app.accounts = [account];
  app.list.messages = rows;
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(MessageList, { target, props: { searchInput: null } });
  flushSync();
  return target;
}

beforeEach(() => {
  i18n.lang = "ru";
  api.avatar.mockReset();
  api.avatar.mockResolvedValue(null);
  app.selected = new Set();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the pictures of the list (#108)", () => {
  it("draws a circle in every row: initials until the logo comes", async () => {
    const t = draw([row(1, "first@one.example", { dmarc: true, from: { name: "Озон Банк", email: "first@one.example" } })]);
    await tick();
    expect(t.querySelector(".row .pic")?.textContent?.trim()).toBe("ОБ");
    expect(t.querySelector(".row")?.classList.contains("avatars")).toBe(true);
  });

  it("asks for a company logo only for a sender the server vouched for, and only with the logos on", async () => {
    draw([row(1, "ozon@two.example", { dmarc: true }), row(2, "ivan@two.example")]);
    await tick();
    expect(api.avatar).toHaveBeenCalledWith("a", "ozon@two.example", true);
    expect(api.avatar).toHaveBeenCalledWith("a", "ivan@two.example", false);
  });

  it("never lets the network in when the logos are off: the circle asks without the brand flag", async () => {
    draw([row(1, "ozon@three.example", { dmarc: true })], { sender_logos: false });
    await tick();
    expect(api.avatar).toHaveBeenCalledWith("a", "ozon@three.example", false);
    expect(api.avatar).not.toHaveBeenCalledWith("a", "ozon@three.example", true);
  });

  it("draws nothing and asks nothing with the avatars of the list off", async () => {
    const t = draw([row(1, "ozon@four.example", { dmarc: true })], { list_avatars: false });
    await tick();
    expect(t.querySelector(".pic")).toBeNull();
    expect(t.querySelector(".row")?.classList.contains("avatars")).toBe(false);
    expect(api.avatar).not.toHaveBeenCalled();
  });

  it("puts a tick in the place of the circle of a chosen row, and does not leave the circle beside it", async () => {
    const t = draw([row(1, "a@x.example"), row(2, "b@x.example")]);
    app.selected = new Set([2]);
    flushSync();
    const rows = t.querySelectorAll(".row");
    expect(rows[0].querySelector(".pic")).not.toBeNull();
    expect(rows[1].querySelector(".pic")).toBeNull();
    expect(rows[1].querySelector(".pick.round")).not.toBeNull();
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the tick in the strip at the left of the text when the circles are off: the text does not move", () => {
    const t = draw([row(1, "a@x.example")], { list_avatars: false });
    app.selected = new Set([1]);
    flushSync();
    expect(t.querySelector(".row .pick")).not.toBeNull();
    expect(t.querySelector(".row .pick.round")).toBeNull();
  });

  it("makes the circle neither a control nor a stop of the keyboard", () => {
    const t = draw([row(1, "a@x.example")]);
    const pic = t.querySelector(".row .pic")!;
    expect(pic.querySelector("button, a, [tabindex], input")).toBeNull();
    expect(pic.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(t.querySelectorAll("[role='option']").length).toBe(1);
  });
});

describe("the unread state without the dot (#108)", () => {
  it("is part of the name of an unread row and absent from the name of a read one", () => {
    const unseen = { seen: false, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false };
    const t = draw([row(1, "a@x.example", { flags: unseen }), row(2, "b@x.example")]);
    const [unread, read] = [...t.querySelectorAll<HTMLElement>(".row")];
    expect(unread.textContent).toMatch(/^Не прочитано, /);
    expect(read.textContent).not.toContain("Не прочитано");
  });
});
