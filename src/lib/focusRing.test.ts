// @vitest-environment jsdom
// A button reached by the keyboard shows where the focus is, in the same ring on every
// platform (А13). Rows and menu items keep their ground: no ring beside a highlighted row.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rulesFor, useStyles } from "./cssTesting";

describe("the focus ring of a button", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "../app.css")));
  afterEach(() => unstyle());

  it("is drawn for the keyboard only, as the ring of a check box", () => {
    const [ring] = rulesFor(".btn:focus-visible");
    const [check] = rulesFor('input[type="checkbox"]:focus-visible, input[type="radio"]:focus-visible');
    expect(ring.style.getPropertyValue("outline")).toBe(check.style.getPropertyValue("outline"));
    expect(ring.style.getPropertyValue("outline-offset")).toBe("2px");
    expect(rulesFor(".btn:focus")).toEqual([]);
  });

  it("is not given to every button or to menu items, which are rows with a ground", () => {
    const all = [...document.styleSheets].flatMap((s) => [...s.cssRules]) as CSSStyleRule[];
    const ringed = all.filter((r) => r.style?.getPropertyValue("outline").includes("solid")).map((r) => r.selectorText);
    expect(ringed.filter((s) => /(^|,\s*)(button|\.mi)(:focus|\s*,|$)/.test(s))).toEqual([]);
  });
});
