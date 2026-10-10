// @vitest-environment jsdom
// The form picked above a letter belongs to the letter open now: the same letter loaded again
// keeps it, another letter, or this one opened again after leaving it, shows the form asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import ReaderBody from "./ReaderBody.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { api, settings } from "../../lib/testing";
import { peopleBook } from "../../lib/peopleBook.svelte";
import type { OpenedMessage } from "../../lib/types";

const letter = (id: number) =>
  ({
    row: { id, account_id: "a", folder: "INBOX", marks: [], date: 1000, size: 10 },
    view: {
      summary: { subject: "Привет", from: { name: "Иван", email: "ivan@x.example" }, to: [], cc: [], date: 1000 },
      attachments: [],
      html: "<p>html</p>",
      text: "text",
      markdown: "# md",
      views: ["text", "markdown", "html"],
    },
  }) as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
const props = $state<{ msg: OpenedMessage; viewing: boolean }>({ msg: letter(1), viewing: false });
const on = () => target.querySelector(".segments button.on")?.textContent?.trim();
const pick = (label: string) => {
  [...target.querySelectorAll<HTMLButtonElement>(".segments button")].find((b) => b.textContent?.trim() === label)!.click();
  flushSync();
};

beforeEach(async () => {
  i18n.lang = "ru";
  api.people.mockResolvedValue([]);
  api.hints.mockResolvedValue([]);
  await peopleBook.refresh();
  app.settingsCtl.settings = settings();
  props.msg = letter(1);
  target = document.createElement("div");
  document.body.append(target);
  view = mount(ReaderBody, { target, props });
  flushSync();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the form picked above a letter", () => {
  it("starts as the sender meant, and is kept for the same letter loaded again", () => {
    expect(on()).toBe("HTML");
    pick("Текст");
    expect(on()).toBe("Текст");
    props.msg = letter(1);
    flushSync();
    expect(on()).toBe("Текст");
  });

  it("is not kept for another letter, nor for this one opened again after it", () => {
    pick("Текст");
    props.msg = letter(2);
    flushSync();
    expect(on()).toBe("HTML");
    props.msg = letter(1);
    flushSync();
    expect(on()).toBe("HTML");
  });
});
