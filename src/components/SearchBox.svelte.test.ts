// @vitest-environment jsdom
// The highlighted suggestion under the search box starts from none whenever the list of
// suggestions is another one: Enter then searches the text as typed, not a row the list left.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { flushSync, mount, unmount } from "svelte";
import SearchBox from "./SearchBox.svelte";
import { app } from "../lib/store.svelte";
import { recentSearches } from "../lib/recentSearches.svelte";
import { i18n } from "../lib/i18n.svelte";
import { resetFakes, settings } from "../lib/testing";

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  resetFakes();
  i18n.lang = "ru";
  app.settings = settings();
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the highlighted suggestion", () => {
  it("goes when the text makes another list of suggestions", () => {
    const props = $state<{ input: HTMLInputElement | null }>({ input: null });
    view = mount(SearchBox, { target: document.body, props });
    flushSync();
    const input = props.input!;
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
    };
    const lit = () => document.querySelectorAll(".sg.active").length;
    type("fr");
    expect(document.querySelectorAll(".sg").length).toBeGreaterThan(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    expect(lit()).toBe(1);
    type("fro");
    expect(lit()).toBe(0);
  });

  it("stays while the same text gets more suggestions", () => {
    recentSearches.remember("первый");
    const props = $state<{ input: HTMLInputElement | null }>({ input: null });
    view = mount(SearchBox, { target: document.body, props });
    flushSync();
    props.input!.dispatchEvent(new Event("focus"));
    flushSync();
    props.input!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flushSync();
    const lit = () => [...document.querySelectorAll(".sg")].findIndex((r) => r.classList.contains("active"));
    const at = lit();
    expect(at).toBeGreaterThanOrEqual(0);
    recentSearches.remember("второй");
    flushSync();
    expect(lit()).toBe(at);
  });
});
