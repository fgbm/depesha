// @vitest-environment jsdom
// The long conversation around the opened letter is folded; «N more» unfolds it for this letter
// only, another letter folds it again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import Reader from "./Reader.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, resetFakes, settings } from "../lib/testing";
import type { MessageRow, OpenedMessage } from "../lib/types";

const row = (id: number) => ({ id, account_id: "a", folder: "INBOX", from: { name: `Автор ${id}`, email: `u${id}@x.example` }, flags: { seen: true }, date: 1000 + id }) as unknown as MessageRow;
const opened = (id: number): OpenedMessage =>
  ({
    row: row(id),
    view: { summary: { message_id: null, subject: "Тема", from: { name: "Иван", email: "ivan@x.example" }, to: [], cc: [], date: 1000 }, attachments: [], text: "text", views: ["text"] },
  }) as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;
const more = () => document.querySelectorAll(".card.more").length;

beforeEach(async () => {
  resetFakes();
  i18n.lang = "ru";
  app.settings = settings();
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  const chain = [1, 2, 3, 4, 5, 6, 7].map(row);
  app.reader.opened = opened(7);
  app.reader.conversation = chain;
  view = mount(Reader, { target: document.body, props: { onReply() {}, onForward() {} } });
  flushSync();
});
afterEach(async () => {
  // jsdom cannot take a listener off the window of an open list: the page is gone with the document anyway.
  if (view) await Promise.resolve(unmount(view)).catch(() => {});
  view = null;
  app.reader.opened = null;
  app.reader.conversation = [];
  document.body.innerHTML = "";
});

describe("the folded conversation", () => {
  it("unfolds with «N more» and folds again when another letter opens, whatever its Message-ID", () => {
    expect(more()).toBe(1);
    document.querySelector<HTMLButtonElement>(".card.more")!.click();
    flushSync();
    expect(more()).toBe(0);
    app.reader.opened = opened(6);
    flushSync();
    expect(more()).toBe(1);
  });

  it("stays unfolded when the same letter is loaded again", () => {
    document.querySelector<HTMLButtonElement>(".card.more")!.click();
    flushSync();
    app.reader.opened = opened(7);
    flushSync();
    expect(more()).toBe(0);
  });
});
