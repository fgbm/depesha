import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AccountForm } from "./accountForm.svelte";
import { i18n } from "./i18n.svelte";
import { api, resetFakes } from "./testing";
import type { Account } from "./types";

const saved: Account = {
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

beforeEach(() => {
  resetFakes();
  i18n.lang = "en";
  api.accounts.mockResolvedValue([]);
});

describe("saving a mailbox's page", () => {
  it("saves a new signature without logging in, and keeps the colour", async () => {
    const done = vi.fn();
    const form = new AccountForm(saved, done);
    form.signatures = [{ id: "s1", name: "Work", html: "<div>Jane</div>", text: "Jane" }];
    form.defaultSignature = "s1";
    expect(form.needsCheck).toBe(false);
    await form.save();
    expect(api.accountCheck).not.toHaveBeenCalled();
    expect(api.accountSave).toHaveBeenCalledWith(expect.objectContaining({ signatures: [{ id: "s1", name: "Work", html: "<div>Jane</div>", text: "Jane" }], default_signature: "s1", color: "#9b59b6" }), null, null);
    expect(done).toHaveBeenCalled();
  });

  it("saves the mailbox's own format without logging in; «as in the settings» saves none", async () => {
    const form = new AccountForm({ ...saved, compose_format: "markdown" }, vi.fn());
    expect(form.composeFormat).toBe("markdown");
    form.composeFormat = "html";
    expect(form.needsCheck).toBe(false);
    expect(form.account().compose_format).toBe("html");
    form.composeFormat = "";
    expect("compose_format" in form.account()).toBe(false);
    await form.save();
    expect(api.accountCheck).not.toHaveBeenCalled();
  });

  it("checks the login first when a server changed", async () => {
    const form = new AccountForm(saved, () => {});
    form.smtp.port = 587;
    expect(form.needsCheck).toBe(true);
    await form.save();
    expect(api.accountCheck).toHaveBeenCalled();
    expect(api.accountSave).toHaveBeenCalled();
    expect(api.accountCheck.mock.invocationCallOrder[0]).toBeLessThan(api.accountSave.mock.invocationCallOrder[0]);
  });

  it("checks the login first when a password is typed", () => {
    const form = new AccountForm(saved, () => {});
    form.password = "secret";
    expect(form.needsCheck).toBe(true);
  });

  it("does not save what failed the check, and says which server failed", async () => {
    api.accountCheck.mockRejectedValue({ kind: "auth", message: "SMTP: login rejected" });
    const done = vi.fn();
    const form = new AccountForm(saved, done);
    form.smtp.host = "mail.example.com";
    await form.save();
    expect(api.accountSave).not.toHaveBeenCalled();
    expect(form.errorProto).toBe("SMTP");
    expect(done).not.toHaveBeenCalled();
  });

  it("always checks a new mailbox", () => {
    expect(new AccountForm(null, () => {}).needsCheck).toBe(true);
  });
});
