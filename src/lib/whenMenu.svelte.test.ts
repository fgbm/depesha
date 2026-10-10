import { afterEach, describe, expect, it } from "vitest";
import { closeWhenMenu, openWhenMenu, provideWhenMenu, whenMenuAvailable, whenMenuRequest, type WhenMenuRequest } from "./whenMenu.svelte";

const request = (log: string[]): WhenMenuRequest => ({
  anchor: { x: 1, y: 2, h: 3 },
  extras: { none: true, noneLabel: "None", setupLabel: "Set up…" },
  texts: { placeholder: "When", title: "Remind", pick: "Remind" },
  onpick: (at) => log.push(`pick ${at}`),
  onnone: () => log.push("none"),
  onsetup: () => log.push("setup"),
  onclose: () => log.push("close"),
});

afterEach(() => {
  closeWhenMenu();
  provideWhenMenu(false);
});

describe("the «when» menu lent to other plugins (#103)", () => {
  it("is not there until the plugin that draws it says so", () => {
    expect(whenMenuAvailable()).toBe(false);
    provideWhenMenu(true);
    expect(whenMenuAvailable()).toBe(true);
  });

  it("holds the request of the borrower while the menu is open, and lets it go", () => {
    const log: string[] = [];
    openWhenMenu(request(log));
    expect(whenMenuRequest()?.extras.noneLabel).toBe("None");
    whenMenuRequest()?.onpick(42);
    expect(log).toEqual(["pick 42"]);
    closeWhenMenu();
    expect(whenMenuRequest()).toBeNull();
  });

  it("serves one request at a time: the new one replaces the old", () => {
    const first: string[] = [];
    const second: string[] = [];
    openWhenMenu(request(first));
    openWhenMenu(request(second));
    whenMenuRequest()?.onnone();
    // The request that was replaced is told that its menu went away.
    expect(first).toEqual(["close"]);
    expect(second).toEqual(["none"]);
  });
});
