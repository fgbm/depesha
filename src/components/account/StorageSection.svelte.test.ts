// @vitest-environment jsdom
// «Own limit» follows the field: a limit typed (or loaded) turns the choice to it, and emptying
// the field turns it back to the server's. A click on the other choice holds until the field changes.
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
const radios = () => [...target.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => r.checked);

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  app.settingsCtl.settings = settings();
  form.quotaLimitGb = "";
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
  it("follows the field: a limit in it is the own choice, an empty one the server's", () => {
    expect(radios()).toEqual([true, false]);
    form.quotaLimitGb = "5";
    flushSync();
    expect(radios()).toEqual([false, true]);
    form.quotaLimitGb = "";
    flushSync();
    expect(radios()).toEqual([true, false]);
  });

  it("holds the click on the server's limit, which empties the field, until the field changes", () => {
    form.quotaLimitGb = "5";
    flushSync();
    const first = target.querySelector<HTMLInputElement>("input[type=radio]")!;
    first.checked = true;
    first.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(form.quotaLimitGb).toBe("");
    expect(radios()).toEqual([true, false]);
    form.quotaLimitGb = "7";
    flushSync();
    expect(radios()).toEqual([false, true]);
  });
});
