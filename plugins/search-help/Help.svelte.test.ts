// @vitest-environment jsdom
// The panel opens from the plugin's state and filters the operators by what is typed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PluginContext } from "@depesha/plugin-api";
import Help from "./Help.svelte";
import { searchHelp } from "./state.svelte";

const ctx = {
  lang: () => "ru",
  t: (text: { ru: string }) => text.ru,
  toast: () => {},
} as unknown as PluginContext;

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  searchHelp.open = true;
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  searchHelp.open = false;
});

describe("the search help panel", () => {
  it("shows operators and examples while open", () => {
    view = mount(Help, { target: document.body, props: { ctx } });
    flushSync();
    expect(document.querySelectorAll(".row").length).toBeGreaterThan(20);
    expect(document.body.textContent).toContain("больше:25М");
    expect(document.body.textContent).toContain("в:Работа/*");
  });

  it("narrows the list to what is typed", () => {
    view = mount(Help, { target: document.body, props: { ctx } });
    flushSync();
    const input = document.querySelector(".q") as HTMLInputElement;
    input.value = "влож";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const rows = [...document.querySelectorAll(".row")].map((r) => r.textContent ?? "");
    expect(rows.some((r) => r.includes("есть:вложение"))).toBe(true);
    expect(rows.some((r) => r.includes("больше:"))).toBe(false);
  });

  it("draws nothing when closed", () => {
    searchHelp.open = false;
    view = mount(Help, { target: document.body, props: { ctx } });
    flushSync();
    expect(document.querySelector(".panel")).toBeNull();
  });
});
