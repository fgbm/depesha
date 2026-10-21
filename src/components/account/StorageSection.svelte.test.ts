// @vitest-environment jsdom
// «Own limit» is a list (0.8.12, screen 8): as in the settings, an own limit with its field, or
// no warnings. A limit typed (or loaded) turns the list to it, and emptying the field turns it back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import StorageSection from "./StorageSection.svelte";
import { app } from "../../lib/store.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { resetFakes, settings } from "../../lib/testing";

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
const form = $state({ quotaLimitGb: "", quotaWarn: true, limitError: "", error: null, errorProto: false, fieldErrors: {}, revertLimit() {} });
const choice = () => target.querySelector<HTMLElement>("[data-settings='acc-limit'] .select")!.dataset.value;
const own = () => target.querySelector<HTMLInputElement>("[data-settings='acc-limit'] input.own");
function pick(value: string) {
  target.querySelector<HTMLElement>("[data-settings='acc-limit'] .trigger")!.click();
  flushSync();
  document.querySelector<HTMLElement>(`.pop [role=option][data-value=${value}]`)!.click();
  flushSync();
}

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  app.settingsCtl.settings = settings();
  form.quotaLimitGb = "";
  form.quotaWarn = true;
  target = document.createElement("div");
  document.body.append(target);
  const account = { id: "a", label: "Work", email: "jane@example.com", ews: null };
  view = mount(StorageSection, { target, props: { form: form as never, account: account as never } });
  flushSync();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the choice of the limit for the warnings", () => {
  it("follows the field: a limit in it is the own choice, an empty one the settings'", () => {
    expect(choice()).toBe("inherit");
    expect(own()).toBeNull();
    form.quotaLimitGb = "5";
    flushSync();
    expect(choice()).toBe("own");
    expect(own()?.value).toBe("5");
    form.quotaLimitGb = "";
    flushSync();
    expect(choice()).toBe("inherit");
  });

  it("holds the pick of the own limit with an empty field, and empties the field on the settings' one", () => {
    pick("own");
    expect(choice()).toBe("own");
    expect(own()).not.toBeNull();
    form.quotaLimitGb = "5";
    flushSync();
    pick("inherit");
    expect(form.quotaLimitGb).toBe("");
    expect(choice()).toBe("inherit");
  });

  it("turns the warnings of the mailbox off and back on", () => {
    pick("off");
    expect(form.quotaWarn).toBe(false);
    expect(choice()).toBe("off");
    pick("inherit");
    expect(form.quotaWarn).toBe(true);
  });
});
