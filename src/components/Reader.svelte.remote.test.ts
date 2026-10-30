// @vitest-environment jsdom
// «Показать» over a letter with pictures read it again with the pictures allowed. The answer is
// another document, and the frame must be another iframe: WebKitGTK does not reload an iframe whose
// `srcdoc` changed (docs/dev-notes.md), so the letter would stay as it was until the next open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

// jsdom has no layout: the attachment strip listens for its own width through a ResizeObserver.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

import { flushSync, mount, tick, unmount } from "svelte";
import Reader from "./Reader.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, resetFakes, settings } from "../lib/testing";
import type { MessageRow, OpenedMessage } from "../lib/types";

const row = { id: 5, account_id: "a", folder: "INBOX", from: { name: "Банк", email: "bank@example.org" }, flags: { seen: true }, date: 1000 } as unknown as MessageRow;

/** The letter as the backend answers it: with the pictures only when it was allowed to. */
const opened = (allowRemote: boolean): OpenedMessage =>
  ({
    row,
    view: {
      summary: { message_id: null, subject: "Смета", from: { name: "Банк", email: "bank@example.org" }, to: [], cc: [], date: 1000 },
      attachments: [],
      text: "Смета.",
      html: allowRemote ? '<p>Смета.</p><img src="https://bank.example/p.png">' : "<p>Смета.</p>",
      has_remote_content: true,
      views: ["html"],
      calendar: null,
    },
    trusted_sender: false,
    sender_unverified: false,
    why_unverified: null,
    server_checks_sender: false,
  }) as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;

const frameOf = () => document.querySelector(".reader iframe");

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  app.settingsCtl.settings = settings();
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  app.reader.opened = opened(false);
  app.reader.conversation = [];
  app.reader.allowRemote = false;
  view = mount(Reader, { target: document.body, props: { onReply: () => {}, onForward: () => {} } });
  flushSync();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  app.reader.opened = null;
  app.reader.conversation = [];
  app.reader.allowRemote = false;
  document.body.innerHTML = "";
});

describe("«Показать» над письмом с внешними картинками", () => {
  it("рисует письмо заново, когда приходит его текст с картинками", async () => {
    // The frame the letter was opened in: no pictures, the policy keeps them out.
    const before = frameOf()!;
    expect(before.getAttribute("srcdoc")).toContain("img-src data: ;");
    expect(before.getAttribute("srcdoc")).not.toContain("bank.example");

    let release!: (msg: OpenedMessage) => void;
    api.open.mockImplementation(() => new Promise<OpenedMessage>((done) => (release = done)));

    const show = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Показать")!;
    expect(show).toBeTruthy();
    show.click();
    await tick();
    flushSync();

    // Between the click and the answer the frame is already another one: the letter is allowed now.
    const allowed = frameOf()!;
    expect(allowed).not.toBe(before);
    expect(allowed.getAttribute("srcdoc")).toContain("img-src data: https: http:;");

    release(opened(true));
    await tick();
    await tick();
    flushSync();

    // The answer is the letter's own text: it must reach the frame as a new document, not as a new
    // `srcdoc` of the frame that was drawn a moment ago.
    const drawn = frameOf()!;
    expect(drawn.getAttribute("srcdoc")).toContain("bank.example");
    expect(drawn).not.toBe(allowed);
  });
});
