// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStyles } from "../lib/cssTesting";

describe("the current attachment of the menu (#165)", () => {
  let unstyle = () => {};
  beforeEach(() => (unstyle = useStyles(import.meta.url, "./AttachmentMenu.svelte")));
  afterEach(() => {
    unstyle();
    document.body.innerHTML = "";
  });

  it("is marked by the ground, with no bar", () => {
    document.body.innerHTML = '<button class="mi current" aria-current="true"></button>';
    const style = getComputedStyle(document.body.firstElementChild!);
    expect(style.background).toBe("var(--selected)");
    expect(style.boxShadow).toBe("");
  });
});
