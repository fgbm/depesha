// @vitest-environment jsdom
// A failed check of a new mailbox is told next to the fields it is about, and comes into view (А3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));
vi.mock("../lib/theme", () => ({ applyTheme: () => {} }));

import { flushSync, mount, unmount } from "svelte";
import Wizard from "./Wizard.svelte";
import { app } from "../lib/store.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api, resetFakes, settings } from "../lib/testing";
import type { AccountView } from "../lib/types";

let view: ReturnType<typeof mount> | null = null;
const scrolled: Element[] = [];

const input = (root: ParentNode, css: string, value: string) => {
  const el = root.querySelector<HTMLInputElement>(css)!;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

/** The wizard on its second step, where the servers are, with the check failing by `error`. */
async function failedCheck(error: object) {
  api.detect.mockResolvedValue({ username: "jane", imap: { host: "imap.x", port: 993, security: "tls" }, smtp: { host: "smtp.x", port: 465, security: "tls" }, source: "guess", notes: [] } as never);
  api.accountCheck.mockRejectedValue(error);
  const root = document.createElement("div");
  document.body.append(root);
  view = mount(Wizard, { target: root });
  flushSync();
  input(root, "input[type=email]", "jane@example.com");
  input(root, "input[type=password]", "secret");
  root.querySelector<HTMLButtonElement>("footer .btn.primary")!.click();
  await vi.waitFor(() => expect(root.querySelector("fieldset")).not.toBeNull());
  root.querySelector<HTMLButtonElement>("footer .btn.primary")!.click();
  await vi.waitFor(() => expect(root.querySelector(".error")).not.toBeNull());
  flushSync();
  return root;
}

beforeEach(() => {
  resetFakes();
  vi.unstubAllGlobals();
  i18n.lang = "ru";
  api.oauthProviders.mockResolvedValue([]);
  app.settingsCtl.settings = settings();
  app.mailboxes.accounts = [{ id: "a", email: "jane@old.example", status: null } as AccountView];
  app.ui.wizard = { account: null } as never;
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  document.body.innerHTML = "";
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("the error of a failed check in the wizard (А3)", () => {
  it("stands right under the login and the password, before the servers, and is scrolled to", async () => {
    const root = await failedCheck({ kind: "auth", message: "IMAP: сервер отклонил вход" });
    const error = root.querySelector(".error")!;
    expect(error.previousElementSibling?.querySelector("input[type=password]")).not.toBeNull();
    expect(error.nextElementSibling?.tagName).toBe("FIELDSET");
    expect(root.querySelectorAll(".error")).toHaveLength(1);
    expect(scrolled).toContain(error);
  });

  it("stands under the block of its server when the certificate of that server is not trusted", async () => {
    const cert = { host: "smtp.x", subject: "", issuer: "", not_after: null, sha256: "00" };
    const root = await failedCheck({ kind: "certificate", message: "SMTP: сертификат", cert });
    const error = root.querySelector(".error")!;
    expect(error.previousElementSibling?.querySelector("legend")?.textContent).toContain("SMTP");
    expect(root.querySelectorAll(".error")).toHaveLength(1);
  });
});
