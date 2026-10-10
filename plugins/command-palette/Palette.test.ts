// @vitest-environment jsdom
// The chip of the highlighted row says which key edits the command's key (#127): the key is
// named by the shared key naming (Keys), not written into the text, so a platform that names
// Alt otherwise shows it so.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/keymap", async (orig) => {
  const real = await orig<typeof import("../../src/lib/keymap")>();
  return { ...real, caps: (key: string, lang: string, mac?: boolean) => real.caps(key, lang, mac).map((c) => (c.main === "Alt" ? { main: "⌥" } : c)) };
});

import { flushSync, mount, unmount } from "svelte";
import type { Command, PluginContext } from "@depesha/plugin-api";
import Palette from "./Palette.svelte";
import { palette } from "./state.svelte";

let view: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  palette.open = false;
  document.body.innerHTML = "";
});

describe("the palette's hint about editing a key", () => {
  it("takes the key from the key naming", async () => {
    const commands: Command[] = [{ id: "core.compose", title: () => "Написать", run: () => {} }];
    const ctx = {
      t: (text: { en: string; ru: string }) => text.ru,
      commands: () => commands,
      keyOf: () => undefined,
      people: { find: () => [] },
    } as unknown as PluginContext;
    palette.open = true;
    view = mount(Palette, { target: document.body, props: { ctx } });
    flushSync();
    const chip = document.querySelector(".pedit") as HTMLElement;
    expect(chip.textContent).toContain("⌥+Enter");
    expect(chip.title).toBe("Изменить клавишу");
  });
});

describe("the highlighted row", () => {
  it("goes back to the first one when the query changes", () => {
    const commands: Command[] = ["Написать", "Найти", "Настроить"].map((n, i) => ({ id: `core.c${i}`, title: () => n, run: () => {} }));
    const ctx = {
      t: (text: { en: string; ru: string }) => text.ru,
      commands: () => commands,
      keyOf: () => undefined,
      people: { find: () => [] },
    } as unknown as PluginContext;
    palette.open = true;
    view = mount(Palette, { target: document.body, props: { ctx } });
    flushSync();
    const input = document.querySelector<HTMLInputElement>("input.q")!;
    const lit = () => [...document.querySelectorAll(".item")].findIndex((r) => r.classList.contains("active"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    expect(lit()).toBe(2);
    input.value = "на";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(lit()).toBe(0);
  });
});
