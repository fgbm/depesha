// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { followFocus } from "./listFocus";

let list: HTMLElement;
let a: HTMLElement;
let b: HTMLElement;
let outside: HTMLInputElement;

beforeEach(() => {
  document.body.innerHTML = `<input id="s"><div id="l" role="listbox" tabindex="-1"><div class="row" tabindex="-1"></div><div class="row" tabindex="-1"></div></div>`;
  list = document.getElementById("l")!;
  [a, b] = [...list.querySelectorAll<HTMLElement>(".row")];
  outside = document.getElementById("s") as HTMLInputElement;
});

describe("focus follows the opened row (#94)", () => {
  it("moves from the row that was clicked to the row the arrows reached", () => {
    a.focus();
    followFocus(list, b);
    expect(document.activeElement).toBe(b);
  });

  it("takes the focus from the list itself", () => {
    list.focus();
    followFocus(list, a);
    expect(document.activeElement).toBe(a);
  });

  it("leaves focus outside the list alone", () => {
    outside.focus();
    followFocus(list, b);
    expect(document.activeElement).toBe(outside);
  });
});
