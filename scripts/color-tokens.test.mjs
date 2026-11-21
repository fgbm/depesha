import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXCEPTIONS_FILE, guardProblems, literalsOf, normal, parseExceptions, problemsOf, scan } from "./color-tokens.mjs";

const literals = (path, source) => literalsOf(path, source).map((hit) => hit.literal);

describe("colour literals of a file", () => {
  it("finds hex colours, colour functions and named colours in a component's style", () => {
    const source = `<div></div>
<style>
  .a { color: #FFF; background: rgb(0 0 0 / 18%); }
  .b { border-color: hsl(210 20% 50%); outline-color: red; }
  .c { background: color-mix(in srgb, oklch(70% 0.1 200) 40%, transparent); }
</style>`;
    expect(literals("src/x.svelte", source)).toEqual(["#fff", "rgb(0 0 0 / 18%)", "hsl(210 20% 50%)", "red", "oklch(70% 0.1 200)"]);
  });

  it("allows tokens, transparent and currentColor", () => {
    const source = `<style>.a { color: var(--ink); border: 1px solid currentColor; background: transparent; fill: var(--red, var(--ink)); }</style>`;
    expect(literals("src/x.svelte", source)).toEqual([]);
  });

  it("leaves comments, selectors, strings, fonts and words of other properties alone", () => {
    const source = `/* #fff in a comment, red too */
#tan, .white:hover { width: 1px !important; }
.a { font-family: "Segoe UI Black", Tahoma; animation: red 1s; background: url("red.png"); content: "#fff"; }
.b { white-space: nowrap; }`;
    expect(literals("src/x.css", source)).toEqual([]);
  });

  it("counts a hex colour or a colour function in a script and the markup, but not a named colour there", () => {
    const source = `<script lang="ts">
  // #abc in a comment is an issue, not a colour.
  const fallback = "#3f7fd0";
  const red = "red";
  const link = "https://example.com/#fff";
</script>
<div style:background={"rgb(1 2 3)"}></div>`;
    expect(literals("src/x.svelte", source)).toEqual(["#3f7fd0", "#fff", "rgb(1 2 3)"]);
  });

  it("counts a named colour in a style attribute", () => {
    expect(literals("src/x.svelte", `<div style="color: white; margin: 0"></div>`)).toEqual(["white"]);
  });

  it("gives the line of each literal", () => {
    expect(literalsOf("src/x.css", ".a {\n  color: #000;\n}\n")).toEqual([{ line: 2, literal: "#000" }]);
  });

  it("writes a literal in one form whatever its case and spaces", () => {
    expect(normal("RGB( 0  0 0 / 18% )")).toBe("rgb(0 0 0 / 18%)");
  });
});

describe("the exceptions", () => {
  const exceptions = parseExceptions(`# a comment
src/a.svelte #fff # The letter's white sheet.
src/b.svelte rgb(0 0 0 / 18%)
`);

  it("read a path, a literal and an optional reason", () => {
    expect(exceptions).toEqual([
      { path: "src/a.svelte", literal: "#fff", reason: "The letter's white sheet." },
      { path: "src/b.svelte", literal: "rgb(0 0 0 / 18%)", reason: "" },
    ]);
  });

  it("let an excepted literal pass and fail a new one", () => {
    const found = new Map([
      ["src/a.svelte", [{ line: 3, literal: "#fff" }]],
      ["src/b.svelte", [{ line: 9, literal: "#000" }]],
    ]);
    const { errors, stale } = problemsOf(found, exceptions);
    expect(errors).toEqual([expect.stringContaining("src/b.svelte:9: colour literal #000")]);
    // An exception nobody needs any more is only a warning: deleting it never breaks the check.
    expect(stale).toEqual(["exception not needed: src/b.svelte rgb(0 0 0 / 18%)"]);
  });

  it("may only shrink: a new line without a reason fails against the older list, a line with one passes", () => {
    const head = parseExceptions(`src/a.svelte #fff # The letter's white sheet.
src/c.svelte #123
src/d.svelte #456 # Windows' own red.
`);
    expect(guardProblems(exceptions, head)).toEqual([expect.stringContaining("src/c.svelte #123")]);
    expect(guardProblems(exceptions, exceptions.slice(0, 1))).toEqual([]);
  });
});

describe("the repository", () => {
  it("has no colour literal without an exception", () => {
    const exceptions = parseExceptions(readFileSync(new URL(`../${EXCEPTIONS_FILE}`, import.meta.url), "utf8"));
    expect(problemsOf(scan(), exceptions).errors).toEqual([]);
  });
});
