// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import AccountPage from "./AccountPage.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { api, resetFakes, settings } from "../../lib/testing";
import type { Account, AccountView } from "../../lib/types";

const acc: Account = {
  id: "a",
  label: "Work",
  color: "",
  display_name: "Jane",
  email: "jane@example.com",
  username: "jane@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 465, security: "tls" },
  save_sent_copy: true,
  attachments_dir: "",
};

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
let stored: Account;

function open(over: Partial<Account> = {}) {
  stored = { ...acc, ...over };
  app.settings = { ...settings(), compose_format: "html" };
  app.accounts = [{ ...stored, status: null } as AccountView];
  api.accounts.mockImplementation(async () => [{ ...stored, status: null } as AccountView]);
  api.accountSave.mockImplementation(async (a: Account) => {
    stored = a;
    return a;
  });
  target = document.createElement("div");
  document.body.append(target);
  view = mount(AccountPage, { target, props: { account: app.accounts[0], onDone: vi.fn() } });
  flushSync();
}

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
});

afterEach(async () => {
  // jsdom cannot take a listener off the window of an open list: the page is gone with the document anyway.
  if (view) await Promise.resolve(unmount(view)).catch(() => {});
  view = null;
  document.body.innerHTML = "";
});

describe("a mailbox's page (#102, 1.7 Б and 3.1 В)", () => {
  it("has one button, for the connection, and it waits for a change of the connection", () => {
    open();
    const buttons = [...target.querySelectorAll<HTMLButtonElement>("footer .btn.primary")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain("Проверить и сохранить");
    expect(buttons[0].disabled).toBe(true);
    expect(target.querySelector("footer")?.textContent).not.toContain("Сохранить\n");
  });

  it("says what the mailbox follows once, in the list: no second mark beside it", () => {
    open();
    expect(target.querySelector(".compose-format")?.textContent).toContain("Как в общих — HTML");
    expect(target.querySelector(".chip")).toBeNull();
  });

  it("saves the format the moment it is picked, with no button and no question", async () => {
    vi.useFakeTimers();
    try {
      open();
      target.querySelector<HTMLElement>(".compose-format .trigger")!.click();
      flushSync();
      document.querySelector<HTMLElement>(".pop [role=option][data-value=markdown]")!.click();
      flushSync();
      await vi.advanceTimersByTimeAsync(800);
      expect(stored.compose_format).toBe("markdown");
      expect(target.querySelector("footer .mark")?.textContent).toContain("Сохранено");
    } finally {
      vi.useRealTimers();
    }
  });
});
