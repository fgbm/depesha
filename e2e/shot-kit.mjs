// What the two picture scripts share: e2e/shots.mjs (docs/screenshots/, the README) and
// e2e/release-shots.mjs (the pictures of a release's description). The real app (debug
// build) on a virtual display, driven over WebDriver: the profile, the driver, the helpers
// that find rows and fill fields, the login wizard, and the two-session start (the first
// session adds the mailbox and lets the script put data into the cache, the second shoots).
//
//   const kit = createKit({ out, tag, v8 });
//   try { await kit.boot({ prepare }); …shots with kit.shot(name)… } finally { await kit.finish(); }
//
// Env: DEPESHA_APP (binary), WEBKIT_DRIVER, E2E_DISPLAY (default :99), E2E_KEEP=1 leaves the
// temp profile. `v8`: the mail was seeded with `demo-seed 0.8.0` (the owner is Анна Крылова).

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createKit({ out, tag = "depesha-shots-", v8 = false }) {
  const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
  const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
  mkdirSync(out, { recursive: true });

  const profile = mkdtempSync(join(tmpdir(), tag));
  const env = {
    ...process.env,
    DISPLAY: process.env.E2E_DISPLAY ?? ":99",
    GDK_BACKEND: "x11",
    WAYLAND_DISPLAY: "",
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_DATA_HOME: join(profile, "data"),
    XDG_CACHE_HOME: join(profile, "cache"),
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    DEPESHA_NO_NOTIFICATIONS: "1",
    DEPESHA_E2E_ROOT: [profile, root].join(delimiter),
    LANGUAGE: "ru",
  };

  const d = new Driver();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shots = [];
  let driverProc = null;

  const helper = (...args) => execFileSync("python3", [join(root, "e2e/imap_helper.py"), ...args], { encoding: "utf-8" }).trim();
  const db = (sql) => execFileSync("sqlite3", [join(profile, "data/ru.depesha.mail/mail.sqlite"), sql], { encoding: "utf-8" }).trim();

  /** Writes the window as it is now into <out>/<name>.png. Toasts are transient and would date the picture: hidden. */
  async function shot(name) {
    await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility','hidden')").catch(() => {});
    await sleep(400);
    writeFileSync(join(out, `${name}.png`), await d.screenshot());
    await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
    const { width, height } = await d.rect();
    shots.push(`${name}.png ${width}×${height}`);
    console.log(`  · ${name}.png ${width}×${height}`);
  }

  const textOf = (css) => d.exec("return document.querySelector(arguments[0])?.innerText ?? ''", css);
  async function setInput(css, value) {
    const el = await d.find(css);
    await d.clear(el);
    await d.type(el, String(value));
  }
  async function setSelect(css, value) {
    await d.click(await d.find(`${css} .trigger`));
    await d.click(await d.until(`option ${value}`, () => d.find(`${css} [role=option][data-value="${value}"]`).catch(() => null)));
  }
  const press = (key, mods = {}) =>
    d.exec("window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[0], bubbles: true }, arguments[1])))", key, mods);
  async function invoke(cmd, args = {}) {
    const r = await d.req("POST", d.s("/execute/async"), {
      script:
        "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
      args: [cmd, args],
    });
    if (r.err) throw new Error(`${cmd}: ${r.err}`);
    return r.ok;
  }
  const sidebarText = () => d.exec("return document.querySelector('nav.side').innerText");
  const openFolder = (name) =>
    d.exec(
      `[...document.querySelectorAll('nav.side .item')].find((b) => (b.querySelector('.name') ?? b).innerText.trim() === arguments[0]).click();`,
      name,
    );
  async function rowBySubject(subject, timeoutMs = 20000) {
    const xpath = `//div[contains(@class,'row')][.//span[contains(@class,'subject') and contains(., ${JSON.stringify(subject)})]]`;
    return d.until(`row "${subject}"`, async () => {
      const row = await d.xpath(xpath).catch(() => null);
      if (row) return row;
      await d.exec(`const v = document.querySelector('.list .viewport');
        if (v) v.scrollTop = v.scrollTop + v.clientHeight >= v.scrollHeight - 1 ? 0 : v.scrollTop + v.clientHeight;`);
      return null;
    }, timeoutMs);
  }
  async function openBySubject(subject) {
    await d.click(await rowBySubject(subject));
    await d.until(`reader shows "${subject}"`, async () => (await textOf(".reader h1")).includes(subject));
  }
  const menuItem = (label) =>
    d.until(`menu item ${label}`, () =>
      d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`).catch(() => null),
    );

  /** The command palette: Ctrl+K, a search, Enter. Opens whatever the command is. */
  async function palette(search) {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), search);
    await d.type(await d.find(".palette .q"), "\uE007");
  }
  async function closeSettings() {
    // Esc clears the settings search first and closes the window second: press it a few times.
    for (let i = 0; i < 4 && (await d.findAll(".prefs")).length; i++) {
      await d.exec("document.querySelector('.modal.prefs')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await sleep(150);
    }
    await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
  }
  /** Throws the open composition away, so it leaves no draft behind. */
  async function discardCompose() {
    await d.click(await d.find(".compose [aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
  }

  /** Fills the login wizard, as the E2E does, and saves. */
  async function addAccount() {
    const [name, email] = v8 ? ["Анна Крылова", "anna@example.org"] : ["Кэрол Тестова", "carol@local.test"];
    await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"), 30000);
    await setInput(".wizard input[placeholder='Иван Петров']", name);
    await setInput(".wizard input[type=email]", email);
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "carol");
    await setSelect(".wizard fieldset:nth-of-type(1) .select", "plain");
    await setSelect(".wizard fieldset:nth-of-type(2) .select", "plain");
    const hosts = await d.findAll(".wizard fieldset .host input");
    const ports = await d.findAll(".wizard fieldset .port input");
    for (const [i, [host, port]] of [["127.0.0.1", 3143], ["127.0.0.1", 3025]].entries()) {
      await d.clear(hosts[i]);
      await d.type(hosts[i], host);
      await d.clear(ports[i]);
      await d.type(ports[i], String(port));
    }
    await d.button("Проверить и сохранить");
    await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 30000);
  }

  const synced = async () => {
    await d.until("folders", async () => (await sidebarText()).includes(v8 ? "Корзина" : "Отчёты"), 60000);
    await d.until("demo mail synced", async () => String(await d.exec("return document.querySelector('.list').dataset.count ?? ''")) !== "", 60000);
  };

  /**
   * Session A adds the mailbox and waits for the demo mail; `prepare(account, now)` puts into the
   * cache what the pictures need (it is read at the next start); then session B starts, on the
   * inbox. Without `restart` there is one session only.
   */
  async function boot({ prepare, restart = true }) {
    driverProc = spawn(join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", nativeDriver], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    await d.until("tauri-driver", async () => {
      await fetch("http://127.0.0.1:4444/status");
      return true;
    }, 10000);
    await d.start(app);
    await addAccount();
    console.log(`Профиль: ${profile}`);
    await synced();
    await d.button("Входящие");
    await sleep(1500);
    const account = (await invoke("accounts"))[0].id;
    await prepare?.(account, Math.floor(Date.now() / 1000));
    if (restart) {
      await d.quit();
      await sleep(1500);
      await d.start(app);
      await synced();
      await d.button("Входящие");
      await sleep(1500);
    }
    return account;
  }

  async function finish() {
    await d.quit();
    driverProc?.kill();
    try {
      const cfg = JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8"));
      for (const a of cfg.accounts ?? []) execFileSync("secret-tool", ["clear", "service", "ru.depesha.mail", "username", a.id]);
    } catch {}
    if (!process.env.E2E_KEEP) rmSync(profile, { recursive: true, force: true });
    if (shots.length) console.log(`\nНаписанные кадры:\n  ${shots.join("\n  ")}`);
  }

  return {
    d, sleep, helper, db, shot, textOf, setInput, setSelect, press, invoke, sidebarText, openFolder, rowBySubject, openBySubject,
    menuItem, palette, closeSettings, discardCompose, addAccount, boot, finish, profile, v8,
  };
}
