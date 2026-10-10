// Screenshots for a release's description (docs/releases/<version>.md): the real app (debug
// build) on a virtual display, driven over WebDriver, over the tidy demo mail seeded by
// imap_helper.py demo-seed. The set below is 0.7's; adapt the shots and the seeded message
// ids for another release. SHOTS_SET=0.8.0 shoots the set of 0.8 (shoot080 below, over the
// demo mail seeded with the same SHOTS_SET); without it, the set of 0.7.
//
//   scripts/release-shots.sh                 the whole thing (servers, demo mail, build, shoot)
//   DEPESHA_APP=… scripts/release-shots.sh   an already built binary, no build
//   SHOTS_SET=0.8.0 scripts/release-shots.sh the set of 0.8.0
//
// Writes ${SHOTS_OUT}/NN-*.png (default /tmp/depesha-release-shots). Demo data is tidy
// (example.com), the labels and reply marks are seeded before the shooting session so the
// pictures carry test names only.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";
import { dropOn } from "./drop-steps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
const out = process.env.SHOTS_OUT ?? "/tmp/depesha-release-shots";
const v8 = (process.env.SHOTS_SET ?? "0.7.0") === "0.8.0";
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "depesha-rel-"));
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

async function shot(file) {
  await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility','hidden')").catch(() => {});
  await sleep(400);
  writeFileSync(join(out, `${file}.png`), await d.screenshot());
  await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
  shots.push(`${file}.png`);
  console.log(`  · ${file}.png`);
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
async function menuItem(label) {
  return d.until(`menu item ${label}`, () =>
    d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`).catch(() => null),
  );
}
async function closeSettings() {
  // Esc clears the settings search first and closes the window second: press it a few times.
  for (let i = 0; i < 4 && (await d.findAll(".prefs")).length; i++) {
    await d.exec("document.querySelector('.modal.prefs')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(150);
  }
  await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
}
async function discardCompose() {
  await d.click(await d.find(".compose [aria-label='Удалить черновик']"));
  await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
  await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
}

/** Fills the login wizard, as the E2E does, and saves. */
async function addAccount() {
  await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"), 30000);
  await setInput(".wizard input[placeholder='Иван Петров']", v8 ? "Анна Крылова" : "Кэрол Тестова");
  // The 0.8 pictures show the address (the mailbox in a letter's title), so it is a tidy one.
  await setInput(".wizard input[type=email]", v8 ? "anna@example.org" : "carol@local.test");
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

/** Round logos of two made-up companies, stored as if found by the BIMI lookup (a letter that passed DMARC wears one). */
const LOGOS = {
  "example.org": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1f6f8b"/><path d="M18 46V18h15a9 9 0 0 1 0 18H18m0 0h18a9 9 0 0 1 0 10z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>`,
  "example.net": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2b2b3a"/><circle cx="32" cy="27" r="13" fill="#f2b632"/><rect x="25" y="42" width="14" height="6" rx="2" fill="#f2b632"/></svg>`,
};

/** The pictures of 0.8.0 (see docs/releases/0.8.0.md), over the mail seeded with SHOTS_SET=0.8.0. */
async function shoot080() {
  // 03. The list: logos, initials, the cursor on one letter and the «!» of an important one.
  await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
  await openBySubject("Смета на монтаж");
  await sleep(1200);
  await shot("03-list-avatars");

  // 04. The important letter, with the line of the sender's mark in its header.
  await openBySubject("Счёт на оплату");
  await d.until("important line", async () => (await textOf(".reader")).includes("Отправитель отметил как важное"));
  await sleep(600);
  await shot("04-importance-reader");

  // 07. Many attachments: two rows and «+N ещё ›», then the list behind it.
  await openBySubject("Пакет документов по поставке");
  await d.until("folded files", async () => (await d.findAll(".reader .files .more")).length === 1, 15000);
  await sleep(500);
  await d.click(await d.find(".reader .files .more"));
  await d.until("list of files", async () => (await d.findAll("[data-att]")).length > 0, 5000);
  await sleep(500);
  await shot("07-reader-attachments");
  await press("Escape");
  await sleep(300);

  // 05. «Очистить» in the Trash: the question with the number of letters.
  await openFolder("Корзина");
  const clear = await d.until("clear button", async () => ((await textOf(".list .title button.clear")).includes("Очистить корзину (7)") ? d.find(".list .title button.clear") : null), 30000);
  await d.click(clear);
  await d.until("clear dialog", async () => (await d.findAll(".modal.confirm")).length === 1, 10000);
  await sleep(400);
  await shot("05-clear-confirm");
  await press("Escape");
  await d.until("dialog closed", async () => (await d.findAll(".modal.confirm")).length === 0, 10000);

  // 06. The letter being written: the mailbox in the title, «Копия»/«Скрытая» by «Кому»,
  // several files, the mark of importance by the bottom bar.
  await openFolder("Входящие");
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  const to = await d.find(".compose .fields input");
  await d.type(to, "petr@example.com");
  await d.pressKey("");
  await setInput(".compose .subject", "Смета и схема склада");
  const text = await d.until("body", () => d.find(".compose .body-area [contenteditable], .compose .body-area textarea").catch(() => null), 10000);
  await d.click(text);
  await d.type(text, "Пётр, добрый день! Во вложении смета, схема склада и договор поставки. Посмотрите до пятницы.");
  // Full screen first: the strip then holds every file, and the count below is the whole set.
  await d.click(await d.find(".compose [aria-label='Во весь экран']"));
  await sleep(500);
  const files = mkdtempSync(join(tmpdir(), "depesha-shots-"));
  const names = ["Смета на монтаж.pdf", "Схема склада.png", "Договор поставки.docx", "Прайс-лист.xlsx", "Заметки к встрече.md"];
  for (const name of names) writeFileSync(join(files, name), `${name}\n`);
  await dropOn(d, names.map((n) => join(files, n)), { zone: "attach" });
  await d.until("attachments", async () => (await d.findAll(".compose .files .file")).length === names.length, 15000).catch(async (e) => {
    console.log("compose:", (await textOf(".compose")).slice(0, 600), "| toasts:", await textOf(".toasts"));
    throw e;
  });
  rmSync(files, { recursive: true, force: true });
  await d.click(await d.find(".compose footer button[aria-label='Ещё']"));
  await d.click(await menuItem("Высокая важность"));
  await d.until("importance chip", async () => (await d.findAll(".compose footer .scheduled.important")).length === 1);
  // The text field out of focus, so no caret and no selection stand in the picture.
  await d.exec("document.activeElement?.blur?.(); window.getSelection()?.removeAllRanges()");
  await sleep(600);
  await shot("06-compose");
  await discardCompose();

  // 02 and 01. The book of people: the two spellings of one person, then the merged card.
  await press("k", { ctrlKey: true });
  await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
  await d.type(await d.find(".palette .q"), "перейти люди");
  await d.type(await d.find(".palette .q"), "");
  await d.until("book", async () => (await d.findAll(".people")).length === 1);
  await d.exec("document.querySelector('.people [role=listbox]').focus()");
  await d.pressKey("/");
  await d.type(await d.find(".people input[type=search]"), "смирнова");
  await d.until("two found", async () => (await d.findAll(".people .pr")).length === 2);
  await d.pressKey("");
  await d.until("list has the focus", async () => (await d.exec("return document.activeElement?.getAttribute('role')")) === "listbox");
  await d.pressKey(" ");
  await d.pressKey("");
  await d.pressKey(" ");
  await d.until("two marked", async () => (await textOf(".people .banner")).includes("Отмечено: 2"));
  await d.pressKey("m");
  await d.until("merge dialog", async () => (await d.findAll(".merge")).length === 1);
  await sleep(400);
  await shot("02-people-merge");
  await d.pressKey("");
  await d.until("merged", async () => (await invoke("people", { query: "смирнова" })).length === 1, 15000);
  // The whole book again, the merged person chosen: one card, two addresses.
  await d.exec("document.querySelector('.people input[type=search]').focus()");
  for (let i = 0; i < 10; i++) await d.pressKey("\uE003");
  await d.until("all people", async () => (await d.findAll(".people .pr")).length > 3, 10000).catch(async (e) => {
    console.log("people:", (await textOf(".people")).slice(0, 500));
    throw e;
  });
  await d.click(await d.xpath("//div[contains(@class,'people')]//*[contains(@class,'pr')][.//*[contains(@class,'nm')][contains(., 'Ольга')]]"));
  await d.until("card", async () => (await textOf(".people .pd")).includes("Ольга"));
  await sleep(900);
  await shot("01-people-book");
  await press("Escape");

  // 08. The new settings, found by the search over the pages.
  await press(",", { ctrlKey: true });
  await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
  await d.type(await d.find(".prefs .psearch .q"), "аватар");
  await d.until("search results", async () => (await d.findAll(".prefs .rlist .hit")).length > 0);
  await sleep(500);
  await shot("08-settings");
  await closeSettings();
}

const driverProc = spawn(join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", nativeDriver], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  await d.until("tauri-driver", async () => {
    await fetch("http://127.0.0.1:4444/status");
    return true;
  }, 10000);

  // --- Session A: set up the mailbox, seed labels and reply marks, then restart ---
  await d.start(app);
  await addAccount();
  console.log(`Профиль: ${profile}`);
  await d.until("folders", async () => (await sidebarText()).includes(v8 ? "Корзина" : "Отчёты"), 60000);
  await d.until("demo mail synced", async () => String(await d.exec("return document.querySelector('.list').dataset.count ?? ''")) !== "", 60000);
  await d.button("Входящие");
  await sleep(1500);

  const account = (await invoke("accounts"))[0].id;
  // The labels themselves are read by the labels store at the next start; the keywords
  // (the chips in the rows) are put in later, in the shooting session, so the two list
  // pictures differ.
  if (!v8) {
    await invoke("label_save", { accountId: account, name: "Срочно", color: "#d0658f" });
    await invoke("label_save", { accountId: account, name: "Клиенты", color: "#4a90d9" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!v8) db(`INSERT OR REPLACE INTO marks (account_id, message_id, reply, reply_all, forward, answer) VALUES
      ('${account}', 'report-9@example.org', ${now - 3600}, NULL, NULL, NULL),
      ('${account}', 'invoice-15@example.org', NULL, NULL, ${now - 7200}, NULL),
      ('${account}', 'weekly-44@example.org', NULL, ${now - 10800}, NULL, NULL);`);

  if (v8) {
    // The mailbox gets a name and a colour; one of the two spellings of a person (both have letters,
    // to be merged on a picture) gets a note; the logos are in the cache as if the lookup had found them.
    await invoke("account_patch_own", { id: account, patch: { label: "Работа", color: "#3d7ea6" } });
    await invoke("person_save", {
      person: { email: "olga.smirnova@example.org", name: "Ольга Смирнова", note: "Согласует графики поставок. Пишет с двух адресов; лучше звонить до обеда." },
    });
    await invoke("person_save", { person: { email: "smirnova.o@example.net", name: "Смирнова Ольга" } });
    for (const [domain, svg] of Object.entries(LOGOS)) {
      db(`INSERT OR REPLACE INTO avatars (key, uri, fetched) VALUES ('bimi:${domain}', 'data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}', ${now});`);
    }
  }

  await d.quit();
  await sleep(1500);

  // --- Session B: the pictures ---
  await d.start(app);
  await d.until("folders again", async () => (await sidebarText()).includes(v8 ? "Корзина" : "Отчёты"), 60000);
  await d.until("mail again", async () => String(await d.exec("return document.querySelector('.list').dataset.count ?? ''")) !== "", 60000);
  await d.button("Входящие");
  await sleep(1500);

  if (v8) {
    await shoot080();
  } else {
    // 01. Settings: "Фон и запуск".
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='start']"));
    await d.until("background page", async () => (await d.findAll(".prefs [data-settings='close_action']")).length === 1);
    await sleep(300);
    await shot("01-background");

    // 05. Settings: "Клавиши".
    await d.click(await d.find(".prefs .tab[data-page='keys']"));
    await d.until("keys page", async () => (await d.findAll(".prefs .kr[data-command='core.archive']")).length === 1);
    await sleep(300);
    await shot("05-keys");

    // 06. Settings: the search over the pages.
    await d.type(await d.find(".prefs .psearch .q"), "формат");
    await d.until("search results", async () => (await d.findAll(".prefs .rlist .hit")).length > 0);
    await sleep(300);
    await shot("06-settings-search");
    await closeSettings();

    // 02. Compose in Markdown, with a table edited in its cells. Full screen, so the table fits.
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await setInput(".compose .subject", "График работ на складе");
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await d.click(await menuItem("Markdown"));
    await d.click(await d.find(".compose [aria-label='Во весь экран']"));
    await d.until("markdown editor", async () => (await d.findAll(".compose .md-editor .cm-content")).length === 1, 15000);
    const body = await d.find(".compose .md-editor .cm-content");
    await d.click(body);
    // Newlines through real Enter presses: a "\n" in the typed text is dropped by the editor.
    for (const line of ["# График работ", "", "Пётр, добрый день!", "Предлагаю такой график на складе.", ""]) {
      if (line) await d.type(body, line);
      await d.pressKey("\uE007");
    }
    await sleep(300);
    // "Таблица" from the "⋯" of the formatting row.
    await d.click(await d.find(".compose [aria-label='Ещё оформление']"));
    await d.click(await menuItem("Таблица"));
    await d.until("table drawn", async () => (await d.findAll(".compose .md-table")).length === 1);
    // Move the caret out of the table's own lines so the widget is drawn, not its source.
    await d.click(await d.find(".compose .md-editor .cm-content .cm-line"));
    await d.until("table widget", async () => (await d.findAll(".compose .md-table-view")).length === 1);
    const cell = (spec) => d.find(`.compose .md-table-cell-text[data-cell='${spec}']`);
    const fill = async (spec, text, tab = true) => {
      await d.click(await cell(spec));
      await d.type(await cell(spec), text);
      if (tab) await d.pressKey("\uE004");
    };
    // Three characters at most per cell: a narrow column wraps a longer cell. Tab at the
    // last cell grows a row, as the editor does.
    await fill("-1:0", "Дни");
    await fill("-1:1", "Кто");
    await fill("-1:2", "Час");
    await fill("0:0", "пн");
    await fill("0:1", "Аня");
    await fill("0:2", "10");
    await sleep(500);
    await fill("1:0", "вт");
    await fill("1:1", "Ира");
    await fill("1:2", "14", false);
    // Escape on the focused cell writes the table back into the letter and rebuilds it, so
    // the columns take their real width; a click elsewhere leaves the cells uncommitted.
    await d.pressKey("\uE001");
    await sleep(500);
    // Blur so the focused cell writes the table back into the letter before the shot; the
    // cells hold their column by the word now, so nothing has to be forced on them.
    await d.exec("document.activeElement?.blur?.()");
    await sleep(300);
    await shot("02-markdown-editor");
    await discardCompose();

    // 03. The list: the reply marks before the date.
    await d.button("Входящие");
    await d.until("inbox", async () => (await textOf(".list h2")).trim() === "Входящие");
    await sleep(600);
    await shot("03-reply-marks");

    // 07. The list: the label chips after the subject. The keywords go into the cache now and
    // the list is re-read, so this picture differs from the one above.
    const kw = (name) => db(`SELECT keyword FROM labels WHERE account_id='${account}' AND name='${name}'`);
    db(`UPDATE messages SET keywords=json_array('${kw("Срочно")}') WHERE account_id='${account}' AND message_id='invoice-15@example.org';`);
    db(`UPDATE messages SET keywords=json_array('${kw("Клиенты")}') WHERE account_id='${account}' AND message_id='report-9@example.org';`);
    await openFolder("Работа");
    await sleep(500);
    await openFolder("Входящие");
    await d.until("inbox again", async () => (await textOf(".list h2")).trim() === "Входящие");
    await sleep(600);
    await shot("07-labels");

    // 04. The person card of the sender.
    await openBySubject("Смета на монтаж");
    await d.click(await d.find(".reader .sender"));
    await d.until("person card", async () => (await d.findAll(".pcard")).length === 1);
    await sleep(300);
    await shot("04-person-card");
    await press("Escape");
  }

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
