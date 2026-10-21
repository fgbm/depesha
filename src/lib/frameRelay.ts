// The script a letter's frame runs, and the way it talks to the app (#124). The frame has an
// opaque origin: the parent cannot reach into it, it cannot reach the app, and the only door
// between them is `postMessage`. The relay is the frame's whole part of the bargain — links,
// hover, keys, the theme's colours and the height of the letter. Covered by frameRelay.test.ts.

import { LINK_SELECTOR } from "./frameLink";

/** The colours a themed frame takes from the window, which its own document cannot see. */
export const THEME_VARS = ["--ink", "--muted", "--line", "--link"] as const;

/**
 * The tallest a letter may tell the app it is, in pixels. A frame of unknown origin speaks, so
 * its arithmetic is only as good as this bound: a letter of any real length fits far below it.
 */
export const FRAME_MAX_HEIGHT = 200_000;

/**
 * The script the letter's frame runs, delivered inline and allowed by its hash alone: `'self'`
 * means nothing in a frame whose origin is opaque, whatever the engine.
 */
export const FRAME_RELAY = `(function () {
  var app = window.parent;
  if (!app || app === window) return;
  var VARS = ${JSON.stringify(THEME_VARS)};
  var MAX_HEIGHT = ${FRAME_MAX_HEIGHT};
  var KEYS = [];
  function send(msg) {
    msg.depeshaFrame = 1;
    app.postMessage(msg, "*");
  }
  function hrefOf(a) {
    return a.getAttribute("href") || "";
  }
  function linkAt(target) {
    return target && target.closest ? target.closest(${JSON.stringify(LINK_SELECTOR)}) : null;
  }
  // Whether this press is the app's, and the page must keep its own meaning of it: print, select
  // all, the menu of a row. The app answers through postMessage, too late for a default action, so
  // the list of keys it takes comes ahead of time. Copy, cut, paste, selection and the scroll keys
  // are not in it and stay with the document.
  function ours(e) {
    var mod = !!(e.ctrlKey || e.metaKey);
    return KEYS.some(function (k) {
      if (!k || !!k.mod !== mod || !!k.alt !== !!e.altKey) return false;
      if (k.shift !== undefined && !!k.shift !== !!e.shiftKey) return false;
      return k.code ? e.code === k.code : e.key === k.key;
    });
  }
  // The height of the letter, for a frame that stands in a conversation: the app gives such a
  // frame the height of its own letter, so the conversation scrolls as one piece and the letter
  // gets no scroll of its own (#А7). The body's box is measured, not the document's scroll
  // height: the latter never falls below the frame's viewport, and so could not follow a letter
  // that shrinks — a quote folded back.
  var lastHeight = -1;
  var heightTimer = 0;
  function heightOf() {
    var b = document.body;
    if (!b) return 0;
    var cs = window.getComputedStyle(b);
    var box = b.getBoundingClientRect().height;
    var h = box + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    // A body stretched to the frame (height:100%) reports the frame's own height, and would grow
    // with every answer it gave. The document's scroll height is the letter's height then, its
    // overflow included.
    if (Math.abs(box - window.innerHeight) <= 2) h = document.documentElement.scrollHeight;
    if (!(h > 0)) return 0;
    return Math.min(Math.round(h), MAX_HEIGHT);
  }
  function tellHeight() {
    heightTimer = 0;
    var h = heightOf();
    if (h === lastHeight) return;
    lastHeight = h;
    send({ type: "height", height: h });
  }
  // One message per hundred milliseconds: a long letter grows with every picture that lands,
  // and the app needs its height, not every step of it.
  function watchHeight() {
    if (!heightTimer) heightTimer = setTimeout(tellHeight, 100);
  }
  function watchBody() {
    if (window.ResizeObserver && document.body) new ResizeObserver(watchHeight).observe(document.body);
    watchHeight();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchBody);
  else watchBody();
  window.addEventListener("load", watchHeight);
  window.addEventListener("resize", watchHeight);
  // A picture arrives after the load and a quote opens without one: both change the body alone.
  document.addEventListener("load", watchHeight, true);
  document.addEventListener("click", function (e) {
    var a = linkAt(e.target);
    if (!a) return;
    e.preventDefault();
    var href = hrefOf(a);
    if (href && href.charAt(0) !== "#") send({ type: "link", href: href });
  });
  document.addEventListener("mouseover", function (e) {
    var a = linkAt(e.target);
    send({ type: "hover", href: a ? hrefOf(a) : "" });
  });
  document.addEventListener("mouseleave", function () {
    send({ type: "hover", href: "" });
  });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    if (ours(e)) e.preventDefault();
    send({ type: "key", key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat });
  });
  window.addEventListener("message", function (e) {
    if (e.source !== app) return;
    var msg = e.data;
    if (!msg || msg.depeshaFrame !== 1) return;
    if (msg.type === "keys") {
      if (Array.isArray(msg.keys)) KEYS = msg.keys;
      return;
    }
    if (msg.type !== "theme") return;
    var style = document.documentElement.style;
    if (typeof msg.colorScheme === "string") style.colorScheme = msg.colorScheme;
    var vars = msg.vars;
    if (!vars) return;
    VARS.forEach(function (v) {
      if (typeof vars[v] === "string") style.setProperty(v, vars[v]);
    });
  });
})();`;

/**
 * The relay's hash, as a policy source. Every byte of FRAME_RELAY must show up here: the frame's
 * `<meta>` policy and the window's (`tauri.conf.json`) both list it, or the relay does not run.
 */
export const RELAY_HASH = "'sha256-5FX+6W5RVf6JttREFCX4wRurqD4iGbstlpK1hTFsx2Y='";

/** What the frame sends: a click on a link, a hover, a key pressed in the letter, its height. */
export type FrameMessage =
  | { type: "link"; href: string }
  | { type: "hover"; href: string }
  | { type: "height"; height: number }
  | { type: "key"; key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean };

/** A key as a frame's own document sees it: what the relay matches a press against. */
export interface FrameKey {
  /** The letter's place on the keyboard (`KeyP`), so a key keeps its meaning in any layout. */
  code?: string;
  /** A character, or a key's name as the event spells it (" " for Space). */
  key?: string;
  mod: boolean;
  alt: boolean;
  /** Absent where Shift is part of the character itself ("#" is Shift+3). */
  shift?: boolean;
}

/** The keys the app takes from the frame, so the relay can stop their default in time. */
export interface KeysMessage {
  depeshaFrame: 1;
  type: "keys";
  keys: FrameKey[];
}

/** The colours a themed frame is given, and the scheme to paint it in. */
export interface ThemeMessage {
  depeshaFrame: 1;
  type: "theme";
  colorScheme: string;
  vars: Record<string, string>;
}

/** The theme change a frame is told about: the four colours and nothing else travels with it. */
export function themeMessage(css: CSSStyleDeclaration): ThemeMessage {
  const vars: Record<string, string> = {};
  for (const v of THEME_VARS) vars[v] = css.getPropertyValue(v).trim();
  return { depeshaFrame: 1, type: "theme", colorScheme: css.colorScheme || "light", vars };
}

export const keysMessage = (keys: FrameKey[]): KeysMessage => ({ depeshaFrame: 1, type: "keys", keys });

/** Delivers a message to a frame of an opaque origin: `*` is the only address such a frame has. */
export function toFrame(win: Window | null | undefined, msg: KeysMessage | ThemeMessage): void {
  win?.postMessage(msg, "*");
}

const str = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";

/**
 * The message as one of the relay's, or null: another window's, a letter's own script's, or a
 * shape no relay sends. The fields are checked one by one — a message is a stranger's word.
 */
export function frameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.depeshaFrame !== 1) return null;
  if (m.type === "link" || m.type === "hover") return str(m.href) ? { type: m.type, href: m.href } : null;
  // A height is a number of pixels the app will give a frame: a string, a NaN or a figure past
  // the bound is no relay's word, and the frame keeps the height it had.
  if (m.type === "height") {
    const h = m.height;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 0 || h > FRAME_MAX_HEIGHT) return null;
    return { type: "height", height: Math.round(h) };
  }
  if (m.type !== "key") return null;
  const { key, code, ctrlKey, metaKey, altKey, shiftKey, repeat } = m;
  if (!str(key) || !str(code) || !bool(ctrlKey) || !bool(metaKey) || !bool(altKey) || !bool(shiftKey) || !bool(repeat)) return null;
  return { type: "key", key, code, ctrlKey, metaKey, altKey, shiftKey, repeat };
}
