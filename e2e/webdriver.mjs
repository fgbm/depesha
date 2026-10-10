// Minimal W3C WebDriver client for tauri-driver: just the commands the E2E test uses.

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export class Driver {
  constructor(base = "http://127.0.0.1:4444") {
    this.base = base;
    this.session = null;
  }

  async req(method, path, body, timeoutMs) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Without it fetch waits 5 minutes for the headers (HeadersTimeoutError): a driver whose app never came up.
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
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

  async start(application, env = {}, timeoutMs) {
    const v = await this.req("POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application, env } } },
    }, timeoutMs);
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

/** How many polls in a row the sidebar must keep its shape before it counts as settled. */
const SETTLED_POLLS = 5;

/**
 * The shape of the sidebar: the name and the top of each row, nothing else. The counters change
 * on their own and move no row, so they stay out of it. `rows` are `[name, top]` pairs.
 */
export function sidebarShape(rows) {
  return rows.map(([name, top]) => `${name}@${Math.round(top)}`).join("|");
}

/**
 * Reloads the page and waits for the sidebar to take its final shape. It fills in after the load:
 * the counters come, then rows such as «Snoozed» appear and push the tree down. A click aimed
 * before that lands on what moved under it (the mailbox's name, which folds the tree and keeps
 * it folded, #129).
 */
export async function reloadWindow(d, timeoutMs = 15000) {
  await d.exec("window.__before = true; location.reload()");
  await d.until("window reloaded", async () => (await d.exec("return document.readyState === 'complete' && !window.__before && !!document.querySelector('button')")), timeoutMs);
  const seen = [];
  let same = 0;
  try {
    await d.until("sidebar settled", async () => {
      const rows = await d.exec(
        // A narrow window has the strip of tiles instead of the rows: their name is the label.
        "return [...document.querySelectorAll('nav.side .item .name, nav.side .account-name .name, nav.side .tile')].map((n) => [n.innerText.trim() || n.getAttribute('aria-label') || '', n.getBoundingClientRect().top])",
      );
      const now = rows.length ? sidebarShape(rows) : "";
      same = now && now === seen.at(-1) ? same + 1 : 0;
      seen.push(now);
      return same >= SETTLED_POLLS;
    }, timeoutMs, 150);
  } catch (e) {
    throw new Error(`${e.message}; последние отпечатки панели: ${JSON.stringify(seen.slice(-2))}`);
  }
}
