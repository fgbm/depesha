// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import ReaderToolbar from "./ReaderToolbar.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { shortcuts } from "../../lib/shortcuts.svelte";
import { settings } from "../../lib/testing";
import type { OpenedMessage } from "../../lib/types";
import type { KeySettings } from "../../lib/types";

// The "More" menu shows the keys the user set, not the letters of the defaults (0.8.2).

const opened = {
  row: { id: 1, account_id: "a", folder: "INBOX", marks: [], date: 1000, size: 10, flags: { seen: true, flagged: false } },
  view: { summary: { subject: "Тема", from: { name: "Иван", email: "ivan@x.example" }, to: [], cc: [], date: 1000 }, attachments: [] },
} as unknown as OpenedMessage;

let view: ReturnType<typeof mount> | null = null;
let saved: KeySettings = { custom: {}, dismissed: [] };

function menu(): string[] {
  app.settingsCtl.settings = settings();
  const target = document.createElement("div");
  document.body.append(target);
  const nav = createRawSnippet(() => ({ render: () => "<span></span>" }));
  view = mount(ReaderToolbar, { target, props: { msg: opened, account: undefined, isDraft: false, message: null, nav } });
  flushSync();
  (target.querySelector("button[aria-label='Ещё']") as HTMLButtonElement | null ?? target.querySelectorAll("button.icon")[1] as HTMLButtonElement).click();
  flushSync();
  return [...document.querySelectorAll(".mi")].map((b) => b.textContent!.replace(/\s+/g, " ").trim());
}

beforeEach(() => {
  saved = { custom: {}, dismissed: [] };
  shortcuts.use(() => saved);
  i18n.lang = "ru";
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("keys in the menu «More» of the letter", () => {
  it("shows the default keys of the commands", () => {
    const items = menu();
    expect(items).toContain("Поставить флагsы");
    expect(items).toContain("Отметить непрочитаннымuг");
    expect(items).toContain("Это спам!");
  });

  it("shows a key the user gave to a command", () => {
    saved = { custom: { "core.flag": ["Shift+f"], "core.spam": [], "core.unread": ["x"] }, dismissed: [] };
    const items = menu();
    expect(items).toContain("Поставить флагShift+FА");
    expect(items).toContain("Отметить непрочитаннымxч");
    // A command without a key shows none: the «!» of the defaults is gone.
    expect(items).toContain("Это спам");
  });
});

describe("no key letters written into the menus of actions", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), "src/components", f), "utf8");
  for (const f of ["reader/ReaderToolbar.svelte", "RowMenu.svelte", "FolderMenu.svelte", "AttachmentMenu.svelte"]) {
    it(`${f} puts keys only through <Keys>`, () => {
      const src = read(f);
      // A hint span whose content is a literal text of one or two characters or a plus-joined key.
      expect(src).not.toMatch(/<span class="hint">\s*[^<{\s][^<{]{0,12}<\/span>/);
      expect(src).not.toMatch(/<kbd[ >]/);
    });
  }
});
