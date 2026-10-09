// README screenshots, reproducible: the real app (debug build) on a virtual display,
// driven over WebDriver, with tidy demo mail seeded by imap_helper.py demo-seed.
//
//   docker compose -f compose.test.yaml up -d --force-recreate
//   python3 e2e/imap_helper.py demo-seed
//   npx tauri build --debug --no-bundle --features e2e
//   e2e/keyring.sh node e2e/shots.mjs
//
// The whole set is written to docs/screenshots/. Env: DEPESHA_APP (binary),
// WEBKIT_DRIVER, E2E_DISPLAY (default :99), E2E_KEEP=1 leaves the temp profile.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
const out = join(root, "docs/screenshots");
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "depesha-shots-"));
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

function helper(...args) {
  return execFileSync("python3", [join(root, "e2e/imap_helper.py"), ...args], { encoding: "utf-8" }).trim();
}

function db(sql) {
  return execFileSync("sqlite3", [join(profile, "data/ru.depesha.mail/mail.sqlite"), sql], { encoding: "utf-8" }).trim();
}

/** Writes the window as it is now into docs/screenshots/<name>.png. */
async function shot(name) {
  // Toasts are transient and would date the picture: hide them without touching the DOM.
  await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden')").catch(() => {});
  await sleep(350);
  const png = await d.screenshot();
  writeFileSync(join(out, `${name}.png`), png);
  await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
  const { width, height } = await d.rect();
  shots.push(`${name}.png ${width}×${height}`);
  console.log(`  · ${name}.png ${width}×${height}`);
}

async function textOf(css) {
  return d.exec("return document.querySelector(arguments[0])?.innerText ?? ''", css);
}

async function setInput(css, value) {
  const el = await d.find(css);
  await d.clear(el);
  await d.type(el, String(value));
}

async function setSelect(css, value) {
  await d.click(await d.find(`${css} .trigger`));
  await d.click(await d.until(`option ${value}`, () => d.find(`${css} [role=option][data-value="${value}"]`).catch(() => null)));
}

async function press(key, mods = {}) {
  await d.exec("window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[0], bubbles: true }, arguments[1])))", key, mods);
}

async function invoke(cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}

async function sidebarText() {
  return d.exec("return document.querySelector('nav.side').innerText");
}

async function openFolder(name) {
  await d.exec(
    `[...document.querySelectorAll('nav.side .item')].find((b) => (b.querySelector('.name') ?? b).innerText.trim() === arguments[0]).click();`,
    name,
  );
}

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

/** The command palette: Ctrl+K, a search, Enter. Opens whatever the command is. */
async function palette(search) {
  await press("k", { ctrlKey: true });
  await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
  await d.type(await d.find(".palette .q"), search);
  await d.type(await d.find(".palette .q"), "\uE007");
}

/** Switches the interface language in Settings and saves. */
async function setLanguage(search, value) {
  await palette(search);
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(`.prefs input[type=radio][name=language][value="${value}"]`));
  await d.click(await d.find(".prefs footer .btn.primary"));
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}

/** Picks an appearance theme in Settings and saves. */
async function setTheme(search, value) {
  await palette(search);
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.xpath(`//div[contains(@class,'themes')]//label[.//input[@value=${JSON.stringify(value)}]]`));
  await d.click(await d.find(".prefs footer .btn.primary"));
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}

/** Throws the open composition away, so it leaves no draft behind. */
async function discardCompose() {
  await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
  await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
  await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
}

async function closeSettings() {
  if ((await d.findAll(".prefs")).length === 0) return;
  await d.exec("document.querySelector('.modal.prefs')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}

/** Fills the login wizard, as the E2E does, and saves. */
async function addAccount() {
  await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"), 30000);
  await setInput(".wizard input[placeholder='Иван Петров']", "Кэрол Тестова");
  await setInput(".wizard input[type=email]", "carol@local.test");
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

const driverProc = spawn(join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", nativeDriver], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  await d.until("tauri-driver", async () => { await fetch("http://127.0.0.1:4444/status"); return true; }, 10000);
  await d.start(app);
  await addAccount();
  console.log(`Профиль: ${profile}`);
  await d.until("folders", async () => (await sidebarText()).includes("Отчёты"), 60000);
  await d.until("demo mail synced", async () => {
    const count = String(await d.exec("return document.querySelector('.list').dataset.count ?? ''"));
    return count !== "";
  }, 60000);
  console.log(`  ${await textOf(".list h2")}: ${await d.exec("return document.querySelector('.list').dataset.count")}`);

  // The waits for an answer: their letters are in Sent, the plan is the backend's.
  // The same letters are started here, straight in the cache, because a wait begins
  // only after a real send, and a picture must not depend on the outbox's timing.
  const me = (await invoke("accounts"))[0].id;
  const now = Math.floor(Date.now() / 1000);
  db(`INSERT OR REPLACE INTO followups
      (account_id, message_id, subject, recipients, sent, due, deadline, status, repeat_secs, expect, kind, own_deadline)
      VALUES
      ('${me}', 'f-wait@example.org', 'Заявка на пропуск для подрядчиков', 'petr@example.com',
       ${now - 5400}, ${now + 172800}, ${now + 172800}, 'waiting', 0, '', '3 дня', 0),
      ('${me}', 'f-done@example.org', 'Проверка датчиков на складе', 'maria@example.org',
       ${now - 10 * 86400}, ${now - 2 * 86400}, ${now - 2 * 86400}, 'waiting', 0, '', '3 дня', 0);`);
  await invoke("settings_set", { settings: { ...(await invoke("settings_get")), theme: "paper", language: "ru" } });

  // 1. The main window: a conversation row, people, a newsletter, unread counts,
  //    and the newest letter open with its attachment.
  await d.button("Входящие");
  await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
  await openBySubject("Re: Смета на монтаж");
  await shot("main");

  // 2. The compose editor in HTML: the formatting row over the letter and its signature.
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  await d.type((await d.findAll(".compose .box input"))[0], "petr@example.com");
  await setInput(".compose .subject", "Смета на монтаж: правки");
  await d.exec(
    `const r = document.querySelector('.compose .rich'); r.focus();
     document.execCommand('insertHTML', false,
       '<div>Пётр, добрый день!</div><div>По смете три правки:</div>' +
       '<ul><li>доставка — 120 000 вместо 180 000;</li><li>монтаж освещения считаем отдельно;</li>' +
       '<li>срок сдвигаем на неделю.</li></ul><div>Тогда итог — <b>940 000 ₽</b>.</div>');`);
  await shot("compose");

  // 3. Settings: the mailbox's signatures, one of them the default.
  await discardCompose();

  /** Types lines into the signature open in its editor, as its own commands do. */
  async function typeSignature(lines) {
    await d.exec(
      `const el = document.querySelector('.account-page .sig-rich .rich'); el.focus();
       arguments[0].forEach((line, i) => { if (i) document.execCommand('insertParagraph'); document.execCommand('insertText', false, line); });`,
      lines,
    );
  }
  await palette("настр");
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.click(await d.find(".prefs .tab[data-page='accounts']"));
  await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
  const at = Math.max(0, (await invoke("accounts")).findIndex((a) => a.id === me));
  await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[at]);
  await d.until("account page", async () => (await d.findAll(".account-page")).length === 1);
  await d.click(await d.xpath("//nav[contains(@class,'toc')]//a[contains(., 'Письма и подписи')]"));
  await d.until("signature section", async () => (await textOf(".account-page .signatures")).includes("Добавить подпись"));
  // The mailbox's signatures: the first becomes the default by itself.
  await d.button("Добавить подпись");
  await setInput(".account-page .signatures input.name", "Рабочая");
  await typeSignature(["С уважением,", "Кэрол Тестова", "отдел ИТ, +7 495 000-00-00"]);
  await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
  await d.button("Добавить подпись");
  await setInput(".account-page .signatures input.name", "Короткая");
  await typeSignature(["Кэрол, отдел ИТ"]);
  await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
  await d.until("signature list", async () => (await textOf(".account-page .signatures")).includes("Рабочая"));
  await sleep(300);
  await shot("signatures");
  // Saved, so the default signature is there for good.
  await d.until("saved", async () => (await invoke("accounts")).some((a) => a.signatures?.length === 2), 20000);
  await closeSettings();

  // 4. «Ждут ответа»: an active wait near its reminder, an overdue one.
  await d.button("Ждут ответа");
  await d.until("followups", async () => (await textOf(".list h2")).includes("Ждут ответа"));
  await rowBySubject("Заявка на пропуск", 20000);
  await shot("followups");

  // 5. The narrow window (#38): the sidebar becomes a strip, one column at a time —
  //    the list first, the letter after a click.
  await d.button("Входящие");
  await d.setRect(600, 720);
  await sleep(600);
  await d.until("narrow window", async () => !!(await d.exec("return !!document.querySelector('.layout.single')")), 10000);
  await rowBySubject("Re: Смета на монтаж", 20000);
  console.log("  узкое окно: список");
  await shot("narrow-list");
  await d.click(await rowBySubject("Re: Смета на монтаж"));
  await d.until("letter in narrow window", async () => !!(await d.exec("return !!document.querySelector('.reader h1')")), 20000);
  await sleep(2500); // the reader's "opening" placeholder gives way to the letter
  console.log("  узкое окно: письмо —", await textOf(".reader h1"));
  await shot("narrow-message");
  await press("Escape");
  await d.setRect(1280, 820);
  await sleep(600);

  // 6. The snooze menu on a letter.
  await d.button("Входящие");
  await openBySubject("Смета на монтаж");
  await press("h");
  await d.until("snooze menu", async () => (await textOf(".snooze .pop")).includes("Завтра"));
  await shot("snooze");
  await press("Escape");

  // 7. The check before sending: a mentioned but missing attachment.
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  await d.type((await d.findAll(".compose .box input"))[0], "petr@example.com");
  await setInput(".compose .subject", "Договор на подпись");
  await d.exec("const r = document.querySelector('.compose .rich'); r.focus(); document.execCommand('insertHTML', false, '<div>Пётр, договор во вложении. Подпишите, пожалуйста, до пятницы.</div>');");
  await d.click(await d.find(".compose .split-btn .main"));
  await d.until("attachment warning", async () => (await textOf(".compose .warnings")).includes("вложение"));
  await shot("preflight");
  await discardCompose();

  // 8. Dark theme, a conversation: the whole thread of three letters with its cards.
  await setTheme("настр", "night");
  await d.button("Входящие");
  await openBySubject("Re: Смета на монтаж");
  await d.click(await d.find(".reader .thread"));
  await d.until("conversation", async () => (await d.findAll(".reader .thread .card")).length >= 2, 10000);
  await sleep(300);
  await shot("dark");
  await press("Escape");

  // 9. Trusting a certificate by fingerprint: the wizard meets GreenMail's self-signed one.
  //    The English README's main shot is light: the night theme goes back first.
  await setTheme("настр", "snow");
  await setLanguage("настр", "en");
  await d.until("English sidebar", async () => (await sidebarText()).includes("Inbox"), 10000);
  await d.button("Inbox");
  await openBySubject("Re: Смета на монтаж");
  await shot("english");
  await d.click(await d.find(".menu-btn"));
  await d.button("Add account");
  await d.until("wizard", async () => (await d.findAll(".wizard")).length === 1);
  await setInput(".wizard input[placeholder='Jane Smith']", "Bob");
  await setInput(".wizard input[type=email]", "bob@local.test");
  await setInput(".wizard input[type=password]", "secret");
  await d.button("Next");
  await d.until("settings step", async () => (await d.bodyText()).includes("Incoming mail (IMAP)"), 30000);
  await setInput(".wizard input[placeholder^='address or']", "bob");
  await setSelect(".wizard fieldset:nth-of-type(1) .select", "tls");
  await setSelect(".wizard fieldset:nth-of-type(2) .select", "tls");
  const hosts = await d.findAll(".wizard fieldset .host input");
  const ports = await d.findAll(".wizard fieldset .port input");
  for (const [i, port] of [3993, 3465].entries()) {
    await d.clear(hosts[i]);
    await d.type(hosts[i], "localhost");
    await d.clear(ports[i]);
    await d.type(ports[i], String(port));
  }
  await d.button("Check and save");
  await d.until("certificate question", async () => (await d.bodyText()).includes("SHA-256"), 20000);
  await sleep(300);
  await shot("certificate");

  console.log("Готово.");
} catch (e) {
  console.error("Прогон прерван:", e);
  process.exitCode = 1;
} finally {
  await d.quit();
  driverProc.kill();
  try {
    const cfg = JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8"));
    for (const a of cfg.accounts ?? []) execFileSync("secret-tool", ["clear", "service", "ru.depesha.mail", "username", a.id]);
  } catch {}
  if (!process.env.E2E_KEEP) rmSync(profile, { recursive: true, force: true });
  if (shots.length) console.log(`\nНаписанные кадры:\n  ${shots.join("\n  ")}`);
}
