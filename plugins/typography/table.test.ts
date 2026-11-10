import { describe, expect, it } from "vitest";
import { TABLE } from "./table";

describe("the typography table", () => {
  it("turns a double hyphen into an em dash and three dots into an ellipsis", () => {
    expect(TABLE).toEqual([
      { from: "--", to: "\u2014" },
      { from: "...", to: "\u2026" },
    ]);
  });

  it("gives the em dash and the ellipsis by their code points, not similar-looking marks", () => {
    const points = TABLE.map((r) => [r.from, r.to.codePointAt(0)]);
    expect(points).toEqual([
      ["--", 0x2014],
      ["...", 0x2026],
    ]);
  });
});
