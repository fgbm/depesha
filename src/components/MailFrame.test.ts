import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import MailFrame from "./MailFrame.svelte";

/** The frame's srcdoc, unescaped from the rendered iframe. */
function srcdoc(props: Record<string, unknown>): string {
  const { body } = render(MailFrame, {
    props: { html: "<table><tr><td>x</td></tr></table>", allowRemote: false, onLink: () => {}, ...props },
  });
  const doc = body.match(/srcdoc="([^"]*)"/)?.[1] ?? body;
  return doc.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("the frame Depesha draws Markdown in", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives a Markdown table a grid, so its bare tags do not stand without one", () => {
    const doc = srcdoc({ markdown: true });
    expect(doc).toContain("body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow-x:auto}");
    expect(doc).toContain("body th,body td{border:1px solid var(--md-line);padding:4px 10px}");
    expect(doc).toContain("body th{background:var(--md-head);font-weight:600}");
  });

  it("leaves a sender's own HTML table alone", () => {
    // A foreign letter lays out its own tables: no grid of ours lands on it.
    expect(srcdoc({})).not.toContain("border-collapse");
  });

  it("takes the theme's line for the grid, and light greys by default", () => {
    // A themed Markdown frame overrides `--md-line`/`--md-head` with the theme's colours.
    const css = { colorScheme: "light", getPropertyValue: (v: string) => (v === "--line" ? "#2c323b" : "#000") };
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => css);
    const themed = srcdoc({ markdown: true, themed: true });
    expect(themed).toContain("--md-line:var(--line)");
    expect(themed).toContain("--ink:#000");
    const plain = srcdoc({ markdown: true });
    expect(plain).toContain("--md-line:#d9dde3");
  });
});
