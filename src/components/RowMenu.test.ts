// @vitest-environment jsdom
// The letter's menu offers a letter of the files alone (#97): «Переслать только вложения»
// opens a new letter with the letter's files and none of its text. A letter without files
// has no such item, and «Переслать» keeps the whole letter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import RowMenu from "./RowMenu.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { opened, row, settings } from "../lib/testing";
import type { AccountView, AttachmentInfo, MessageRow, OpenedMessage } from "../lib/types";

const account = { id: "a", label: "Я", display_name: "Я", email: "me@x" } as unknown as AccountView;

/** A letter with a file and a picture drawn in its text. */
const files: AttachmentInfo[] = [
  { index: 0, name: "счёт.pdf", mime: "application/pdf", size: 10, content_id: null, inline: false },
  { index: 1, name: "logo.png", mime: "image/png", size: 5, content_id: "logo", inline: true },
];

/** The letter as the pane has it open, with its files. */
function open(m: MessageRow): OpenedMessage {
  const msg = opened(m);
  return { ...msg, view: { ...msg.view, attachments: files } };
}

let view: ReturnType<typeof mount> | null = null;

function draw(m: MessageRow): HTMLElement {
  app.list.messages = [m];
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(RowMenu, { target, props: { at: { x: 10, y: 10 }, ids: [m.id], onclose: () => {} } });
  flushSync();
  return target;
}

/** The menu's item of these words; none when the menu does not offer it. */
function item(target: HTMLElement, label: string): HTMLElement | undefined {
  return [...target.querySelectorAll<HTMLElement>("button.mi")].find((b) => b.textContent?.trim().startsWith(label));
}

beforeEach(() => {
  i18n.lang = "ru";
  app.settingsCtl.settings = settings();
  app.mailboxes.accounts = [account];
  app.reader.opened = null;
  for (const w of [...app.compose.windows]) app.compose.close(w.id);
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.replaceChildren();
});

describe("forwarding the files alone", () => {
  it("is offered by a letter with files", () => {
    const target = draw(row(1, { has_attachments: true }));
    expect(item(target, "Переслать только вложения")).toBeTruthy();
  });

  it("is not offered by a letter without files", () => {
    const target = draw(row(1, { has_attachments: false }));
    expect(item(target, "Переслать")).toBeTruthy();
    expect(item(target, "Переслать только вложения")).toBeUndefined();
  });

  it("opens a new letter with the files and none of the text", async () => {
    const m = row(1, { has_attachments: true });
    const target = draw(m);
    app.reader.opened = open(m);
    item(target, "Переслать только вложения")!.click();
    flushSync();
    expect(app.compose.windows).toHaveLength(1);
    const d = app.compose.windows[0].draft;
    expect(d.subject).toBe("Letter 1 (вложения)");
    expect(d.text).toBe("");
    expect(d.to).toEqual([]);
    expect(d.in_reply_to).toBeNull();
    expect(d.attachments.map((a) => a.name)).toEqual(["счёт.pdf"]);
  });
});
