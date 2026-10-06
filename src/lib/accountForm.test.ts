import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AccountForm } from "./accountForm.svelte";
import { i18n } from "./i18n.svelte";
import { app } from "./store.svelte";
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

describe("detecting the servers", () => {
  it("shows why Exchange was not found instead of failing silently", async () => {
    api.exchangeDetect.mockRejectedValue({ kind: "network", message: "EWS: no autodiscover" });
    const form = new AccountForm(null, () => {});
    form.startExchange();
    form.email = "jane@example.com";
    form.password = "secret";
    await form.next();
    expect(form.error?.message).toBe("EWS: no autodiscover");
    expect(form.step).toBe("start");
    expect(form.busy).toBe(false);
  });

  it("shows why the IMAP servers were not found", async () => {
    api.detect.mockRejectedValue({ kind: "network", message: "offline" });
    const form = new AccountForm(null, () => {});
    form.email = "jane@example.com";
    form.password = "secret";
    await form.next();
    expect(form.error?.message).toBe("offline");
    expect(form.busy).toBe(false);
  });
});

describe("leaving a mailbox's page", () => {
  it("is not dirty as opened, and is after a change, a password or a sign-in", () => {
    const form = new AccountForm({ ...saved, signatures: [{ id: "s1", name: "Work", html: "<div>Jane</div>", text: "Jane" }] }, () => {});
    expect(form.dirty).toBe(false);
    form.signatures[0].text = "J.";
    expect(form.dirty).toBe(true);
    form.signatures[0].text = "Jane";
    expect(form.dirty).toBe(false);
    form.password = "secret";
    expect(form.dirty).toBe(true);
    form.password = "";
    form.grant = "g1";
    expect(form.dirty).toBe(true);
  });

  it("leaves an untouched page without asking", async () => {
    expect(await new AccountForm(saved, () => {}).mayLeave()).toBe(true);
    expect(app.confirmation).toBeNull();
  });

  it("asks before the changes are lost, and stays when told so", async () => {
    const form = new AccountForm(saved, () => {});
    form.name = "Jane Doe";
    const left = form.mayLeave();
    expect(app.confirmation?.text).toBe("The mailbox's page has unsaved changes. Leave without them?");
    app.confirmation?.resolve(false);
    expect(await left).toBe(false);
  });

  it("does not leave while a check or a sign-in is under way", async () => {
    const form = new AccountForm(saved, () => {});
    form.busy = true;
    expect(await form.mayLeave()).toBe(false);
    expect(app.confirmation).toBeNull();
  });
});
