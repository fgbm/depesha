import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { FRAME_RELAY, RELAY_HASH, THEME_VARS, frameMessage, type FrameKey } from "./frameRelay";

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
  const document = { documentElement: { style }, addEventListener: on };
  const app = { postMessage: (msg: Record<string, unknown>, target: string) => posts.push({ msg, target }) };
  const window: Record<string, unknown> = { addEventListener: on, document };
  window.parent = inFrame ? app : window;
  runInNewContext(FRAME_RELAY, { window, document });
  const fire = (type: string, e: unknown) => (heard.get(type) ?? []).forEach((fn) => fn(e));
  const fromParent = (data: unknown) => fire("message", { source: app, data });
  /** The app's answer to "which keys do you take from the frame" (#124). */
  const claim = (keys: FrameKey[]) => fromParent({ depeshaFrame: 1, type: "keys", keys });
  const anchor = (href: string) => ({ closest: (sel: string) => (sel === "a, area" ? { getAttribute: () => href } : null) });
  return { posts, fire, style, app, anchor, fromParent, claim };
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

  it("does nothing at all when it is not in a frame", () => {
    const env = frameEnv({ inFrame: false });
    env.fire("keydown", press({ key: "k", code: "KeyK", ctrlKey: true }));
    expect(env.posts).toEqual([]);
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
  it("takes the three the relay sends", () => {
    expect(frameMessage({ depeshaFrame: 1, type: "link", href: "https://example.com/x" })).toEqual({ type: "link", href: "https://example.com/x" });
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
    ]) {
      expect(frameMessage(data)).toBeNull();
    }
  });
});
