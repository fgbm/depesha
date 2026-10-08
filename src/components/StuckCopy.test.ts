import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { render } from "svelte/server";
import StuckCopy from "./StuckCopy.svelte";
import { i18n } from "../lib/i18n.svelte";
import type { Task } from "../lib/types";

const task: Task = {
  key: "stuck-copy:7",
  kind: "stuck-copy",
  account_id: "a",
  label: "Копия не сохранена: «Договор, правки»",
  done: 0,
  total: 0,
  state: "failed",
  error: { kind: "other", message: "IMAP: refused: [OVERQUOTA] Mailbox is full" },
  started: 1,
};

beforeEach(() => {
  i18n.lang = "ru";
});

describe("the task of a copy the server refuses (#88)", () => {
  it("says in plain words that the letter went, shows the server's reason and offers the three actions", () => {
    const { body } = render(StuckCopy, { props: { task } });
    expect(body).toContain("Копия не сохранена: «Договор, правки»");
    expect(body).toContain("Письмо адресату ушло");
    expect(body).toContain("перестала пробовать после 3 отказов");
    expect(body).toContain("[OVERQUOTA] Mailbox is full");
    expect(body).toContain("Повторить");
    expect(body).toContain("Сохранить .eml");
    expect(body).toContain("Не сохранять копию");
    expect(body).toContain('data-copy="7"');
  });

  it("speaks English in the English interface", () => {
    i18n.lang = "en";
    const { body } = render(StuckCopy, { props: { task } });
    expect(body).toContain("Retry");
    expect(body).toContain("Save .eml");
    expect(body).toContain("Don't keep the copy");
  });
});
