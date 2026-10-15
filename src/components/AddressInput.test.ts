// @vitest-environment jsdom
// The suggestions of the recipient field (#104, 4.1 А): a person once, with the primary address,
// and ←/→ turn to another of their addresses before Enter puts it in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { flushSync, mount, tick, unmount } from "svelte";
import AddressInput from "./AddressInput.svelte";
import { i18n } from "../lib/i18n.svelte";
import { api } from "../lib/testing";
import type { Addr } from "../lib/types";

let view: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
let value: Addr[];

function show(initial: Addr[] = []) {
  value = initial;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(AddressInput, { target, props: { label: "Кому", value } });
  flushSync();
}

const key = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  flushSync();
  return e;
};

async function type(text: string) {
  const input = target.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(api.addresses).toHaveBeenCalled());
  await tick();
  return input;
}

beforeEach(() => {
  i18n.lang = "ru";
  api.addresses.mockReset();
  api.addresses.mockResolvedValue([
    { email: "olga@example.org", name: "Ольга Смирнова", emails: ["olga@example.org", "o.smirnova@example.com"] },
    { email: "olya@example.net", name: "Оля", emails: ["olya@example.net"] },
  ]);
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the suggestions of a recipient field", () => {
  it("offer a person once, with the primary address and a mark of the others", async () => {
    show();
    await type("ол");
    const rows = [...target.querySelectorAll(".suggest button")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("olga@example.org");
    expect(rows[0].textContent).toContain("+1");
    expect(rows[1].textContent).not.toContain("+");
  });

  it("take the primary address on Enter", async () => {
    show();
    const input = await type("ол");
    key(input, "Enter");
    expect(value).toEqual([{ name: "Ольга Смирнова", email: "olga@example.org" }]);
  });

  it("turn to another address of the person with → and ←, and put that one in", async () => {
    show();
    const input = await type("ол");
    expect(key(input, "ArrowRight").defaultPrevented).toBe(true);
    expect(target.querySelector(".suggest button")?.textContent).toContain("o.smirnova@example.com");
    key(input, "ArrowLeft");
    expect(target.querySelector(".suggest button")?.textContent).toContain("olga@example.org");
    key(input, "ArrowRight");
    key(input, "Enter");
    expect(value).toEqual([{ name: "Ольга Смирнова", email: "o.smirnova@example.com" }]);
  });

  it("leave the arrows to the caret when the person has one address", async () => {
    show();
    const input = await type("ол");
    key(input, "ArrowDown");
    expect(key(input, "ArrowRight").defaultPrevented).toBe(false);
  });
});

describe("the chip of an address", () => {
  const LONG = { name: "Анастасия Вячеславовна Селиванова", email: "an.selivanova@tmssc.ru" };

  it("is one line: the name, then the address, and the whole text in the title", () => {
    show([LONG]);
    const chip = target.querySelector<HTMLElement>(".chip")!;
    expect(chip.title).toBe("Анастасия Вячеславовна Селиванова <an.selivanova@tmssc.ru>");
    expect(chip.querySelector(".nm")?.textContent).toBe(LONG.name);
    expect(chip.querySelector(".ad")?.textContent).toBe("an.selivanova@tmssc.ru");
    expect(chip.querySelector("br")).toBeNull();
    expect(chip.textContent).not.toContain("<");
    const who = chip.querySelector<HTMLElement>(".who")!;
    expect(chip.firstElementChild).toBe(who);
    expect(who.children[0].classList.contains("nm")).toBe(true);
    expect(who.children[1].classList.contains("ad")).toBe(true);
  });

  it("shows only the address when there is no name", () => {
    show([{ name: "", email: "plain@example.org" }]);
    const chip = target.querySelector<HTMLElement>(".chip")!;
    expect(chip.querySelector(".nm")).toBeNull();
    expect(chip.querySelector(".ad")?.textContent).toBe("plain@example.org");
    expect(chip.title).toBe("plain@example.org");
  });

  it("stands in the value column of the row, after the label", () => {
    show([LONG]);
    const row = target.querySelector<HTMLElement>(".field-row")!;
    expect(row.children[0].classList.contains("field-label")).toBe(true);
    expect(row.children[1].classList.contains("field-value")).toBe(true);
    expect(row.children[1].querySelector(".chip")).not.toBeNull();
  });
});
