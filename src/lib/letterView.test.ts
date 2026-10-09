import { describe, expect, it } from "vitest";
import { effectivePref, preferredView, senderView, switchViews } from "./letterView";
import type { BodyView, MessageView } from "./types";

type Forms = Pick<MessageView, "html" | "text" | "markdown" | "views">;

function letter(views: BodyView[]): Forms {
  return {
    views,
    html: views.includes("html") ? "<p>html</p>" : null,
    text: views.includes("text") ? "text" : null,
    markdown: views.includes("markdown") ? "<h1>md</h1>" : null,
  };
}

describe("the form a letter is shown in", () => {
  it("is the sender's favourite, the last part, by default", () => {
    // Depesha puts the Markdown before the HTML, for clients that do not know it.
    expect(senderView(letter(["text", "markdown", "html"]))).toBe("html");
    expect(senderView(letter(["text", "html", "markdown"]))).toBe("markdown");
    expect(senderView(letter(["text"]))).toBe("text");
    expect(preferredView(letter(["text", "markdown", "html"]), "sender")).toBe("html");
  });

  it("follows the setting when the letter has that form", () => {
    expect(preferredView(letter(["text", "markdown", "html"]), "markdown")).toBe("markdown");
    expect(preferredView(letter(["text", "markdown", "html"]), "text")).toBe("text");
    expect(preferredView(letter(["text", "html"]), "markdown")).toBe("html");
    // Plain text made from HTML is no text part: the HTML stays.
    expect(preferredView(letter(["html"]), "text")).toBe("html");
  });

  it("keeps letters read before forms were told apart as they were", () => {
    const old: Forms = { html: "<p>x</p>", text: "x", markdown: undefined, views: undefined };
    expect(preferredView(old, "sender")).toBe("html");
    expect(preferredView(old, "markdown")).toBe("html");
    expect(preferredView({ ...old, html: null }, "sender")).toBe("text");
  });
});

describe("the switch above a letter", () => {
  it("shows for a letter with Markdown, in its own order", () => {
    expect(switchViews(letter(["text", "markdown", "html"]), "sender")).toEqual(["html", "markdown", "text"]);
    expect(switchViews(letter(["text", "html", "markdown"]), "markdown")).toEqual(["html", "markdown", "text"]);
    expect(switchViews(letter(["markdown", "html"]), "sender")).toEqual(["html", "markdown"]);
  });

  it("stays hidden for an ordinary letter shown as its sender meant", () => {
    expect(switchViews(letter(["text", "html"]), "sender")).toEqual([]);
    expect(switchViews(letter(["text", "html"]), "markdown")).toEqual([]);
    expect(switchViews(letter(["text"]), "text")).toEqual([]);
    expect(switchViews(letter(["markdown"]), "sender")).toEqual([]);
  });

  it("shows when the setting chose plain text over the sender's HTML: the way back", () => {
    expect(switchViews(letter(["text", "html"]), "text")).toEqual(["html", "text"]);
  });
});

describe("what asks for the form (#105)", () => {
  it("takes the sender's rule before the mailbox and the setting", () => {
    expect(effectivePref("text", "markdown", "html")).toBe("text");
  });

  it("takes the mailbox before the setting", () => {
    expect(effectivePref("", "markdown", "text")).toBe("markdown");
    expect(effectivePref(undefined, "html", "sender")).toBe("html");
  });

  it("takes the setting when no rule is set", () => {
    expect(effectivePref("", null, "text")).toBe("text");
    expect(effectivePref(undefined, undefined, "sender")).toBe("sender");
  });

  it("lets the switch above the letter, picked by hand, win over all", () => {
    // ReaderBody shows `picked` before `preferredView`: the pick is a form, not a rule.
    const l = letter(["text", "markdown", "html"]);
    const pref = effectivePref("text", "markdown", "html");
    expect(preferredView(l, pref)).toBe("text");
    const picked: BodyView | null = "markdown";
    expect(picked ?? preferredView(l, pref)).toBe("markdown");
  });
});
