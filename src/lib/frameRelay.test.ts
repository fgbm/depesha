import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { FRAME_MAX_HEIGHT, FRAME_RELAY, RELAY_HASH, THEME_VARS, frameMessage, type FrameKey } from "./frameRelay";

describe("the relay's hash", () => {
  it("is the hash of the relay itself", () => {
    const hash = createHash("sha256").update(FRAME_RELAY, "utf8").digest("base64");
    expect(RELAY_HASH).toBe(`'sha256-${hash}'`);
  });

  it("is allowed by the window's own policy too: a srcdoc document takes it as well", () => {
    const csp = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf-8")).app.security.csp;
    expect(csp["script-src"]).toContain(RELAY_HASH);
    expect(csp["script-src"]).toContain("'self'");
  });
});

/** A window like the frame's: a document that hears events, and a parent that hears what is posted. */
function frameEnv({ inFrame = true } = {}) {
  const posts: { msg: Record<string, unknown>; target: string }[] = [];
  const heard = new Map<string, ((e: unknown) => void)[]>();
  const on = (type: string, fn: (e: unknown) => void) => heard.set(type, [...(heard.get(type) ?? []), fn]);
  const style = { colorScheme: "", vars: {} as Record<string, string>, setProperty(k: string, v: string) { this.vars[k] = v; } };
  /** The letter's body: the relay reports its box, so a test grows and shrinks the letter here. */
  const body = { height: 800, getBoundingClientRect: () => ({ height: body.height }) };
  const documentBox = { marginTop: "18px", marginBottom: "18px" };
  const document = { readyState: "complete", documentElement: { style, scrollHeight: 1000 }, body, addEventListener: on };
  const app = { postMessage: (msg: Record<string, unknown>, target: string) => posts.push({ msg, target }) };
  const window: Record<string, unknown> = {
    innerHeight: 1000,
    addEventListener: on,
    document,
    getComputedStyle: (el: unknown) => (el === body ? documentBox : {}),
  };
  window.parent = inFrame ? app : window;
  /** What the user chose inside the letter, as the frame's own document reports it. */
  let selection = { isCollapsed: true, toString: () => "" };
  window.getSelection = () => selection;
  const select = (on: boolean) => {
    selection = { isCollapsed: !on, toString: () => (on ? "Тема письма" : "") };
  };
  // The relay's clock, run by hand: a change of the letter is followed one timer tick later.
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let now = 0;
  let nextId = 1;
  const setTimeout = (fn: () => void, ms = 0) => {
    const t = { id: nextId++, at: now + ms, fn };
    timers.push(t);
    return t.id;
  };
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  /** The frame's observer, fired by hand as the browser fires it when the body changes. */
  const observers: (() => void)[] = [];
  class ResizeObserver {
    constructor(fn: () => void) {
      observers.push(fn);
    }
    observe() {}
  }
  const resize = () => observers.forEach((fn) => fn());
  window.ResizeObserver = ResizeObserver;
  runInNewContext(FRAME_RELAY, { window, document, setTimeout, ResizeObserver });
  const fire = (type: string, e: unknown) => (heard.get(type) ?? []).forEach((fn) => fn(e));
  const fromParent = (data: unknown) => fire("message", { source: app, data });
  /** The app's answer to "which keys do you take from the frame" (#124). */
  const claim = (keys: FrameKey[]) => fromParent({ depeshaFrame: 1, type: "keys", keys });
  const anchor = (href: string) => ({ closest: (sel: string) => (sel === "a, area" ? { getAttribute: () => href } : null) });
  return { posts, fire, style, app, anchor, fromParent, claim, body, document, advance, resize, select };
}

/** A press as the frame's document gets it. */
const press = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault: vi.fn(), ...init });

describe("what the relay of a frame tells the app", () => {
  it("hands the address of a clicked link over instead of following it", () => {
    const env = frameEnv();
    const e = { target: env.anchor("https://example.com/x"), preventDefault: vi.fn() };
    env.fire("click", e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(env.posts).toEqual([{ target: "*", msg: { depeshaFrame: 1, type: "link", href: "https://example.com/x" } }]);
  });

  it("keeps a link to an anchor of the letter, and a link without an address, to itself", () => {
    const env = frameEnv();
    for (const href of ["#part", ""]) {
      const e = { target: env.anchor(href), preventDefault: vi.fn() };
      env.fire("click", e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    expect(env.posts).toEqual([]);
  });

  it("shows the address of a hovered link, and clears it when the pointer leaves", () => {
    const env = frameEnv();
    env.fire("mouseover", { target: env.anchor("https://example.com/x") });
    env.fire("mouseleave", {});
    expect(env.posts.map((p) => p.msg)).toEqual([
      { depeshaFrame: 1, type: "hover", href: "https://example.com/x" },
      { depeshaFrame: 1, type: "hover", href: "" },
    ]);
  });

  it("stops the engine's own menu over the letter, and keeps it for text chosen to copy", () => {
    const env = frameEnv();
    const plain = { target: { closest: () => null }, preventDefault: vi.fn() };
    env.fire("contextmenu", plain);
    expect(plain.preventDefault).toHaveBeenCalled();
    // Chosen text has «Copy» in that menu, and that is the whole of its use here.
    env.select(true);
    const chosen = { target: { closest: () => null }, preventDefault: vi.fn() };
    env.fire("contextmenu", chosen);
    expect(chosen.preventDefault).not.toHaveBeenCalled();
    // A field of the letter keeps cut, copy, paste and the spelling corrections.
    env.select(false);
    const field = { target: { closest: (sel: string) => (sel.includes("textarea") ? {} : null) }, preventDefault: vi.fn() };
    env.fire("contextmenu", field);
    expect(field.preventDefault).not.toHaveBeenCalled();
  });

  it("does nothing at all when it is not in a frame", () => {
    const env = frameEnv({ inFrame: false });
    env.fire("keydown", press({ key: "k", code: "KeyK", ctrlKey: true }));
    expect(env.posts).toEqual([]);
  });
});

describe("the height a frame reports for its letter", () => {
  /** What the frame told the app about its height, in the order it said it. */
  const heights = (env: ReturnType<typeof frameEnv>) => env.posts.map((p) => p.msg).filter((m) => m.type === "height").map((m) => m.height);

  it("tells the app the height of its letter once the frame has settled", () => {
    const env = frameEnv();
    expect(heights(env)).toEqual([]);
    env.advance(100);
    // The body's box with its margins: the whole of the letter's document, and no scrollbar's width.
    expect(env.posts).toEqual([{ target: "*", msg: { depeshaFrame: 1, type: "height", height: 836 } }]);
  });

  it("says it again when the letter grows or shrinks, and stays still when nothing changed", () => {
    const env = frameEnv();
    env.advance(100);
    // A quote of the letter opens, a picture lands: the body changed, the document around it did not.
    env.body.height = 2400;
    env.resize();
    env.advance(100);
    env.body.height = 400;
    env.fire("load", {});
    env.advance(100);
    // Nothing changed, and the load of the window asks again: the same height is not news.
    env.fire("load", {});
    env.advance(500);
    expect(heights(env)).toEqual([836, 2436, 436]);
  });

  it("sends one message for a burst of changes, not one per picture", () => {
    const env = frameEnv();
    env.advance(100);
    for (let i = 1; i <= 20; i++) {
      env.body.height = 800 + i * 100;
      env.resize();
    }
    expect(heights(env)).toEqual([836]);
    env.advance(100);
    expect(heights(env)).toEqual([836, 2836]);
  });

  it("keeps a body stretched to the frame from growing with every answer it gave", () => {
    const env = frameEnv();
    // `html,body{height:100%}`: the body is the frame, and the letter overflows it.
    env.body.height = 1000;
    env.document.documentElement.scrollHeight = 3000;
    env.advance(100);
    expect(heights(env)).toEqual([3000]);
  });

  it("keeps a letter of any length within the app's bound", () => {
    const env = frameEnv();
    env.body.height = 10_000_000;
    env.advance(100);
    expect(heights(env)).toEqual([FRAME_MAX_HEIGHT]);
  });
});

describe("the keys of a frame's relay", () => {
  it("sends a key on, and leaves the plain arrows to the letter", () => {
    const env = frameEnv();
    env.fire("keydown", press({ key: "ArrowDown", code: "ArrowDown" }));
    env.fire("keydown", press({ key: "k", code: "KeyK", ctrlKey: true }));
    expect(env.posts.map((p) => p.msg)).toEqual([
      { depeshaFrame: 1, type: "key", key: "k", code: "KeyK", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false },
    ]);
  });

  it("holds no key for itself before the app has said which ones it takes", () => {
    const env = frameEnv();
    const e = press({ key: "p", code: "KeyP", ctrlKey: true });
    env.fire("keydown", e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("stops the default of a key the app claimed, in any layout", () => {
    // Print and select all: the app's, and a static page would print and select on its own.
    for (const [key, code] of [["p", "KeyP"], ["з", "KeyP"], ["ф", "KeyA"]] as const) {
      const env = frameEnv();
      env.claim([{ code, mod: true, alt: false, shift: false }]);
      const e = press({ key, code, ctrlKey: true });
      env.fire("keydown", e);
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it("keeps Mod+A with the document when the app did not claim it", () => {
    // A letter's own window runs no «Select all»: there the text of the letter is what Ctrl+A
    // selects, and the frame must not stop it (#124). The app still hears the key.
    const env = frameEnv();
    env.claim([{ code: "KeyP", mod: true, alt: false, shift: false }]);
    const e = press({ key: "a", code: "KeyA", ctrlKey: true });
    env.fire("keydown", e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(env.posts.map((p) => p.msg)).toEqual([
      { depeshaFrame: 1, type: "key", key: "a", code: "KeyA", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false },
    ]);
  });

  it("keeps a copy, and a letter that types nothing of the page's, with the document", () => {
    const env = frameEnv();
    env.claim([{ code: "KeyP", mod: true, alt: false, shift: false }]);
    for (const init of [{ key: "c", code: "KeyC", ctrlKey: true }, { key: "e", code: "KeyE" }]) {
      const e = press(init);
      env.fire("keydown", e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("matches a named key and a space as the event spells them", () => {
    const env = frameEnv();
    env.claim([{ key: " ", mod: false, alt: false, shift: false }, { key: "F10", mod: false, alt: false, shift: true }]);
    const stops = (key: string, shiftKey: boolean) => {
      const e = press({ key, shiftKey });
      env.fire("keydown", e);
      return e.preventDefault;
    };
    expect(stops(" ", false)).toHaveBeenCalled();
    expect(stops("F10", true)).toHaveBeenCalled();
    // Shift is part of a named key's name: Shift+Space is the document's.
    expect(stops(" ", true)).not.toHaveBeenCalled();
  });
});

describe("what the relay of a frame takes from the app", () => {
  it("paints the theme's colours and its scheme, and no variable but the four", () => {
    const env = frameEnv();
    const vars = Object.fromEntries([...THEME_VARS.map((v) => [v, "#123"]), ["--other", "#456"]]);
    env.fromParent({ depeshaFrame: 1, type: "theme", colorScheme: "dark", vars });
    expect(env.style.colorScheme).toBe("dark");
    expect(env.style.vars).toEqual(Object.fromEntries(THEME_VARS.map((v) => [v, "#123"])));
  });

  it("hears nobody but the parent", () => {
    const env = frameEnv();
    env.fire("message", { source: {}, data: { depeshaFrame: 1, type: "theme", colorScheme: "dark", vars: { "--ink": "#000" } } });
    env.fromParent({ type: "theme", colorScheme: "dark", vars: { "--ink": "#000" } });
    expect(env.style.colorScheme).toBe("");
    expect(env.style.vars).toEqual({});
    // Nor does a key claimed by another window become the page's to stop.
    env.fire("message", { source: {}, data: { depeshaFrame: 1, type: "keys", keys: [{ code: "KeyP", mod: true, alt: false }] } });
    const e = press({ key: "p", code: "KeyP", ctrlKey: true });
    env.fire("keydown", e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("the messages the app accepts from a frame", () => {
  it("takes the four the relay sends", () => {
    expect(frameMessage({ depeshaFrame: 1, type: "link", href: "https://example.com/x" })).toEqual({ type: "link", href: "https://example.com/x" });
    expect(frameMessage({ depeshaFrame: 1, type: "height", height: 1234.6 })).toEqual({ type: "height", height: 1235 });
    expect(frameMessage({ depeshaFrame: 1, type: "hover", href: "" })).toEqual({ type: "hover", href: "" });
    const key = { depeshaFrame: 1, type: "key", key: "k", code: "KeyK", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false };
    expect(frameMessage(key)).toEqual({ type: "key", key: "k", code: "KeyK", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false });
  });

  it("leaves a stranger's message, an unknown type and a broken field alone", () => {
    for (const data of [
      null,
      "link",
      {},
      { type: "link", href: "https://example.com/x" },
      { depeshaFrame: 2, type: "link", href: "https://example.com/x" },
      { depeshaFrame: 1, type: "open", href: "https://example.com/x" },
      { depeshaFrame: 1, type: "link", href: 7 },
      { depeshaFrame: 1, type: "key", key: "k", code: "KeyK", ctrlKey: "yes", metaKey: false, altKey: false, shiftKey: false, repeat: false },
      { depeshaFrame: 1, type: "theme", colorScheme: "dark", vars: {} },
      { depeshaFrame: 1, type: "height" },
      { depeshaFrame: 1, type: "height", height: "800" },
      { depeshaFrame: 1, type: "height", height: Number.NaN },
      { depeshaFrame: 1, type: "height", height: Number.POSITIVE_INFINITY },
      { depeshaFrame: 1, type: "height", height: -1 },
      { depeshaFrame: 1, type: "height", height: FRAME_MAX_HEIGHT + 1 },
    ]) {
      expect(frameMessage(data)).toBeNull();
    }
  });
});
