// @vitest-environment jsdom
// A queued letter whose draft cannot be read (#146): its own row, and one way out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () =>
  import("../lib/testing").then((m) => m.eventModule),
);
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: (await import("../lib/testing")).api,
}));

import { flushSync, mount, unmount } from "svelte";
import Outbox from "./Outbox.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api } from "../lib/testing";
import type { OutboxItem } from "../lib/types";

const item = (id: number, over: Partial<OutboxItem> = {}): OutboxItem => ({
  id,
  account_id: "a",
  draft: {
    from: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    text: "",
    html: null,
    format: "plain",
    in_reply_to: null,
    references: [],
    attachments: [],
  },
  broken: false,
  sending_started: 0,
  attempts: 0,
  next_attempt: 1,
  last_error: null,
  failed: false,
  created: 1,
  followup_secs: 0,
  followup: {} as OutboxItem["followup"],
  ...over,
});

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function show(items: OutboxItem[]) {
  app.mailboxes.outbox = items;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(Outbox, { target });
  flushSync();
}

beforeEach(() => {
  i18n.lang = "ru";
  api.outboxDiscard.mockReset();
  api.outboxDiscard.mockResolvedValue(undefined);
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  target?.remove();
});

describe("the outbox row of a damaged letter", () => {
  it("says so and offers only «Удалить»", () => {
    show([item(7, { broken: true, failed: true, last_error: "x" })]);
    expect(target.textContent).toContain("Повреждённое письмо");
    const buttons = [...target.querySelectorAll("button")].map((b) =>
      b.textContent?.trim(),
    );
    expect(buttons).toEqual(["Удалить"]);
  });

  it("speaks English in the English interface", () => {
    i18n.lang = "en";
    show([item(7, { broken: true, failed: true })]);
    expect(target.textContent).toContain("Damaged letter");
    expect(target.querySelector("button")?.textContent?.trim()).toBe("Delete");
  });

  it("is deleted by its button, which the keyboard reaches, and a good row has none", () => {
    show([item(7, { broken: true, failed: true }), item(8)]);
    target.querySelector("button")!.click();
    expect(api.outboxDiscard).toHaveBeenCalledWith(7);
    expect(target.querySelector("button")!.tabIndex).toBe(0);
    expect(target.querySelectorAll(".item").length).toBe(2);
    expect(
      [...target.querySelectorAll(".item:not(.broken) button")].map((b) =>
        b.textContent?.trim(),
      ),
    ).not.toContain("Удалить");
  });
});
