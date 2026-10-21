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
import type { MessageRow, OpenedMessage } from "../../lib/types";

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
