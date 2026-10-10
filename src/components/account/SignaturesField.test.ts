// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import SignaturesField from "./SignaturesField.svelte";
import { AccountForm } from "../../lib/accountForm.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { resetFakes } from "../../lib/testing";
import type { Account } from "../../lib/types";

const acc: Account = {
  id: "a",
  label: "",
  color: "",
  display_name: "Jane",
  email: "jane@example.com",
  username: "jane@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 465, security: "tls" },
  save_sent_copy: true,
  attachments_dir: "",
  signatures: [{ id: "s", name: "Work", html: "<p>x</p>", text: "x" }],
};

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
});

afterEach(async () => {
  // Teardown: a view that is already gone is fine.
  if (view) await Promise.resolve(unmount(view)).catch(() => {});
  view = null;
  document.body.innerHTML = "";
});

describe("the menu of a signature (#120, 9)", () => {
  it("does not print the keys: the keys are kept, not drawn", () => {
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(SignaturesField, { target, props: { form: new AccountForm(acc, vi.fn()) } });
    flushSync();
    target.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!.click();
    flushSync();
    const items = [...document.querySelectorAll(".mi")];
    expect(items.length).toBeGreaterThan(3);
    expect(items.flatMap((i) => [...i.querySelectorAll(".hint")].map((h) => h.textContent))).toEqual([]);
  });
});
