// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanEditorHtml, cleanRemoteHtml } from "./sanitize";

describe("the editor's cleaning", () => {
  it("does not follow an address a browser reads through hidden characters", () => {
    // A tab inside the scheme and `\` for `/`: the browser drops the one and folds the other.
    expect(cleanEditorHtml('<img src="ht&#9;tps:\\evil.example/p.gif">')).not.toContain("evil.example");
    expect(cleanEditorHtml('<img src="ht\ntps://evil.example/p.gif">')).not.toContain("evil.example");
    // A plain address the letter may show (the reader allowed it) still goes through.
    expect(cleanEditorHtml('<img src="https://cdn.example/logo.png">')).toContain("https://cdn.example/logo.png");
  });

  it("drops a style that reaches out for a resource", () => {
    const cases = [
      "<div style=\"background-image:image-set('https://evil/p' 1x)\">x</div>",
      "<div style=\"background-image:u\\72l(https://evil/p)\">x</div>",
      "<div style=\"background:url(https://evil/p)\">x</div>",
    ];
    for (const html of cases) {
      const out = cleanEditorHtml(html);
      expect(out).not.toContain("evil");
      expect(out).not.toContain("style");
    }
    // A style that loads nothing is kept.
    expect(cleanEditorHtml('<div style="color:red">x</div>')).toContain('style="color:red"');
  });

  it("keeps the letter's own pictures", () => {
    expect(cleanEditorHtml('<img src="data:image/png;base64,AAAA">')).toContain("data:image/png");
  });
});

describe("what may be shown in the window outside the frame", () => {
  it("leaves out remote resources but keeps a picture of its own", () => {
    const out = cleanRemoteHtml(
      '<div><img src="https://evil.example/p.gif"><img src="data:image/png;base64,AA"></div>',
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain("data:image/png");
    const styled = cleanRemoteHtml('<div style="background:url(https://evil.example/p)">x</div>');
    expect(styled).not.toContain("evil.example");
    expect(styled).not.toContain("style");
  });
});
