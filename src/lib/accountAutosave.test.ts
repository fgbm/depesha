import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AccountForm } from "./accountForm.svelte";
import { AccountAutosave } from "./accountAutosave.svelte";
import { i18n } from "./i18n.svelte";
import { app } from "./store.svelte";
import { api, resetFakes } from "./testing";
import type { Account, AccountView } from "./types";

const base: Account = {
  id: "a",
  label: "Work",
  color: "#9b59b6",
  display_name: "Jane",
  email: "jane@example.com",
  username: "jane@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 465, security: "tls" },
  save_sent_copy: true,
  attachments_dir: "",
};

/** The backend keeps what is saved and answers with it, as the real one does. */
function backend(initial: Account) {
  let stored: Account = initial;
  api.accounts.mockImplementation(async () => [{ ...stored, status: null } as AccountView]);
  api.accountSave.mockImplementation(async (acc: Account) => {
    stored = acc;
    return acc;
  });
  app.accounts = [{ ...stored, status: null } as AccountView];
  return () => stored;
}

function open(acc: Account = base) {
  const stored = backend(acc);
  const form = new AccountForm(acc, vi.fn());
  const own = new AccountAutosave(form, acc.id);
  return { form, own, stored };
}

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers();
  i18n.lang = "ru";
  app.confirm = vi.fn(async () => false) as unknown as typeof app.confirm;
});

afterEach(() => vi.useRealTimers());

describe("a mailbox's page saves what is not the connection as it is changed (#102, 1.7 Б)", () => {
  it("saves the format without a button, and says so at the row", async () => {
    const { form, own, stored } = open();
    form.composeFormat = "markdown";
    own.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(api.accountCheck).not.toHaveBeenCalled();
    expect(stored().compose_format).toBe("markdown");
    expect(own.auto.marks.account).toBe("saved");
  });

  it("saves nothing on opening, nor when the fields still say what they said", async () => {
    const { own } = open({ ...base, signatures: [{ id: "s", name: "W", html: "<p>x</p>", text: "x" }], quota_limit_mb: 1000 });
    own.touch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.accountSave).not.toHaveBeenCalled();
  });

  it("waits for the typing to pause: one write for a name typed in several letters", async () => {
    const { form, own, stored } = open();
    for (const name of ["J", "Ja", "Jan"]) {
      form.name = name;
      own.touch();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(api.accountSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(api.accountSave).toHaveBeenCalledTimes(1);
    expect(stored().display_name).toBe("Jan");
  });

  it("does not write a connection that was changed, even when something else is saved with it", async () => {
    const { form, own, stored } = open();
    form.imap.host = "other.example.com";
    form.composeFormat = "html";
    own.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(stored().compose_format).toBe("html");
    expect(stored().imap.host).toBe("imap.example.com");
    expect(form.connectionDirty).toBe(true);
  });

});

describe("leaving and taking back (#102, 1.7 Б)", () => {
  it("does not ask on leaving when only the other settings changed; it asks for a connection changed and not saved", async () => {
    const { form } = open();
    form.composeFormat = "html";
    expect(await form.mayLeave()).toBe(true);
    expect(app.confirm).not.toHaveBeenCalled();
    form.smtp.port = 25;
    expect(await form.mayLeave()).toBe(false);
    expect(app.confirm).toHaveBeenCalledTimes(1);
  });

  it("writes what is typed before the page is left", async () => {
    const { form, stored } = open();
    form.label = "Home";
    expect(await form.mayLeave()).toBe(true);
    expect(stored().label).toBe("Home");
  });

  it("takes the last change back and puts the fields as they were", async () => {
    const { form, own, stored } = open();
    form.composeFormat = "markdown";
    own.touch();
    await vi.advanceTimersByTimeAsync(700);
    expect(await own.undo()).toBe(true);
    expect(stored().compose_format).toBeUndefined();
    expect(form.composeFormat).toBe("");
    expect(own.auto.marks.account).toBe("undone");
    // The fields that came back are not a change to be saved again.
    own.touch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.accountSave).toHaveBeenCalledTimes(2);
  });

  it("does not save again a value the backend wrote down in its own shape", async () => {
    const { form, own } = open();
    api.accountSave.mockImplementation(async (acc: Account) => {
      app.accounts = [{ ...acc, attachments_dir: "/home/jane/Downloads", status: null } as AccountView];
      return acc;
    });
    api.accounts.mockImplementation(async () => app.accounts);
    form.attachmentsDir = "~/Downloads";
    own.touch();
    await vi.advanceTimersByTimeAsync(700);
    own.touch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.accountSave).toHaveBeenCalledTimes(1);
  });

  it("checks the login only by the connection's own button", async () => {
    const { form } = open();
    form.composeFormat = "html";
    expect(form.connectionDirty).toBe(false);
    form.password = "new";
    expect(form.connectionDirty).toBe(true);
    form.revertConnection();
    expect(form.connectionDirty).toBe(false);
  });
});
