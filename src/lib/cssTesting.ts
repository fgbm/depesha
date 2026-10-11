// For component tests: the style block of a .svelte file (or a .css file) put into jsdom, so a
// test asks what the browser's cascade says about an element instead of reading the source.

import { readFileSync } from "node:fs";

/** Puts the styles of `file` (relative to `base`) into the document; returns what removes them. */
export function useStyles(base: string, file: string): () => void {
  const text = readFileSync(new URL(file, base), "utf8");
  const css = (/<style[^>]*>([\s\S]*?)<\/style>/.exec(text)?.[1] ?? text).replace(/:global\(([^)]*)\)/g, "$1");
  const el = document.createElement("style");
  el.textContent = css;
  document.head.append(el);
  return () => el.remove();
}

/** The rules of the document's style sheets whose selector is exactly `selector`. */
export function rulesFor(selector: string): CSSStyleRule[] {
  const all = [...document.styleSheets].flatMap((s) => [...s.cssRules]) as CSSStyleRule[];
  return all.filter((r) => r.selectorText?.replace(/\s+/g, " ") === selector);
}

/** Every selector in the document's style sheets that has a pseudo-element. */
export function pseudoSelectors(): string[] {
  const all = [...document.styleSheets].flatMap((s) => [...s.cssRules]) as CSSStyleRule[];
  return all.map((r) => r.selectorText ?? "").filter((s) => s.includes("::"));
}
