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
    await this.req("POST", this.s(`/element/${el}/click`), {});
  }

  async type(el, text) {
    await this.req("POST", this.s(`/element/${el}/value`), { text });
  }

  async clear(el) {
    await this.req("POST", this.s(`/element/${el}/clear`), {});
  }

  async text(el) {
    return this.req("GET", this.s(`/element/${el}/text`));
  }

  async exec(script, ...args) {
    return this.req("POST", this.s("/execute/sync"), { script, args });
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

  /** Clicks a button by its visible text. */
  async button(label, timeoutMs = 10000) {
    const el = await this.until(`button "${label}"`, () =>
      this.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(label)})]`),
    timeoutMs);
    await this.click(el);
  }

  /** Text of the whole page body. */
  async bodyText() {
    return this.exec("return document.body.innerText");
  }
}

export const ELEMENT_KEY = ELEMENT;
