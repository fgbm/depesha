// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStyles } from "../../lib/cssTesting";

// The current item of a list is marked by the ground, never by a coloured bar (#165).
describe("the current item of the sidebar", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./sidebar.css")));
  afterEach(() => {
    unstyle();
    document.body.innerHTML = "";
  });

  const drawn = (html: string) => {
    document.body.innerHTML = `<nav class="side">${html}</nav>`;
    return getComputedStyle(document.body.querySelector(".active")!);
  };

  it.each([
    ["a folder, «Контакты», a label or a favourite", '<button class="item active"></button>'],
    ["a tile of the folded panel", '<button class="tile active"></button>'],
  ])("has the ground and no bar: %s", (_, html) => {
    const style = drawn(html);
    expect(style.background).toBe("var(--side-2)");
    expect(style.boxShadow).toBe("");
  });

  it("rings the current mailbox of the folded panel in the ink of the panel, not in the red of an error (А9)", () => {
    document.body.innerHTML = '<nav class="side"><button class="circle current"></button></nav>';
    const ring = getComputedStyle(document.body.querySelector(".circle")!).boxShadow;
    expect(ring).toContain("var(--side-ink)");
    expect(ring).not.toContain("--accent");
  });
});
