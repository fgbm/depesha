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

describe("signing in through the browser", () => {
  beforeEach(() => {
    api.oauthProviders.mockResolvedValue([
      { provider: "google", title: "Google", configured: true },
      { provider: "yandex", title: "Yandex", configured: true },
    ]);
  });

  /** A sign-in that waits for the browser until cancelled, as oauth_sign_in does. */
  function waitingBrowser() {
    let cancel = () => {};
    api.oauthCancel.mockImplementation(async () => cancel());
    return () =>
      new Promise<never>((_, reject) => {
        cancel = () => reject({ kind: "auth", message: "sign-in cancelled" });
      });
  }

  it("a click on another provider ends the wait and starts its sign-in", async () => {
    const pending = waitingBrowser();
    api.oauthSignIn.mockImplementationOnce(pending).mockImplementationOnce(pending);
    const form = new AccountForm(null, () => {});
    const google = form.signIn("google");
    expect(form.waitingFor).toBe("google");
    expect(form.busy).toBe(true);

    const yandex = form.signIn("yandex");
    await google;
    await vi.waitFor(() => expect(api.oauthSignIn).toHaveBeenCalledTimes(2));
    expect(api.oauthCancel).toHaveBeenCalledTimes(1);
    expect(api.oauthSignIn).toHaveBeenLastCalledWith("yandex", null);
    expect(form.waitingFor).toBe("yandex");
    // The cancelled Google sign-in leaves no error behind.
    expect(form.error).toBeNull();
    expect(form.status).toContain("Yandex");

    form.cancelSignIn();
    await yandex;
    expect(form.waitingFor).toBeNull();
    expect(form.busy).toBe(false);
  });

  it("a click on the provider already awaited starts nothing", async () => {
    api.oauthSignIn.mockImplementation(waitingBrowser());
    const form = new AccountForm(null, () => {});
    const first = form.signIn("google");
    await form.signIn("google");
    expect(api.oauthSignIn).toHaveBeenCalledTimes(1);
    form.cancelSignIn();
    await first;
  });

  it("a failed sign-in does not keep saying it waits for the browser", async () => {
    api.oauthSignIn.mockRejectedValue({ kind: "auth", message: "access denied" });
    const form = new AccountForm(null, () => {});
    await form.signIn("google");
    expect(form.error?.message).toBe("access denied");
    expect(form.status).toBe("");
    expect(form.waitingBrowser).toBe(false);
  });
});

describe("going to wait after an answer", () => {
  it("is off for a mailbox that never had it, and nothing is saved for it", () => {
    const form = new AccountForm(saved, vi.fn());
    expect(form.waiting).toEqual({ park: false, folder: "", stop_to_archive: false });
    expect("waiting" in form.account()).toBe(false);
  });

  it("is saved with its folder and what «Stop waiting» does, without logging in", async () => {
    const form = new AccountForm(saved, vi.fn());
    form.waiting.park = true;
    form.waiting.folder = "INBOX/Ждут ответа";
    form.waiting.stop_to_archive = true;
    expect(form.dirty).toBe(true);
    expect(form.needsCheck).toBe(false);
    await form.save();
    expect(api.accountCheck).not.toHaveBeenCalled();
    expect(api.accountSave).toHaveBeenCalledWith(expect.objectContaining({ waiting: { park: true, folder: "INBOX/Ждут ответа", stop_to_archive: true } }), null, null);
    // Opened again, as it was saved.
    const again = new AccountForm({ ...saved, waiting: { park: true, folder: "INBOX/Ждут ответа", stop_to_archive: true } }, vi.fn());
    expect(again.waiting.folder).toBe("INBOX/Ждут ответа");
    expect(again.dirty).toBe(false);
  });
});
