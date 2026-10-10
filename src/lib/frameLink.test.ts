// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { linkAt } from "./frameLink";
import { clean } from "./office";

describe("links of a letter's frame", () => {
  it("finds the link under a click, text or image map", () => {
    document.body.innerHTML = '<a href="https://a.test"><b id="in">x</b></a><map name="m"><area id="spot" href="https://b.test"></map><p id="none">y</p>';
    expect(linkAt(document.getElementById("in"))?.getAttribute("href")).toBe("https://a.test");
    expect(linkAt(document.getElementById("spot"))?.getAttribute("href")).toBe("https://b.test");
    expect(linkAt(document.getElementById("none"))).toBeNull();
    expect(linkAt(null)).toBeNull();
  });

  it("is not offered an image map by Word and sheet output", () => {
    const html = clean('<img src="data:image/png;base64,AA==" usemap="#m"><map name="m"><area href="https://b.test" shape="rect" coords="0,0,9,9"></map><p>ok</p>');
    expect(html).not.toMatch(/usemap|<map|<area/);
    expect(html).toContain("ok");
  });
});
