// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import ReaderHeader from "./ReaderHeader.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { settings } from "../../lib/testing";
import type { Importance, OpenedMessage } from "../../lib/types";

const opened = (importance: Importance): OpenedMessage =>
  ({
    row: { id: 1, account_id: "a", folder: "INBOX", marks: [], date: 1000, size: 10, importance },
    view: {
      summary: { subject: "Срочно", from: { name: "Иван", email: "ivan@x.example" }, to: [], cc: [], date: 1000, importance },
      attachments: [],
    },
  }) as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;
function draw(msg: OpenedMessage) {
  app.settingsCtl.settings = settings();
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(ReaderHeader, {
    target,
    props: { msg, picture: null, account: undefined, files: [], viewing: false, viewingAt: 0, onViewAttachment() {}, onSaveAttachment() {}, onSaveAttachmentAs() {}, onSaveAll() {}, saveDir: "" },
  });
  flushSync();
  return target;
}

beforeEach(() => {
  i18n.lang = "ru";
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the importance in the header of a letter (#72, 2.1 Б)", () => {
  it("is a line in the block of marks and nothing at the subject", () => {
    const t = draw(opened("high"));
    expect(t.querySelector(".marks .important")?.textContent?.trim()).toBe("! Отправитель отметил как важное");
    expect(t.querySelector("h1")?.textContent).toBe("Срочно");
  });

  it("is absent for a normal letter and for a low one", () => {
    for (const level of ["normal", "low"] as const) {
      const t = draw(opened(level));
      expect(t.querySelector(".important")).toBeNull();
      unmount(view!);
      view = null;
      document.body.innerHTML = "";
    }
  });
});
