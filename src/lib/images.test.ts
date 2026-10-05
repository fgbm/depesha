import { describe, expect, it } from "vitest";
import { dataUrlSize, dropPlan, fitSide, isPictureName, offersZones, pictureHtml, picturesSize, takePictures } from "./images";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("pictures", () => {
  it("tells pictures by their name", () => {
    expect(isPictureName("зал.JPG")).toBe(true);
    expect(isPictureName("logo.webp")).toBe(true);
    expect(isPictureName("смета.pdf")).toBe(false);
    expect(isPictureName("png")).toBe(false);
  });

  it("makes a large photo smaller on its long side, keeping proportions", () => {
    expect(fitSide(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitSide(1000, 5000)).toEqual({ width: 320, height: 1600 });
    expect(fitSide(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("counts the bytes of a data URL", () => {
    expect(dataUrlSize(`data:image/png;base64,${PNG}`)).toBe(70);
    expect(picturesSize(`<p>x</p><img src="data:image/png;base64,${PNG}"><img src="data:image/png;base64,${PNG}" style="width:100%">`)).toBe(140);
    expect(dataUrlSize("https://example.com/a.png")).toBe(0);
  });

  it("writes the two sizes", () => {
    expect(pictureHtml("data:image/png;base64,AA", "fit")).toBe('<img src="data:image/png;base64,AA" style="width:100%;height:auto">');
    expect(pictureHtml("data:image/png;base64,AA", "natural")).toBe('<img src="data:image/png;base64,AA">');
  });

  it("takes the pictures out of the HTML for attaching", () => {
    const { html, pictures } = takePictures(`<div>Фото:</div><img src="data:image/png;base64,${PNG}" style="width:100%"><img src="https://example.com/a.png">`);
    expect(html).toBe('<div>Фото:</div><img src="https://example.com/a.png">');
    expect(pictures).toEqual([{ mime: "image/png", base64: PNG }]);
  });
});

describe("dropping files on the window", () => {
  const files = ["зал.jpg", "смета.pdf", "схема.png"];

  it("offers the two zones only to an HTML letter, only for pictures", () => {
    expect(offersZones(files, "html")).toBe(true);
    expect(offersZones(["смета.pdf"], "html")).toBe(false);
    expect(offersZones(files, "plain")).toBe(false);
    expect(offersZones(files, "markdown")).toBe(false);
  });

  it("puts pictures into the text and attaches the rest", () => {
    expect(dropPlan(files, "html", "inline")).toEqual({ inline: ["зал.jpg", "схема.png"], attach: ["смета.pdf"] });
  });

  it("attaches everything dropped on «Attach» or outside the zones", () => {
    expect(dropPlan(files, "html", "attach")).toEqual({ inline: [], attach: files });
    expect(dropPlan(files, "html", null)).toEqual({ inline: [], attach: files });
  });

  it("a plain-text or Markdown letter only attaches", () => {
    expect(dropPlan(files, "markdown", "inline")).toEqual({ inline: [], attach: files });
    expect(dropPlan(files, "plain", "inline")).toEqual({ inline: [], attach: files });
  });
});
