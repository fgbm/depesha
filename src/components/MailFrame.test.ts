import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import MailFrame from "./MailFrame.svelte";
import { HL_CSS } from "../lib/syntax";

/** The frame's srcdoc, unescaped from the rendered iframe. */
function srcdoc(props: Record<string, unknown>): string {
  const { body } = render(MailFrame, {
    props: { html: "<table><tr><td>x</td></tr></table>", allowRemote: false, onLink: () => {}, ...props },
  });
  const doc = body.match(/srcdoc="([^"]*)"/)?.[1] ?? body;
  return doc.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("the frame's sandbox and policies", () => {
  it("lets the page's listeners run, and keeps the letter's own scripts shut", () => {
    const { body } = render(MailFrame, { props: { html: "<p>x</p>", allowRemote: false, onLink: () => {} } });
    // Without allow-scripts WebKitGTK never calls the listeners of links, hover and keys (#70).
    expect(body).toContain('sandbox="allow-same-origin allow-scripts"');
    // Forms, popups, top navigation and downloads stay off.
    expect(body).not.toMatch(/allow-(forms|popups|top-navigation|downloads|modals)/);
    const doc = srcdoc({});
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/unsafe-eval|script-src[^;]*'unsafe/);
    // The window's policy, which the srcdoc takes too, has no inline scripts either.
    const csp = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf-8")).app.security.csp;
    expect(csp["script-src"]).toBe("'self'");
  });
});

describe("the frame's own policy", () => {
  const policy = (doc: string) => doc.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1] ?? "";

  it("stands first in the head, before the charset and anything of the letter", () => {
    const doc = srcdoc({ html: "<meta http-equiv='Content-Security-Policy' content=\"script-src *\"><p>x</p>" });
    expect(doc).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="[^"]*">\n<meta charset="utf-8">/);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("charset"));
    // The letter's own meta, if one gets through, comes after ours (and a policy can only be narrowed).
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("script-src *"));
  });

  it("shuts scripts, plugins, frames, <base> and forms by itself, not through the window's policy", () => {
    const csp = policy(srcdoc({}));
    for (const part of ["default-src 'none'", "script-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*'unsafe|script-src[^;]*'self/);
  });

  it("lets pictures in from the network only when allowed", () => {
    expect(policy(srcdoc({ allowRemote: false }))).toMatch(/img-src data: ;/);
    expect(policy(srcdoc({ allowRemote: true }))).toContain("img-src data: https: http:;");
  });
});

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

  it("puts the code colours of a Markdown letter into the frame's own styles, with no script", () => {
    // The highlighter runs before the frame (ReaderBody.svelte); its styles travel in the
    // letter's HTML and so into the srcdoc, and the frame runs no script (decision on #45).
    const html = '<pre><code class="language-sql">SELECT 1</code></pre>';
    const doc = srcdoc({ markdown: true, html: HL_CSS + html });
    expect(doc).toContain(".hl-kw{color:#a626a4}");
    expect(doc).toContain("hl-kw");
    expect(doc).not.toContain("<script");
  });

  it("turns DNS prefetching off, so a letter's link does not resolve ahead of a click", () => {
    expect(srcdoc({})).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
  });
});
