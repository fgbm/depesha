import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { render } from "svelte/server";
import LabelPicker from "./LabelPicker.svelte";
import { i18n } from "../lib/i18n.svelte";
import { labels } from "../lib/labels.svelte";
import type { MessageRow } from "../lib/types";

const row = (account: string, folder: string, keywords: string[] = []) => ({ id: 1, account_id: account, folder, keywords }) as unknown as MessageRow;

beforeEach(() => {
  i18n.lang = "ru";
  labels.all = {};
});

describe("the labels picker (#42, frame 10)", () => {
  it("shows an empty state and the create form when the mailbox has no labels yet", () => {
    const { body } = render(LabelPicker, { props: { rows: [row("a", "INBOX")] } });
    expect(body).toContain("Меток пока нет");
    expect(body).toContain("Новая метка…");
    expect(body).toContain("Создать");
  });

  it("lists the mailbox's labels with a checkbox", () => {
    labels.all = { a: [{ name: "Счета", keyword: "depesha-scheta", color: "#d0573f" }] };
    const { body } = render(LabelPicker, { props: { rows: [row("a", "INBOX", ["depesha-scheta"])] } });
    expect(body).toContain("Счета");
    expect(body).toContain("checked");
  });
});
