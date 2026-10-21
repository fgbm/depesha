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
  app.settingsCtl.settings = { ...settings(), compose_format: "html" };
  app.mailboxes.accounts = [{ ...stored, status: null } as AccountView];
  api.accounts.mockImplementation(async () => [{ ...stored, status: null } as AccountView]);
  api.accountSave.mockImplementation(async (a: Account) => {
    stored = a;
    return a;
  });
  api.accountPatchOwn.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
    stored = { ...stored, ...patch } as Account;
    return stored;
  });
  target = document.createElement("div");
  document.body.append(target);
  view = mount(AccountPage, { target, props: { account: app.mailboxes.accounts[0], onDone: vi.fn() } });
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
  it("saves a text when its field is left, not while it is typed in", async () => {
    vi.useFakeTimers();
    try {
      open();
      const input = target.querySelector<HTMLInputElement>("[data-settings='acc-label'] input")!;
      input.focus();
      input.value = "Home";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      await vi.advanceTimersByTimeAsync(3000);
      expect(stored.label).toBe("Work");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      expect(stored.label).toBe("Home");
    } finally {
      vi.useRealTimers();
    }
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
      await vi.advanceTimersByTimeAsync(200);
      expect(stored.compose_format).toBe("markdown");
      expect(target.querySelector(".account-page .mark")?.textContent).toContain("Сохранено");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a mailbox's page laid out as the general pages (0.8.12)", () => {
  it("shows «Check and save» only after the connection is changed, in its section (0.8.12, 3.2 А)", () => {
    open();
    const check = () => [...target.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.includes("Проверить и сохранить"));
    expect(check()).toHaveLength(0);
    expect(target.querySelector("footer")).toBeNull();
    const host = target.querySelector<HTMLInputElement>("[data-settings='acc-imap'] input")!;
    host.value = "imap2.example.com";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(check()).toHaveLength(1);
    expect(check()[0].closest("section[data-section='connection']")).not.toBeNull();
  });

  it("ends with the danger zone, the removal of the mailbox in it and outside the contents (0.8.12, 3.3 А)", () => {
    open();
    const sections = [...target.querySelectorAll<HTMLElement>(".scroller > section")];
    const last = sections.at(-1)!;
    expect(last.dataset.section).toBe("danger");
    expect(last.querySelector("h3")?.textContent).toBe("Опасная зона");
    expect([...last.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Удалить ящик"]);
    expect(target.querySelector(".toc a[data-toc='danger']")).toBeNull();
    expect([...target.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Удалить ящик")).toHaveLength(1);
  });

  it("asks before the removal, as before", () => {
    open();
    target.querySelector<HTMLElement>("section[data-section='danger'] button")!.click();
    flushSync();
    expect(app.ui.confirmation).not.toBeNull();
    expect(api.accountRemove).not.toHaveBeenCalled();
    app.ui.confirmation = null;
  });

  it("draws its fields as the rows of the general pages, the name at the left (0.8.12, 3.1 А)", () => {
    open();
    for (const id of ["acc-label", "acc-name", "acc-color", "acc-format", "acc-view", "acc-attachments", "acc-signatures", "acc-waiting", "acc-imap", "acc-smtp", "acc-login"]) {
      expect(target.querySelector(`.rw[data-settings='${id}']`), id).not.toBeNull();
    }
    expect(target.querySelector("input[disabled][value='jane@example.com']")).toBeNull();
  });
});

describe("a text typed in a mailbox's page and not left (#120)", () => {
  it("tells the app that a text is typed until the field is left, and gives it a way to write it (#120, 3)", async () => {
    vi.useFakeTimers();
    try {
      open();
      const input = target.querySelector<HTMLInputElement>("[data-settings='acc-label'] input")!;
      input.focus();
      input.value = "Home";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(app.ui.settingsTyping).toBe(true);
      // A quit does not wait for the focus to leave: it asks the page to write what is typed.
      await app.ui.settingsSettle!();
      expect(stored.label).toBe("Home");
      expect(app.ui.settingsTyping).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
