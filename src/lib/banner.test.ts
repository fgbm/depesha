import { describe, expect, it } from "vitest";
import { foldBanner } from "./banner";

const run = () => {};
const banner = {
  text: "No reply yet",
  actions: [
    { title: "Write again", run, primary: true },
    { title: "Set a new date", run },
    { title: "Stop waiting", run },
  ],
  details: [{ label: "Reminded", value: "3 Oct" }],
  detailsTitle: "Reminder history",
};

describe("a plugin's banner", () => {
  it("shows everything in a wide window", () => {
    const f = foldBanner(banner, false, false);
    expect(f.folded).toBe(false);
    expect(f.buttons).toHaveLength(3);
    expect(f.details).toHaveLength(1);
  });

  it("keeps the main button in a narrow one and folds the rest and the history into ⋯", () => {
    const f = foldBanner(banner, true, false);
    expect(f.buttons.map((a) => a.title)).toEqual(["Write again"]);
    expect(f.menu.map((a) => a.title)).toEqual(["Set a new date", "Stop waiting"]);
    expect([f.detailsInMenu, f.details]).toEqual([true, []]);
    expect(foldBanner(banner, true, true).details).toHaveLength(1);
  });

  it("details without a title stay shown; one button needs no menu", () => {
    const plain = { text: "x", actions: [{ title: "Open", run }], details: [{ label: "a", value: "b" }] };
    expect(foldBanner(plain, true, false)).toMatchObject({ folded: false, details: plain.details });
  });
});
