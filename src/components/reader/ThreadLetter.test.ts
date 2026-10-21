// @vitest-environment jsdom
// A letter unfolded in a conversation takes the height its own frame reports: the thread scrolls
// as one piece, and the letter gets no scroll of its own (#А7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import ThreadLetter from "./ThreadLetter.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { api, settings } from "../../lib/testing";
import { peopleBook } from "../../lib/peopleBook.svelte";
import type { MessageRow, OpenedMessage } from "../../lib/types";

const row: MessageRow = {
  id: 2,
  account_id: "a",
  folder: "INBOX",
  marks: [],
  date: 1000,
  size: 10,
  flags: { seen: true },
  from: { name: "Мария Соколова", email: "maria@example.org" },
} as unknown as MessageRow;

const opened = {
  row,
  view: {
    summary: { subject: "Бюджет", from: { name: "Мария Соколова", email: "maria@example.org" }, to: [], cc: [], date: 1000 },
    attachments: [],
    html: "<p>" + "Длинная смета. ".repeat(200) + "</p>",
    text: "Длинная смета.",
    views: ["text", "html"],
  },
  trusted_sender: false,
  sender_unverified: false,
  why_unverified: null,
} as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

const draw = () => {
  app.settingsCtl.settings = settings();
  target = document.createElement("div");
  document.body.append(target);
  view = mount(ThreadLetter, { target, props: { m: row, open: true, body: opened, onToggle() {}, onReply() {}, onForward() {} } });
  flushSync();
  return target.querySelector("iframe") as HTMLIFrameElement;
};

/** What the relay of a frame sends: its own height, from its own window or from a stranger's. */
function from(frame: HTMLIFrameElement, height: unknown, source: MessageEventSource | null = frame.contentWindow) {
  window.dispatchEvent(new MessageEvent("message", { data: { depeshaFrame: 1, type: "height", height }, source }));
  flushSync();
}

beforeEach(async () => {
  i18n.lang = "ru";
  api.people.mockResolvedValue([]);
  await peopleBook.refresh();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the height of a letter unfolded in a conversation", () => {
  it("follows the height its own frame reports, so the thread has one scroll", () => {
    const frame = draw();
    expect(frame.style.height).toBe("");
    // The card of a letter in a conversation has no floor of the pane's: that floor is what left
    // the frame its own scrollbar (#А7).
    expect(target.querySelector(".letter-body .body")?.classList.contains("fit")).toBe(true);
    from(frame, 2400);
    expect(frame.style.height).toBe("2400px");
    from(frame, 640);
    expect(frame.style.height).toBe("640px");
  });

  it("hears no height from a stranger's window, and none that is no height of a letter", () => {
    const frame = draw();
    from(frame, 2400);
    from(frame, 100, window);
    from(frame, 100, null);
    for (const height of ["2400", -1, 200_001, Number.NaN, null]) from(frame, height);
    expect(frame.style.height).toBe("2400px");
  });
});
