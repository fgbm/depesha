// Minimal W3C WebDriver client for tauri-driver: just the commands the E2E test uses.

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export class Driver {
  constructor(base = "http://127.0.0.1:4444") {
    this.base = base;
    this.session = null;
  }

  async req(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const v = json.value ?? {};
      throw new Error(`${method} ${path}: ${v.error ?? res.status} ${v.message ?? ""}`.trim());
    }
    return json.value;
  }

  s(path) {
    return `/session/${this.session}${path}`;
  }

  async start(application, env = {}) {
    const v = await this.req("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application, env } } },
    });
    this.session = v.sessionId;
  }

  async quit() {
    if (this.session) await this.req("DELETE", this.s("")).catch(() => {});
    this.session = null;
  }

  async find(css) {
    const v = await this.req("POST", this.s("/element"), { using: "css selector", value: css });
    return v[ELEMENT];
  }

  async findAll(css) {
    const v = await this.req("POST", this.s("/elements"), { using: "css selector", value: css });
    return v.map((e) => e[ELEMENT]);
  }

  async xpath(xp) {
    const v = await this.req("POST", this.s("/element"), { using: "xpath", value: xp });
    return v[ELEMENT];
  }

  async click(el) {
    await this.reveal(el);
    await this.req("POST", this.s(`/element/${el}/click`), {});
  }

  async type(el, text) {
    await this.reveal(el);
    await this.req("POST", this.s(`/element/${el}/value`), { text });
  }

  async clear(el) {
    await this.reveal(el);
    await this.req("POST", this.s(`/element/${el}/clear`), {});
  }

  /** Hovers an element with a real pointer, so CSS :hover applies. */
  async moveTo(el) {
    // An origin element outside the viewport makes pointerMove fail with «move target out of bounds».
    await this.reveal(el);
    await this.req("POST", this.s("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [{ type: "pointerMove", duration: 100, origin: { [ELEMENT]: el }, x: 0, y: 0 }],
        },
      ],
    });
  }

  async text(el) {
    return this.req("GET", this.s(`/element/${el}/text`));
  }

  /** The element that has focus, as WebDriver sees it. */
  async active() {
    const v = await this.req("GET", this.s("/element/active"));
    return v[ELEMENT];
  }

  /** Presses a key with a real key event, so the browser's default action happens too
   *  (Enter on the focused button = "\uE007"); a synthetic KeyboardEvent would not. */
  async pressKey(value) {
    await this.req("POST", this.s("/actions"), {
      actions: [{ type: "key", id: "kbd", actions: [{ type: "keyDown", value }, { type: "keyUp", value }] }],
    });
  }

  /** A key with modifiers held, as real key events: `mods` are WebDriver key codes ("\uE009" is Ctrl). */
  async chord(mods, key) {
    await this.req("POST", this.s("/actions"), {
      actions: [
        {
          type: "key",
          id: "kbd",
          actions: [...mods, key].map((value) => ({ type: "keyDown", value })).concat([key, ...[...mods].reverse()].map((value) => ({ type: "keyUp", value }))),
        },
      ],
    });
  }

  /** A real click `dx`, `dy` pixels from the middle of an element, which is how WebDriver measures offsets. */
  async clickAt(el, dx, dy) {
    await this.reveal(el);
    await this.req("POST", this.s("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 50, origin: { [ELEMENT]: el }, x: Math.round(dx), y: Math.round(dy) },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  async exec(script, ...args) {
    return this.req("POST", this.s("/execute/sync"), { script, args });
  }

  /** The window's size and place. */
  async rect() {
    return this.req("GET", this.s("/window/rect"));
  }

  async setRect(width, height) {
    return this.req("POST", this.s("/window/rect"), { width, height });
  }

  async screenshot() {
    return Buffer.from(await this.req("GET", this.s("/screenshot")), "base64");
  }

  /** Waits until `fn` returns a truthy value; returns it. */
  async until(what, fn, timeoutMs = 15000, stepMs = 250) {
    const started = Date.now();
    let lastErr;
    while (Date.now() - started < timeoutMs) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error(`timeout waiting for ${what}${lastErr ? `: ${lastErr.message}` : ""}`);
  }

  /** Clicks a button by its visible text. Find and click are retried together: the page may
   *  re-render between them, and the found element is gone («stale element reference»). */
  async button(label, timeoutMs = 10000) {
    await this.until(`button "${label}"`, async () => {
      const el = await this.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(label)})]`);
      if (!el) return false;
      await this.click(el);
      return true;
    }, timeoutMs);
  }

  /** WebKitWebDriver does not scroll nested scroll containers (modals) by itself. */
  async reveal(el) {
    await this.exec("arguments[0].scrollIntoView({ block: 'nearest' })", { [ELEMENT]: el }).catch(() => {});
  }

  /** Text of the whole page body. */
  async bodyText() {
    return this.exec("return document.body.innerText");
  }
}

export const ELEMENT_KEY = ELEMENT;
