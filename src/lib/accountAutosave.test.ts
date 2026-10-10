import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AccountForm } from "./accountForm.svelte";
import { AccountAutosave } from "./accountAutosave.svelte";
import { i18n, t } from "./i18n.svelte";
import { app } from "./store.svelte";
import { api, deferred, resetFakes } from "./testing";
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
  api.accountPatchOwn.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
    // `account_patch_own`: only the fields named, an empty string for «none».
    const next = { ...stored, ...patch } as Record<string, unknown>;
    for (const k of ["compose_format", "letter_view", "default_signature", "reply_signature"]) if (next[k] === "") delete next[k];
    stored = next as unknown as Account;
    return stored;
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
  app.ui.confirm = vi.fn(async () => false) as unknown as typeof app.ui.confirm;
});

afterEach(() => vi.useRealTimers());

describe("a mailbox's page saves what is not the connection as it is changed (#102, 1.7 Б)", () => {
  it("saves a pick at once, through the command that leaves the connection alone", async () => {
    const { form, own, stored } = open();
    form.composeFormat = "markdown";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.accountCheck).not.toHaveBeenCalled();
    expect(api.accountSave).not.toHaveBeenCalled();
    expect(api.accountPatchOwn).toHaveBeenCalledWith("a", { compose_format: "markdown" });
    expect(stored().compose_format).toBe("markdown");
    expect(own.auto.marks.account).toBe("saved");
  });

  it("saves nothing on opening, nor when the fields still say what they said", async () => {
    const { own } = open({ ...base, signatures: [{ id: "s", name: "W", html: "<p>x</p>", text: "x" }], quota_limit_mb: 1000 });
    own.touch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.accountPatchOwn).not.toHaveBeenCalled();
  });

  it("saves a text when its field is left, not at a pause in the typing", async () => {
    const { form, own, stored } = open();
    for (const name of ["J", "Ja", "Jan"]) {
      form.name = name;
      own.typed();
      own.touch();
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(api.accountPatchOwn).not.toHaveBeenCalled();
    own.commit();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.accountPatchOwn).toHaveBeenCalledTimes(1);
    expect(stored().display_name).toBe("Jan");
  });

  it("does not write a connection that was changed, even when something else is saved with it", async () => {
    const { form, own, stored } = open();
    form.imap.host = "other.example.com";
    form.composeFormat = "html";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(stored().compose_format).toBe("html");
    expect(stored().imap.host).toBe("imap.example.com");
    expect(form.connectionDirty).toBe(true);
  });

});

describe("the connection's own button (#102)", () => {
  it("keeps what is changed during a check of the connection and sends it after", async () => {
    const { form, own, stored } = open();
    const check = deferred<void>();
    api.accountCheck.mockReturnValue(check.promise);
    form.smtp.port = 25;
    const saving = form.checkAndSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(form.busy).toBe(true);
    form.label = "Home";
    own.touch();
    await vi.advanceTimersByTimeAsync(500);
    expect(api.accountPatchOwn).not.toHaveBeenCalled();
    check.resolve();
    await saving;
    await vi.advanceTimersByTimeAsync(100);
    expect(stored().smtp.port).toBe(25);
    expect(stored().label).toBe("Home");
  });

  it("sends a name typed during the check after the connection, before the page goes", async () => {
    const { form, stored } = open();
    const check = deferred<void>();
    api.accountCheck.mockReturnValue(check.promise);
    form.imap.port = 143;
    const saving = form.checkAndSave();
    await vi.advanceTimersByTimeAsync(0);
    form.name = "Jane D";
    check.resolve();
    await saving;
    expect(stored().imap.port).toBe(143);
    expect(stored().display_name).toBe("Jane D");
  });
});

describe("leaving and taking back (#102, 1.7 Б)", () => {
  it("does not ask on leaving when only the other settings changed; it asks for a connection changed and not saved", async () => {
    const { form } = open();
    form.composeFormat = "html";
    expect(await form.mayLeave()).toBe(true);
    expect(app.ui.confirm).not.toHaveBeenCalled();
    form.smtp.port = 25;
    expect(await form.mayLeave()).toBe(false);
    expect(app.ui.confirm).toHaveBeenCalledTimes(1);
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
    await vi.advanceTimersByTimeAsync(100);
    expect(await own.undo()).toBe(true);
    expect(stored().compose_format).toBeUndefined();
    expect(form.composeFormat).toBe("");
    expect(own.auto.marks.account).toBe("undone");
    // The fields that came back are not a change to be saved again.
    own.touch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.accountPatchOwn).toHaveBeenCalledTimes(2);
  });

  it("writes what is typed first, so the key takes back the change the user just made", async () => {
    const { form, own, stored } = open();
    form.label = "Home";
    form.composeFormat = "html";
    expect(await own.undo()).toBe(true);
    expect(stored().compose_format).toBeUndefined();
    expect(api.accountPatchOwn).toHaveBeenCalledTimes(2);
  });

  it("puts back only the fields of the change taken back: what is typed meanwhile stays", () => {
    const { form } = open({ ...base, compose_format: "markdown" });
    form.label = "Typed";
    form.composeFormat = "html";
    form.adopt({ ...base, compose_format: "markdown" } as Account, ["compose_format"]);
    expect(form.composeFormat).toBe("markdown");
    expect(form.label).toBe("Typed");
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

describe("a field the backend refuses (#102)", () => {
  it("is said at its own field, the rest is saved, and it is not sent again until it changes", async () => {
    const { form, own } = open();
    const write = api.accountPatchOwn.getMockImplementation()!;
    api.accountPatchOwn.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (patch.attachments_dir === "/etc") throw { kind: "io", message: "not a folder you picked" };
      return write(id, patch);
    });
    form.attachmentsDir = "/etc";
    form.composeFormat = "html";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(form.fieldErrors.attachments_dir).toBe("not a folder you picked");
    expect(form.error).toBeNull();
    const sent = api.accountPatchOwn.mock.calls.map((c) => Object.keys(c[1] as object));
    expect(sent).toEqual([["attachments_dir", "compose_format"], ["attachments_dir"], ["compose_format"]]);
    form.label = "Home";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(Object.keys(api.accountPatchOwn.mock.calls.at(-1)![1] as object)).toEqual(["label"]);
    form.attachmentsDir = "/home/jane";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(form.fieldErrors.attachments_dir).toBeUndefined();
  });
});

describe("what piled up during a check is taken back change by change (#120, 1)", () => {
  it("Ctrl+Z during «Проверить и сохранить» takes back the last change, not all that was typed", async () => {
    const { form, own, stored } = open();
    const check = deferred<void>();
    api.accountCheck.mockReturnValue(check.promise);
    form.smtp.port = 25;
    const saving = form.checkAndSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(form.busy).toBe(true);
    form.label = "Home";
    own.touch();
    form.composeFormat = "html";
    own.touch();
    expect(await own.undo()).toBe(true);
    expect(stored().compose_format).toBeUndefined();
    expect(stored().label).toBe("Home");
    expect(form.label).toBe("Home");
    check.resolve();
    await saving;
  });
});

describe("a partly refused write (#120, 2)", () => {
  it("taking back the other field leaves the refused text and its error where they are", async () => {
    const { form, own, stored } = open();
    const write = api.accountPatchOwn.getMockImplementation()!;
    api.accountPatchOwn.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (patch.attachments_dir === "/etc") throw { kind: "io", message: "not a folder you picked" };
      return write(id, patch);
    });
    form.attachmentsDir = "/etc";
    form.composeFormat = "html";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(stored().compose_format).toBe("html");
    expect(await own.undo()).toBe(true);
    expect(stored().compose_format).toBeUndefined();
    expect(form.attachmentsDir).toBe("/etc");
    expect(form.fieldErrors.attachments_dir).toBe("not a folder you picked");
  });

  it("names only what was written in the toast", async () => {
    app.ui.toasts.splice(0);
    const { form, own } = open();
    const write = api.accountPatchOwn.getMockImplementation()!;
    api.accountPatchOwn.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (patch.attachments_dir === "/etc") throw { kind: "io", message: "no" };
      return write(id, patch);
    });
    form.attachmentsDir = "/etc";
    form.composeFormat = "html";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    const text = app.ui.toasts.map((x) => x.text).join("\n");
    expect(text).toContain(t("wizard.composeFormat"));
    expect(text).not.toContain(t("wizard.attachmentsDir"));
  });
});

describe("a limit that is not a number (#120, 4)", () => {
  it("is not saved as the last good prefix when the field is left", async () => {
    const { form, own } = open();
    // The page reads the fields at every key (its effect), so «5» is remembered as the last good limit.
    form.quotaLimitGb = "5";
    own.typed();
    form.account();
    own.touch();
    form.quotaLimitGb = "5,";
    form.account();
    own.touch();
    own.commit();
    await vi.advanceTimersByTimeAsync(200);
    expect(form.limitError).not.toBeNull();
    expect(api.accountPatchOwn).not.toHaveBeenCalled();
    form.quotaLimitGb = "5,5";
    own.commit();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.accountPatchOwn).toHaveBeenCalledWith("a", { quota_limit_mb: 5632 });
  });
});

describe("a name the backend turns into the address (#120, 5)", () => {
  it("emptied is written once, not at every focusout", async () => {
    const { form, own } = open({ ...base, display_name: base.email });
    // The real backend: an empty name becomes the address.
    api.accountPatchOwn.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      const name = patch.display_name === "" ? base.email : (patch.display_name as string);
      return { ...base, display_name: name } as Account;
    });
    form.name = "";
    for (let i = 0; i < 3; i++) {
      own.typed();
      own.commit();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(api.accountPatchOwn).toHaveBeenCalledTimes(1);
  });
});

describe("a text typed and not left (#120, 3)", () => {
  it("is known as typing until the field is left, and settled writes it", async () => {
    const { form, own, stored } = open();
    form.label = "Typed";
    own.typed();
    own.touch();
    expect(own.typing).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stored().label).not.toBe("Typed");
    await own.settled();
    expect(own.typing).toBe(false);
    expect(stored().label).toBe("Typed");
  });
});

describe("the exit does not outrun the write (#120, ревью 1)", () => {
  it("a text being written is typing until the write is done, left by a click or by the exit", async () => {
    const { form, own } = open();
    const write = deferred<Account>();
    api.accountPatchOwn.mockReturnValue(write.promise);
    form.label = "Typed";
    own.typed();
    own.commit();
    await vi.advanceTimersByTimeAsync(10);
    expect(own.typing).toBe(true);
    write.resolve({ ...base, label: "Typed" } as Account);
    await vi.advanceTimersByTimeAsync(10);
    expect(own.typing).toBe(false);
  });

  it("settled() lets the exit go only after the write", async () => {
    const { form, own } = open();
    const write = deferred<Account>();
    api.accountPatchOwn.mockReturnValue(write.promise);
    form.label = "Typed";
    own.typed();
    const settled = own.settled();
    await vi.advanceTimersByTimeAsync(10);
    expect(own.typing).toBe(true);
    write.resolve({ ...base, label: "Typed" } as Account);
    await settled;
    expect(own.typing).toBe(false);
  });
});

describe("a write that fails does not stop the next ones (#120, ревью 2)", () => {
  it("is told, and the following change is still written", async () => {
    const { form, own, stored } = open();
    const fail = vi.spyOn(app.ui, "fail").mockImplementation(() => {});
    api.accounts.mockRejectedValueOnce(new Error("no answer"));
    form.label = "One";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(fail).toHaveBeenCalled();
    form.composeFormat = "html";
    own.touch();
    await vi.advanceTimersByTimeAsync(100);
    expect(stored().compose_format).toBe("html");
    fail.mockRestore();
  });
});

describe("a key changed again during a check (#120, ревью 5)", () => {
  it("goes to the last group: Ctrl+Z takes back that change, not the first", async () => {
    const { form, own, stored } = open();
    const check = deferred<void>();
    api.accountCheck.mockReturnValue(check.promise);
    form.smtp.port = 25;
    const saving = form.checkAndSave();
    await vi.advanceTimersByTimeAsync(0);
    form.label = "Home";
    own.touch();
    form.composeFormat = "html";
    own.touch();
    form.label = "Home 2";
    own.touch();
    expect(await own.undo()).toBe(true);
    expect(stored().label).toBe("Work");
    expect(stored().compose_format).toBe("html");
    check.resolve();
    await saving;
  });
});
