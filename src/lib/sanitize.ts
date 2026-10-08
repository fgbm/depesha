// What may stand in the letter's visual editor. Everything put into it goes through
// here: the letter it opens with (a quote, a draft) and whatever is pasted or dropped.
// The backend cleans the HTML once more before it leaves (`compose_html`).

import DOMPurify from "dompurify";
import { QUOTE_CLASS, SIGNATURE_CLASS } from "./richtext";

const OWN_CLASSES = new Set([SIGNATURE_CLASS, QUOTE_CLASS]);

/** Attributes whose value a browser reads as an address and follows. */
const URI_ATTRS = new Set(["src", "href", "background", "poster", "srcset", "cite", "formaction", "action", "longdesc"]);

/**
 * A value as a browser's URL parser will read it: ASCII whitespace and control characters
 * are thrown away and `\` is taken for `/`. A tracker hides its scheme behind them
 * (`ht&#9;tps:\\evil`), so the value is read this way before it is looked at.
 */
function unconfuse(value: string): string {
  return value.replace(/[\u0000-\u0020\\]/g, (c) => (c === "\\" ? "/" : ""));
}

/** A style that reaches out for a resource: `url(`, `image-set(`, `image(`, `src(` and CSS
 *  escaping (`\`) all load something the letter did not ask for. */
function remoteStyle(style: string): boolean {
  const plain = unconfuse(style).toLowerCase();
  return plain.includes("url") || plain.includes("image-set") || plain.includes("image(") || plain.includes("src(") || style.includes("\\");
}

/** Elements that are neither text nor formatting: forms, media, embedded documents. */
const FORBID_TAGS = ["form", "input", "button", "textarea", "select", "option", "style", "link", "meta", "base", "iframe", "frame", "object", "embed", "video", "audio", "source", "track", "picture", "svg", "math", "dialog", "template", "slot"];

/** A pasted letter keeps its words, lines, lists, links and simple emphasis; no pictures, no layout. */
const PASTE_TAGS = ["p", "div", "br", "span", "b", "strong", "i", "em", "u", "s", "strike", "del", "sub", "sup", "code", "pre", "ul", "ol", "li", "a", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "td", "th"];

function instance(): ReturnType<typeof DOMPurify> {
  const purify = DOMPurify(window);
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "class") {
      // Depesha's blocks only: a letter's own classes could take the app's styles.
      data.attrValue = data.attrValue.split(/\s+/).filter((c) => OWN_CLASSES.has(c)).join(" ");
      if (!data.attrValue) data.keepAttr = false;
    } else if (data.attrName === "style") {
      // Nothing in the letter may be laid over the app.
      data.attrValue = data.attrValue.replace(/(^|;)\s*(position|z-index|inset|top|left|right|bottom)\s*:[^;]*/gi, "$1");
      // A style that loads a resource in any spelling goes whole.
      if (remoteStyle(data.attrValue)) data.keepAttr = false;
    } else if (URI_ATTRS.has(data.attrName)) {
      // A hidden character in an address is no innocent typo: the browser drops it and
      // follows the address anyway, so the attribute goes.
      const plain = unconfuse(data.attrValue);
      if (plain !== data.attrValue && (plain.includes("//") || /^[a-z][a-z0-9+.-]*:/i.test(plain))) {
        data.keepAttr = false;
      }
    }
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") node.setAttribute("rel", "noopener noreferrer");
  });
  return purify;
}

let purify: ReturnType<typeof DOMPurify> | null = null;

/**
 * The letter the editor opens with. Pictures stay as they came: a quote carries only
 * the ones the reader showed (the remote-pictures rule applied there).
 */
export function cleanEditorHtml(html: string): string {
  purify ??= instance();
  return purify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR: ["id", "name", "srcset", "background"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|gif|jpe?g|webp);)/i,
  });
}

/** Pasted or dropped HTML: no pictures (a remote one would load at once), no styles. */
export function cleanPastedHtml(html: string): string {
  purify ??= instance();
  return purify.sanitize(html, {
    ALLOWED_TAGS: PASTE_TAGS,
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

/**
 * HTML shown in the window outside the letter's frame (a signature preview): no remote
 * resource is loaded, the same rule the editor applies. Used where DOMPurify is not: the
 * picture of its own (`data:`) stays, a remote one and a style that reaches out go.
 */
export function cleanRemoteHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const el of doc.querySelectorAll<HTMLElement>("img, source")) {
    const src = unconfuse(el.getAttribute("src") ?? "").toLowerCase();
    if (src.includes("http:") || src.includes("https:") || src.includes("//")) {
      el.remove();
      changed = true;
    }
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[style]")) {
    if (remoteStyle(el.getAttribute("style") ?? "")) {
      el.removeAttribute("style");
      changed = true;
    }
  }
  return changed ? doc.body.innerHTML : html;
}
