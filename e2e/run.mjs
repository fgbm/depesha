// End-to-end acceptance run: the real app (debug build) on a virtual display,
// driven over WebDriver, against GreenMail (compose.test.yaml).
//
//   docker compose -f compose.test.yaml up -d --force-recreate && python3 e2e/imap_helper.py seed
//   npx tauri build --debug --no-bundle
//   node e2e/run.mjs
//
// Env: DEPESHA_APP (binary), WEBKIT_DRIVER (WebKitWebDriver), E2E_DISPLAY (default :99).

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Driver } from "./webdriver.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.DEPESHA_APP ?? join(root, "target/debug/depesha");
const nativeDriver = process.env.WEBKIT_DRIVER ?? join(process.env.HOME, ".local/depesha-testenv/root/usr/bin/WebKitWebDriver");
const screens = join(root, "e2e/screens");
mkdirSync(screens, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "depesha-e2e-"));
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
  // The scenario reads Russian text; the language follows the locale (LANGUAGE wins).
  LANGUAGE: "ru",
  // E2E_DARK=1: the whole run in the dark theme, for its screenshots.
  ...(process.env.E2E_DARK ? { GTK_THEME: "Adwaita:dark" } : {}),
};

const results = [];
let shot = 0;
const d = new Driver();

function helper(...args) {
  return execFileSync("python3", [join(root, "e2e/imap_helper.py"), ...args], { encoding: "utf-8" }).trim();
}

async function screenshot(name) {
  // Toasts are transient; hide them for the picture without touching Svelte's DOM.
  await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden')").catch(() => {});
  const file = join(screens, `${String(++shot).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, await d.screenshot());
  await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
}

async function step(criteria, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ criteria, name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ [${criteria}] ${name} (${Date.now() - started} мс)`);
  } catch (e) {
    results.push({ criteria, name, ok: false, error: e.message });
    console.log(`  ✗ [${criteria}] ${name}: ${e.message}`);
    await screenshot(`FAIL-${name.replace(/[^\p{L}\d]+/gu, "_")}`).catch(() => {});
  }
}

async function rowBySubject(subject, timeoutMs = 15000) {
  const xpath = `//div[contains(@class,'row')][.//span[contains(@class,'subject') and contains(., ${JSON.stringify(subject)})]]`;
  return d.until(`row "${subject}"`, async () => {
    const row = await d.xpath(xpath).catch(() => null);
    if (row) return row;
    // The list draws only the rows in view: scroll on, as a person would, and from the top again at the end.
    await d.exec(`const v = document.querySelector('.list .viewport');
      if (v) v.scrollTop = v.scrollTop + v.clientHeight >= v.scrollHeight - 1 ? 0 : v.scrollTop + v.clientHeight;`);
    return null;
  }, timeoutMs);
}

async function openBySubject(subject) {
  await d.click(await rowBySubject(subject));
  await d.until(`reader shows "${subject}"`, async () => (await textOf(".reader h1")).includes(subject));
}

async function openFolder(name) {
  await d.exec(
    `[...document.querySelectorAll('nav.side .item')].find((b) => b.innerText.trim() === arguments[0]).click();`,
    name,
  );
}

/** Picks an item of the list's "View" menu (filter or order) and closes the menu. */
async function viewOption(label) {
  if (!(await d.exec("return !!document.querySelector('.pop')"))) await d.click(await d.find(".list .view .trigger"));
  const item = await d.until(`view item ${label}`, () =>
    d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`),
  );
  await d.click(item);
  await press("Escape");
}

async function textOf(css) {
  return d.exec("return document.querySelector(arguments[0])?.innerText ?? ''", css);
}

async function setInput(css, value) {
  const el = await d.find(css);
  await d.clear(el);
  await d.type(el, String(value));
}

/** Picks in the app's own drop-down list (Select.svelte) the way a user does. */
async function setSelect(css, value) {
  await d.click(await d.find(`${css} .trigger`));
  await d.click(await d.until(`option ${value}`, () => d.find(`${css} [role=option][data-value="${value}"]`).catch(() => null)));
}

/** Calls a backend command the way the GUI does. */
async function invoke(cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}

async function idOf(subject) {
  const rows = await invoke("messages", { query: { role: "inbox", limit: 2000 } });
  const row = rows.find((m) => m.subject.includes(subject));
  if (!row) throw new Error(`нет письма «${subject}» в кэше`);
  return row.id;
}

/** A key press as the window sees it (shortcuts listen on window). */
async function press(key, mods = {}) {
  await d.exec("window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: arguments[0], bubbles: true }, arguments[1])))", key, mods);
}

async function newMessage(to, subject, text) {
  await d.button("Написать");
  await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
  await d.type((await d.findAll(".compose .box input"))[0], to);
  await setInput(".compose .subject", subject);
  await d.exec(
    "const t = document.querySelector('.compose textarea'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, arguments[0]);",
    text,
  );
}

async function composeClosed() {
  await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
}

async function sidebarText() {
  return d.exec("return document.querySelector('nav.side').innerText");
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
  await d.start(app);
  console.log(`Профиль: ${profile}`);

  const stamp = new Date().toISOString().slice(11, 19);
  const subject = `E2E проверка ${stamp}`;

  await step("1.1", "мастер открывается на пустом профиле", async () => {
    await d.until("wizard", async () => (await d.bodyText()).includes("Добавить почтовый ящик"));
    await screenshot("wizard");
  });

  await step("1.1", "автоопределение и ручная правка параметров", async () => {
    await setInput(".wizard input[placeholder='Иван Петров']", "Кэрол Тестова");
    await setInput(".wizard input[type=email]", "carol@local.test");
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "carol");
    const hosts = await d.findAll(".wizard fieldset .host input");
    const ports = await d.findAll(".wizard fieldset .port input");
    await setSelect(".wizard fieldset:nth-of-type(1) .select", "plain");
    await setSelect(".wizard fieldset:nth-of-type(2) .select", "plain");
    for (const [i, [host, port]] of [["127.0.0.1", 3143], ["127.0.0.1", 3025]].entries()) {
      await d.clear(hosts[i]);
      await d.type(hosts[i], host);
      await d.clear(ports[i]);
      await d.type(ports[i], String(port));
    }
    await screenshot("wizard-settings");
  });

  await step("1.2", "неверный пароль даёт понятную ошибку", async () => {
    await setInput(".wizard .grid input[type=password]", "wrong");
    await d.button("Проверить и сохранить");
    await d.until("auth error", async () => (await d.bodyText()).includes("отклонил вход"), 20000);
    await screenshot("wizard-auth-error");
  });

  await step("1.2", "проверка входа и сохранение", async () => {
    await setInput(".wizard .grid input[type=password]", "secret");
    await d.button("Проверить и сохранить");
    await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 30000);
  });

  await step("1.3", "пароль не попал в файлы профиля", async () => {
    const cfg = readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8");
    if (cfg.includes("secret")) throw new Error("пароль найден в accounts.json");
    if (!cfg.includes("carol@local.test")) throw new Error("учётная запись не сохранена");
    let found = "";
    try {
      // grep exits 1 when nothing matches: that is the good outcome.
      found = execFileSync("grep", ["-rlaF", "--", "secret", profile], { encoding: "utf-8" });
    } catch {}
    if (found.trim()) throw new Error(`пароль найден в файлах: ${found}`);
  });

  await step("3.1–3.3", "папки: роли, русские имена, служебные скрыты", async () => {
    const text = await d.until("folders", async () => {
      const t = await sidebarText();
      return t.includes("Корзина") && t.includes("Работа") ? t : null;
    }, 30000);
    for (const want of ["Входящие", "Отправленные", "Черновики", "Корзина", "Работа"]) {
      if (!text.includes(want)) throw new Error(`нет папки «${want}»`);
    }
    for (const hidden of ["Calendar", "Birthdays"]) {
      if (text.includes(hidden)) throw new Error(`служебная папка «${hidden}» видна`);
    }
    await screenshot("main");
  });

  await step("6.5", "поиск на сервере находит письмо вне локального кэша", async () => {
    const box = await d.find(".list .search input");
    await d.clear(box);
    await d.type(box, "Quarterly");
    await d.until("search view", async () => (await textOf(".list h2")).trim() === "Поиск");
    if ((await textOf(".list")).includes("Quarterly report archive")) throw new Error("письмо уже в кэше — тест ничего не проверит");
    await d.button("Искать на сервере");
    await rowBySubject("Quarterly report archive", 20000);
    await d.type(box, "\uE00C");
  });

  await step("3.4", "первая синхронизация: свежие письма сразу, старые — при прокрутке", async () => {
    await rowBySubject("Счёт за октябрь", 30000);
    await d.button("Входящие");
    await d.until("folder view", async () => (await textOf(".list h2")).trim() === "Входящие");
    const count = async () => d.exec("return document.querySelector('.list').dataset.count");
    for (let i = 0; i < 40; i++) {
      await d.exec("const v = document.querySelector('.viewport'); v.scrollTop = v.scrollHeight; v.dispatchEvent(new Event('scroll'));");
      await new Promise((r) => setTimeout(r, 300));
      if ((await count()).startsWith("625")) break;
    }
    // 620 + 3 single letters + a conversation of three (one row) + a newsletter.
    const final = await count();
    if (!final.startsWith("625")) throw new Error(`после прокрутки: ${final}`);
    // The list is virtual: only rows near the viewport exist, so scroll to the end again.
    await d.exec("const v = document.querySelector('.viewport'); v.scrollTop = v.scrollHeight; v.dispatchEvent(new Event('scroll'));");
    await rowBySubject("Массовое письмо 000", 5000);
  });

  await step("4.6", "открытие ставит «прочитано» на сервере", async () => {
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    await openBySubject("Счёт за октябрь");
    await d.until("\\Seen on server", async () => helper("flags", "INBOX", "Счёт за октябрь").includes("\\Seen"), 10000);
  });

  await step("4.2", "Windows-1251 и KOI8-R без кракозябр", async () => {
    await openBySubject("Счёт на оплату");
    const text = await textOf(".reader");
    if (!text.includes("Оплатите до пятницы")) throw new Error(text.slice(0, 300));
    if (!text.includes("Бухгалтерия")) throw new Error("имя отправителя KOI8-R");
  });

  await step("4.3–4.5", "HTML: скрипты вырезаны, трекер скрыт, cid-картинка и вложение на месте", async () => {
    await openBySubject("HTML-письмо с картинками");
    await d.until("banner", async () => (await d.bodyText()).includes("Внешние картинки скрыты"));
    const info = await d.until("iframe", () =>
      d.exec(`const doc = document.querySelector('.reader iframe')?.contentDocument;
        if (!doc || !doc.body || !doc.body.innerHTML) return null;
        return { html: doc.body.innerHTML, logo: doc.querySelector('img[src^="data:image/png"]') !== null,
                 scripts: doc.querySelectorAll('script').length, onclick: doc.querySelectorAll('[onclick]').length,
                 tracker: doc.body.innerHTML.includes('tracker.example') };`),
    );
    if (!info.logo) throw new Error("встроенная картинка не подставлена");
    if (info.scripts || info.onclick) throw new Error("скрипты не вырезаны");
    if (info.tracker) throw new Error("трекер загружается без разрешения");
    if (!(await d.bodyText()).includes("report.pdf")) throw new Error("нет вложения report.pdf");
    await screenshot("html-message");
    await d.button("Показать");
    try {
      await d.until("tracker allowed", () =>
        d.exec("return document.querySelector('.reader iframe')?.contentDocument?.body?.innerHTML.includes('tracker.example')"),
      );
    } catch (e) {
      const diag = await d.exec(`const f = document.querySelector('.reader iframe');
        return { srcdoc: (f?.getAttribute('srcdoc') ?? '').includes('tracker.example'),
                 csp: (f?.getAttribute('srcdoc') ?? '').match(/img-src[^;]*/)?.[0],
                 body: f?.contentDocument?.body?.innerHTML?.slice(0, 400) };`);
      throw new Error(`${e.message}; ${JSON.stringify(diag)}`);
    }
  });

  await step("4.4", "«всегда для отправителя» запоминает доверие", async () => {
    await d.button("Входящие");
    await openBySubject("Счёт за октябрь");
    await openBySubject("HTML-письмо с картинками");
    await d.button("Всегда для news@example.org");
    await d.until("remote shown", () =>
      d.exec("return document.querySelector('.reader iframe')?.contentDocument?.body?.innerHTML.includes('tracker.example')"),
    );
    await openBySubject("Счёт за октябрь");
    await openBySubject("HTML-письмо с картинками");
    if ((await d.bodyText()).includes("Внешние картинки скрыты")) throw new Error("доверие отправителю не сохранилось");
  });

  await step("4.5", "вложение сохраняется на диск без искажений", async () => {
    const target = join(profile, "report.pdf");
    const rowId = await d.req("POST", d.s("/execute/async"), {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke('search', { text: 'HTML письмо картинками', accountId: null })
          .then(r => done(r[0]?.id ?? null), e => done(null));`,
      args: [],
    });
    if (!rowId) throw new Error("письмо не найдено поиском");
    const res = await d.req("POST", d.s("/execute/async"), {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke('attachment_save', { id: arguments[0], index: 1, path: arguments[1] })
          .then(() => done('ok'), e => done(JSON.stringify(e)));`,
      args: [rowId, target],
    });
    if (res !== "ok") throw new Error(res);
    const head = readFileSync(target).subarray(0, 8).toString();
    if (head !== "%PDF-1.4") throw new Error(`содержимое: ${head}`);
  });

  await step("4.10", "просмотрщик вложений: PDF, Word, Excel, Markdown, CSV в cp1251; ←/→ и Esc", async () => {
    const frameText = () =>
      d.exec("return document.querySelector('.viewer iframe')?.contentDocument?.body?.innerText ?? ''");
    await openFolder("Работа");
    await openBySubject("Документы на проверку");
    await d.click(await d.until("contract.pdf", () => d.xpath("//button[contains(@class,'file-name')][contains(., 'contract.pdf')]")));
    await d.until("pdf page drawn", () => d.exec("return !!document.querySelector('.viewer .page canvas')"), 20000);
    await d.until("pdf text layer", async () => (await textOf(".viewer .page")).includes("Договор поставки"), 10000);
    await screenshot("viewer-pdf");
    await press("ArrowRight");
    await d.until("docx", async () => (await frameText()).includes("Поставщик обязуется"), 20000);
    await screenshot("viewer-docx");
    await press("ArrowRight");
    await d.until("xlsx", async () => (await frameText()).includes("Реагент Б"), 20000);
    await press("ArrowRight");
    await d.until("markdown", async () => (await frameText()).includes("Заметки к встрече"));
    const md = await d.exec("return document.querySelector('.viewer iframe').contentDocument.body.innerHTML");
    if (!md.includes("<h1") || !md.includes("<table") || md.includes("<script")) throw new Error(`markdown: ${md}`);
    await screenshot("viewer-markdown");
    await press("ArrowRight");
    await d.until("csv in cp1251", async () => (await textOf(".viewer table")).includes("Петров"));
    await press("Escape");
    await d.until("viewer closed", async () => (await d.findAll(".viewer")).length === 0);
    // A file that only pretends to be a PDF: the viewer says so and offers the application.
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    await d.click(await d.until("report.pdf", () => d.xpath("//button[contains(@class,'file-name')][contains(., 'report.pdf')]")));
    await d.until("fallback", async () => (await textOf(".viewer")).includes("не получилось показать"), 20000);
    await press("Escape");
    await d.until("viewer closed", async () => (await d.findAll(".viewer")).length === 0);
  });

  await step("4.11", "письмо в отдельном окне: двойной щелчок, ответ в этом окне, «Готово» закрывает окно, z в главном", async () => {
    const subj = "Документы на проверку";
    const main = await d.req("GET", d.s("/window"));
    await openFolder("Работа");
    await rowBySubject(subj);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
      subj,
    );
    const handles = () => d.req("GET", d.s("/window/handles"));
    await d.until("second window", async () => (await handles()).length === 2, 15000);
    const other = (await handles()).find((h) => h !== main);
    await d.req("POST", d.s("/window"), { handle: other });
    try {
      await d.until("letter in its window", async () => (await textOf(".reader h1")).includes(subj), 20000);
      if ((await d.findAll(".list, nav.side")).length) throw new Error("в окне письма есть список или боковая панель");
      // Double click again: the same window comes forward, no second one.
      await d.req("POST", d.s("/window"), { handle: main });
      await d.exec(
        `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
         row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
        subj,
      );
      await new Promise((r) => setTimeout(r, 1500));
      if ((await handles()).length !== 2) throw new Error(`окон: ${(await handles()).length}`);
      await d.req("POST", d.s("/window"), { handle: other });
      await d.click(await d.until("reply", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await d.until("compose in the window", async () => (await d.findAll(".compose")).length === 1);
      const re = await d.exec("return document.querySelector('.compose .subject').value");
      if (re !== `Re: ${subj}`) throw new Error(`тема ответа: ${re}`);
      await screenshot("message-window-reply");
      await d.click(await d.until("discard", () => d.find(".compose [aria-label='Удалить черновик']")));
      if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
      await d.until("compose gone", async () => (await d.findAll(".compose")).length === 0);
      await d.click(await d.until("done", () => d.xpath("//div[contains(@class,'toolbar')]//button[contains(., 'Готово')]")));
      await d.until("window closed", async () => (await handles()).length === 1, 20000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
    await d.until("archived on server", async () => helper("count", "Работа", subj) === "0", 20000);
    await d.until("undo offered in the main window", async () => (await textOf(".toasts")).includes("Отменить"));
    await press("z");
    await d.until("back in its folder", async () => helper("count", "Работа", subj) === "1", 20000);
  });

  await step("7.3", "клавиатура: j/k по списку, c — новое письмо, Esc — закрыть", async () => {
    await d.button("Входящие");
    await openBySubject("Счёт за октябрь");
    const body = await d.find("body");
    const before = await textOf(".reader h1");
    await d.type(body, "j");
    await d.until("next message", async () => (await textOf(".reader h1")) !== before);
    await d.type(body, "k");
    await d.until("back", async () => (await textOf(".reader h1")) === before);
    await d.type(body, "c");
    await d.until("compose by key", async () => (await d.findAll(".compose")).length === 1);
    await d.type(await d.find(".compose textarea"), "");
    // Esc folds the window into a bar, as in Gmail; the cross closes it.
    await d.until("compose folded by Esc", async () => (await d.findAll(".compose.min")).length === 1);
    await d.click(await d.find(".compose header button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0);
  });

  await step("7.3", "клавиши работают на русской раскладке (о = j, л = k)", async () => {
    await openBySubject("Счёт за октябрь");
    const before = await textOf(".reader h1");
    await press("о", { code: "KeyJ" });
    await d.until("next message", async () => (await textOf(".reader h1")) !== before);
    await press("л", { code: "KeyK" });
    await d.until("back", async () => (await textOf(".reader h1")) === before);
  });

  await step("6.3", "групповые действия: три письма отмечаются непрочитанными", async () => {
    await d.button("Входящие");
    const subjects = ["Массовое письмо 619", "Массовое письмо 618", "Массовое письмо 617"];
    await d.click(await rowBySubject(subjects[0]));
    for (const subj of subjects.slice(1)) {
      await d.exec(
        `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
         row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));`,
        subj,
      );
    }
    await d.until("bulk panel", async () => (await d.bodyText()).includes("Выбрано писем: 3"));
    await d.button("Не прочитано");
    for (const subj of subjects) {
      await d.until(`unseen ${subj}`, async () => !helper("flags", "INBOX", subj).includes("\\Seen"), 10000);
    }
  });

  await step("6.6", "контекстное меню строки: флаг, подменю «Отложить» и папок", async () => {
    await d.button("Входящие");
    const subj = "Массовое письмо 616";
    await rowBySubject(subj);
    const rightClick = () =>
      d.exec(
        `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
         const r = row.getBoundingClientRect();
         row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));`,
        subj,
      );
    await rightClick();
    await d.until("menu", async () => (await textOf(".pop")).includes("Поставить флаг"));
    const menu = await textOf(".pop");
    for (const item of ["Ответить", "Ответить всем", "Переслать", "Готово", "Это спам", "Удалить"]) {
      if (!menu.includes(item)) throw new Error(`нет пункта «${item}»: ${menu}`);
    }
    await screenshot("row-menu");
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Поставить флаг')]"));
    await d.until("\\Flagged on server", async () => helper("flags", "INBOX", subj).includes("\\Flagged"), 10000);
    // Submenus open in place of the menu.
    await rightClick();
    await d.click(await d.until("snooze item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Отложить')]")));
    await d.until("snooze presets", async () => (await textOf(".pop")).includes("Завтра"));
    await press("Escape");
    await d.until("menu closed", async () => (await d.findAll(".pop")).length === 0);
  });

  await step("6.7", "контекстное меню папки: новая вложенная папка; версия в сайдбаре", async () => {
    const version = await textOf("nav.side .brand .version");
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`версия: «${version}»`);
    await d.exec(
      `const item = [...document.querySelectorAll('nav.side .item')].find((b) => b.innerText.trim() === 'Работа');
       const r = item.getBoundingClientRect();
       item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));`,
    );
    await d.until("folder menu", async () => (await textOf(".pop")).includes("Синхронизировать папку"));
    await screenshot("folder-menu");
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Новая папка внутри')]"));
    const input = await d.until("name input", () => d.find(".pop input").catch(() => null));
    await d.type(input, "Проекты\uE007");
    await d.until("subfolder in sidebar", async () => (await sidebarText()).includes("Проекты"), 15000);
    // Inside «Работа», not in a new folder named by the raw modified UTF-7 of it.
    const side = await sidebarText();
    if (side.includes("&")) throw new Error(`папка с сырым именем: ${side}`);
    const nested = await d.exec(
      "const p = [...document.querySelectorAll('nav.side .item')].find((b) => b.innerText.trim() === 'Проекты'); return p ? parseInt(p.style.paddingLeft) : 0;",
    );
    if (nested <= 14) throw new Error(`«Проекты» не вложена (отступ ${nested}px)`);
  });

  await step("3.11", "офлайн: письма за 30 дней скачиваются сами, ход виден в «Фоновых задачах»", async () => {
    const overview = () => invoke("sync_overview");
    await d.until("offline download done", async () => {
      const [o] = await overview();
      return o && o.offline_total > 0 && o.offline_done === o.offline_total;
    }, 60000);
    await d.click(await d.find("button[aria-label='Фоновые задачи']"));
    await d.until("tasks window", async () => (await textOf(".modal.tasks")).includes("Офлайн: скачано"));
    const text = await textOf(".modal.tasks");
    if (!text.includes("Синхронизирован")) throw new Error(text);
    await screenshot("tasks");
    await d.button("Закрыть");
    await d.until("tasks closed", async () => (await d.findAll(".modal.tasks")).length === 0);
  });

  await step("6.3", "«Непрочитанные»: прочитанное письмо остаётся в списке до смены вида", async () => {
    await d.button("Непрочитанные");
    await openBySubject("Массовое письмо 619");
    await d.until("\\Seen on server", async () => helper("flags", "INBOX", "Массовое письмо 619").includes("\\Seen"), 10000);
    // The change comes back from the server and reloads the list: the letter must stay open.
    await new Promise((r) => setTimeout(r, 2000));
    await rowBySubject("Массовое письмо 619", 1000);
    if (!(await textOf(".reader h1")).includes("Массовое письмо 619")) throw new Error("письмо закрылось");
    await d.button("Входящие");
    await d.button("Непрочитанные");
    await rowBySubject("Массовое письмо 618");
    const gone = await d.exec("return ![...document.querySelectorAll('.row .subject')].some((s) => s.innerText.includes('Массовое письмо 619'))");
    if (!gone) throw new Error("прочитанное письмо осталось после смены вида");
  });

  await step("5.7", "подпись из настроек ящика попадает в новое письмо", async () => {
    await d.click(await d.find(".menu-btn"));
    await d.button("Настройки…");
    await d.until("settings", async () => (await d.findAll(".wizard")).length === 1);
    // WebKitWebDriver drops "\n" in typed text; Enter makes the line break.
    await setInput(".wizard textarea.sig", "С уважением,\uE007Кэрол");
    await d.button("Проверить и сохранить");
    await d.until("saved", async () => (await d.findAll(".wizard")).length === 0, 20000);
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    const text = await d.exec("return document.querySelector('.compose textarea').value");
    if (!text.includes("-- \nС уважением,\nКэрол")) throw new Error(JSON.stringify(text));
    // Only the signature was typed: closing must neither ask nor save a draft.
    await d.click(await d.find(".compose header button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
  });

  let sentAt = 0;
  await step("5.1", "новое письмо уходит через очередь", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    const to = (await d.findAll(".compose .box input"))[0];
    await d.type(to, "carol@local.test");
    await setInput(".compose .subject", subject);
    // WebDriver always types at the end of a field; a user types above the signature.
    await d.exec(
      "const t = document.querySelector('.compose textarea'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, arguments[0]);",
      "Тестовое письмо из Депеши.\nВторая строка.",
    );
    await screenshot("compose");
    await d.button("Отправить");
    sentAt = Date.now();
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0);
    await d.until("sent toast", async () => (await d.bodyText()).includes(`Отправлено: ${subject}`), 30000);
  });

  await step("3.5", "новое письмо появляется само (IDLE), меньше чем за 60 с", async () => {
    await d.button("Входящие");
    await rowBySubject(subject, 60000);
    console.log(`    пришло через ${((Date.now() - sentAt) / 1000).toFixed(1)} с после отправки`);
  });

  await step("5.3", "копия в «Отправленных» ровно одна", async () => {
    await d.until("copy in Sent", async () => helper("count", "Sent", subject) === "1", 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const n = helper("count", "Sent", subject);
    if (n !== "1") throw new Error(`копий: ${n}`);
  });

  await step("5.1", "ответ: тема, цитата, цепочка", async () => {
    await openBySubject(subject);
    await d.button("Ответить");
    await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
    const subj = await d.exec("return document.querySelector('.compose .subject').value");
    if (subj !== `Re: ${subject}`) throw new Error(`тема: ${subj}`);
    const body = await d.exec("return document.querySelector('.compose textarea').value");
    if (!body.includes("пишет:") || !body.includes("> Тестовое письмо")) throw new Error(`цитата: ${body}`);
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); t.setSelectionRange(0, 0);");
    await d.type(await d.find(".compose textarea"), "Ответ получен.");
    await d.button("Отправить");
    await rowBySubject(`Re: ${subject}`, 60000);
    const irt = helper("header", "INBOX", `Re: ${subject}`, "In-Reply-To");
    if (!irt.includes("@")) throw new Error(`In-Reply-To: ${irt}`);
  });

  await step("6.1", "удаление переносит в корзину", async () => {
    await openBySubject(`Re: ${subject}`);
    await d.click(await d.find(".reader button[title^='Удалить']"));
    await d.until("in Trash", async () => helper("count", "Trash", `Re: ${subject}`) === "1", 15000);
    if (helper("count", "INBOX", `Re: ${subject}`) !== "0") throw new Error("осталось во входящих");
  });

  await step("6.4", "поиск по тексту открытых писем, по-русски", async () => {
    const box = await d.find(".list .search input");
    await d.click(box);
    await d.type(box, "пятниц");
    await d.until("search results", async () => {
      const t = await textOf(".list");
      return t.includes("Счёт за октябрь") && t.includes("Счёт на оплату");
    }, 10000);
    await screenshot("search");
    await d.type(box, "");
  });

  await step("3.7", "флаг, поставленный другим клиентом, виден", async () => {
    await d.button("Входящие");
    helper("flag", "INBOX", "Счёт за октябрь");
    const flagged = async () =>
      d.exec(`return [...document.querySelectorAll('.row')].some(r => r.innerText.includes('Счёт за октябрь') && r.querySelector('.flag'))`);
    try {
      await d.until("flag via IDLE", flagged, 10000);
    } catch {
      console.log("    IDLE не сообщил о флаге — обновляю вручную");
      await d.click(await d.find(".menu-btn"));
      await d.button("Обновить");
      await d.until("flag after refresh", flagged, 15000);
    }
  });

  await step("5.5", "закрытие окна написания сохраняет черновик на сервере", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await setInput(".compose .subject", `Черновик ${stamp}`);
    await d.type(await d.find(".compose textarea"), "Недописанное письмо");
    await d.click(await d.find(".compose header button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 15000);
    await d.until("draft on server", async () => helper("count", "Drafts", `Черновик ${stamp}`) === "1", 15000);
    const flags = helper("flags", "Drafts", `Черновик ${stamp}`);
    if (!flags.includes("\\Draft")) throw new Error(`флаги черновика: ${flags}`);
  });

  await step("8", "цепочка: три письма — одна строка, в письме видна вся переписка", async () => {
    await d.button("Входящие");
    const threadRow = () =>
      d.exec(`return [...document.querySelectorAll('.row')].filter(r => r.innerText.includes('Бюджет на ноябрь')).map(r => r.querySelector('.count')?.innerText.trim() ?? '1')`);
    await d.until("one row with 3", async () => JSON.stringify(await threadRow()) === '["3"]', 15000);
    await openBySubject("Бюджет на ноябрь");
    // The newest letter is opened; the two before it fold into cards above.
    await d.until("conversation cards", async () => (await d.findAll(".thread .card")).length === 2);
    const t = await textOf(".thread");
    if (!t.includes("Мария Соколова")) throw new Error(`цепочка: ${t}`);
    await screenshot("conversation");
  });

  await step("9", "люди и рассылки отдельно, у каждого списка свой выбор; отписка письмом", async () => {
    await viewOption("Рассылки");
    await rowBySubject("Скидки недели");
    if ((await textOf(".list .viewport")).includes("Счёт за октябрь")) throw new Error("письмо от человека среди рассылок");
    await viewOption("Люди");
    await d.until("people only", async () => {
      const t = await textOf(".list .viewport");
      return t.includes("Счёт за октябрь") && !t.includes("Скидки недели");
    });
    // The hidden mail is named on the button, and the choice belongs to this list only.
    const trigger = () => d.exec("const b = document.querySelector('.list .view .trigger'); return b ? [b.innerText.trim(), b.classList.contains('filtered')] : null");
    const [label, filtered] = await trigger();
    if (!filtered || !label.startsWith("Люди")) throw new Error(`кнопка «Вид»: ${label}`);
    await openFolder("Корзина");
    await d.until("trash unfiltered", async () => (await trigger())?.[1] === false);
    await d.button("Входящие");
    await d.until("inbox keeps People", async () => (await trigger())?.[1] === true);
    await viewOption("Все");
    await d.until("filter off", async () => (await trigger())?.[1] === false);
    await openBySubject("Скидки недели");
    await d.click(await d.find(".reader .chip"));
    await d.click(await d.find(".reader .banner .btn.primary"));
    await d.until("unsubscribe request delivered", async () => helper("count", "INBOX", "unsubscribe-weekly") === "1", 40000);
  });

  await step("16", "сортировка: важное наверху не прыгает под рукой; по отправителю, как в кэше; свой порядок списка", async () => {
    const subjects = () => d.exec("return [...document.querySelectorAll('.list .row .subject')].map((e) => e.innerText)");
    const top = () => d.exec("const r = [...document.querySelectorAll('.list .row')].sort((a, b) => a.offsetTop - b.offsetTop)[0]; return r ? [r.querySelector('.subject').innerText, r.classList.contains('unread')] : null");
    try {
      // At least one unread letter to put on top.
      await openBySubject("Счёт за октябрь");
      await press("u");
      await viewOption("Важное наверху");
      await d.until("unread on top", async () => (await top())?.[1] === true, 15000);
      // Read: the letter keeps its place until the list changes.
      const [first] = await top();
      await openBySubject(first);
      // The flag reaches the server and the list reloads meanwhile.
      await new Promise((r) => setTimeout(r, 2500));
      const [still] = await top();
      if (still !== first) throw new Error(`прочитанное уехало: наверху «${still}», было «${first}»`);

      // The list shows the order the cache gives for the same keys.
      await viewOption("По отправителю");
      const rows = await invoke("messages", { query: { role: "inbox", limit: 2000 } });
      const acc = rows[0].account_id;
      const want = await invoke("messages", {
        query: { account_id: acc, folder: "INBOX", threads: true, sort: [{ by: "sender", desc: false }, { by: "date", desc: true }], limit: 30 },
      });
      await d.until("sorted by sender", async () => {
        const shown = (await subjects()).slice(0, 10);
        return JSON.stringify(shown) === JSON.stringify(want.slice(0, 10).map((m) => m.subject || "(без темы)"));
      });
      const label = await textOf(".list .view .trigger");
      if (!label.includes("По отправителю")) throw new Error(`кнопка «Вид»: ${label}`);

      // An order of its own: other lists keep the common one.
      await d.click(await d.find(".list .view .trigger"));
      await d.click(await d.find(".pop .scope input"));
      await viewOption("По теме");
      await openFolder("Корзина");
      await d.until("trash by sender", async () => (await textOf(".list .view .trigger")).includes("По отправителю"));
      await d.button("Входящие");
      await d.until("inbox by subject", async () => (await textOf(".list .view .trigger")).includes("По теме"));
      const settings = await invoke("settings_get");
      if (!Object.values(settings.view_sorts).some((s) => s[0]?.by === "subject")) throw new Error(`настройки: ${JSON.stringify(settings.view_sorts)}`);
      await screenshot("sort");
    } finally {
      // Back to the defaults for the steps that follow, whatever failed above.
      await press("Escape");
      await d.button("Входящие");
      await d.click(await d.find(".list .view .trigger"));
      // Unticked, the list takes the common order again; then the common order is newest first.
      if (await d.exec("return !!document.querySelector('.pop .scope input:checked')")) await d.click(await d.find(".pop .scope input"));
      await viewOption("По дате");
    }
  });

  await step("1.4", "«Готово» подряд: убранные письма не возвращаются в список, пока сервер их переносит", async () => {
    const subjects = ["Массовое письмо 605", "Массовое письмо 604", "Массовое письмо 603"];
    await openBySubject(subjects[0]);
    // Every change of the list is recorded: a letter must not come back once gone.
    await d.exec(`
      window.__rows = [];
      const list = document.querySelector('.rows') ?? document.querySelector('.list');
      const snap = () => window.__rows.push([...document.querySelectorAll('.row .subject')].map((s) => s.innerText.trim()));
      snap();
      window.__rowsObserver = new MutationObserver(snap);
      window.__rowsObserver.observe(list, { childList: true, subtree: true, characterData: true });`);
    for (const subj of subjects) {
      await d.until(`${subj} open`, async () => (await textOf(".reader h1")).includes(subj), 10000);
      await press("e");
    }
    for (const subj of subjects) {
      await d.until(`${subj} archived`, async () => helper("count", "Архив", subj) === "1", 30000);
    }
    // Syncs after the moves reload the list too.
    await new Promise((r) => setTimeout(r, 2000));
    const snaps = await d.exec("window.__rowsObserver.disconnect(); return window.__rows;");
    for (const subj of subjects) {
      const seen = snaps.map((rows) => rows.includes(subj));
      const gone = seen.indexOf(false);
      if (gone < 0) throw new Error(`«${subj}» не ушло из списка`);
      const back = seen.indexOf(true, gone);
      if (back >= 0) throw new Error(`«${subj}» вернулось в список после ухода (снимок ${back} из ${snaps.length})`);
    }
  });

  await step("1.4", "«Готово»: отметка «прочитано» у следующего письма не мигает, счётчик не растёт", async () => {
    const [done, next] = ["Массовое письмо 602", "Массовое письмо 601"];
    await invoke("set_flag", { ids: [await idOf(next)], change: { flag: "seen", value: false } });
    await d.until("unread on server", async () => !helper("flags", "INBOX", next).includes("\\Seen"), 15000);
    await openBySubject(done);
    // The counter has caught up with the mark above before recording starts.
    const unread = (await invoke("messages", { query: { role: "inbox", unread_only: true, limit: 50 } })).length;
    await d.until("inbox counter", async () =>
      Number(await d.exec("return [...document.querySelectorAll('nav.side .item')].find((b) => b.querySelector('.name')?.innerText.trim() === 'Входящие')?.querySelector('.count')?.innerText ?? 0")) === unread);
    // Every change of the next row and of the Inbox counter is recorded.
    await d.exec(`
      window.__flags = [];
      const snap = () => {
        const row = [...document.querySelectorAll('.list .row')].find((r) => r.querySelector('.subject')?.innerText.includes(arguments[0]));
        const inbox = [...document.querySelectorAll('nav.side .item')].find((b) => b.querySelector('.name')?.innerText.trim() === 'Входящие');
        window.__flags.push({ unread: row ? row.classList.contains('unread') : null, count: Number(inbox?.querySelector('.count')?.innerText ?? 0) });
      };
      snap();
      window.__flagsObserver = new MutationObserver(snap);
      window.__flagsObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });`, next);
    await press("e");
    await d.until(`${next} open`, async () => (await textOf(".reader h1")).includes(next), 10000);
    await d.until(`${done} archived`, async () => helper("count", "Архив", done) === "1", 30000);
    await d.until(`${next} read on server`, async () => helper("flags", "INBOX", next).includes("\\Seen"), 15000);
    await new Promise((r) => setTimeout(r, 2000));
    const snaps = await d.exec("window.__flagsObserver.disconnect(); return window.__flags;");
    const states = snaps.map((s) => s.unread).filter((u) => u !== null);
    const read = states.indexOf(false);
    if (read < 0) throw new Error("следующее письмо не стало прочитанным");
    if (states.indexOf(true, read) >= 0) throw new Error(`отметка вернулась в «не прочитано»: ${states.join(" ")}`);
    const counts = snaps.map((s) => s.count);
    if (counts.some((c, i) => i > 0 && c > counts[i - 1])) throw new Error(`счётчик «Входящих» рос: ${counts.join(" ")}`);
  });

  await step("1", "«Готово» (e) убирает в архив, z возвращает", async () => {
    await openBySubject("Счёт на оплату");
    await press("e");
    await d.until("archived on server", async () => helper("count", "Архив", "Счёт на оплату") === "1", 20000);
    if (helper("count", "INBOX", "Счёт на оплату") !== "0") throw new Error("осталось во входящих");
    await d.until("archive folder created", async () => (await sidebarText()).includes("Архив"));
    // Right away, while the action may still be finishing: "z" must wait for it.
    await press("z");
    try {
      await d.until("back in inbox", async () => helper("count", "INBOX", "Счёт на оплату") === "1" && helper("count", "Архив", "Счёт на оплату") === "0", 20000);
    } catch (e) {
      throw new Error(`${e.message}; уведомления: ${await textOf(".toasts")}`);
    }
  });

  await step("2", "«Отложить»: письмо ждёт в «Отложенных» и возвращается непрочитанным", async () => {
    await d.button("Входящие");
    await openBySubject("Скидки недели");
    await press("h");
    await d.until("snooze menu", async () => (await textOf(".reader .pop")).includes("Завтра утром"));
    await screenshot("snooze-menu");
    await press("Escape");
    // The offered times are hours away; the same command with a time 5 seconds ahead.
    await invoke("snooze", { ids: [await idOf("Скидки недели")], until: Math.floor(Date.now() / 1000) + 5 });
    await d.until("in Snoozed on server", async () => helper("count", "Отложенные", "Скидки недели") === "1", 20000);
    await d.until("back unread", async () =>
      helper("count", "INBOX", "Скидки недели") === "1" && !helper("flags", "INBOX", "Скидки недели").includes("\\Seen"), 45000, 1000);
  });

  await step("2.3", "«Отложить» цепочку: в «Отложенных» одна строка и единица в счётчике", async () => {
    const subj = `Цепочка ${stamp}`;
    helper("deliver", subj);
    helper("reply", "INBOX", subj);
    await d.button("Входящие");
    await d.until("thread of two", async () =>
      (await d.exec(`return [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]))?.querySelector('.count')?.innerText.trim() ?? ''`, subj)) === "2", 30000);
    await openBySubject(subj);
    await press("h");
    await d.click(await d.until("snooze preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра утром')]")));
    await d.until("both in Snoozed on server", async () => helper("count", "Отложенные", subj) === "2", 20000);
    await d.button("Отложенные");
    await rowBySubject(subj, 10000);
    const rows = await d.exec(`return [...document.querySelectorAll('.row')].filter(r => r.innerText.includes(arguments[0])).length`, subj);
    if (rows !== 1) throw new Error(`строк цепочки в «Отложенных»: ${rows}`);
    const badge = await d.exec(`return [...document.querySelectorAll('nav.side .item')].find(b => b.innerText.includes('Отложенные'))?.querySelector('.count')?.innerText.trim()`);
    if (badge !== "1") throw new Error(`счётчик «Отложенных»: ${badge}`);
  });

  await step("5.8", "проверка перед отправкой и отмена отправки", async () => {
    const subj = `Отмена ${stamp}`;
    await newMessage("carol@local.test", subj, "Договор во вложении.");
    await d.click(await d.find(".compose .split-btn .main"));
    await d.until("attachment warning", async () => (await textOf(".compose .warnings")).includes("вложение"));
    await screenshot("preflight");
    await d.click(await d.find(".compose .warnings .btn.primary"));
    await composeClosed();
    await d.click(await d.until("undo toast", () => d.xpath("//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Отправляется')]//button[contains(@class,'act')]")));
    await d.until("compose is back", async () => (await d.findAll(".compose")).length === 1);
    const back = await d.exec("return document.querySelector('.compose .subject').value");
    if (back !== subj) throw new Error(`вернулось: ${back}`);
    await new Promise((r) => setTimeout(r, 12000));
    if (helper("count", "INBOX", subj) !== "0") throw new Error("письмо ушло, хотя отправку отменили");
    // Closing keeps it as a draft.
    await d.click(await d.find(".compose header button:last-child"));
    await composeClosed();
  });

  await step("5.9", "«Отправить позже»: письмо ждёт в «Исходящих» своего времени", async () => {
    const subj = `Позже ${stamp}`;
    await newMessage("carol@local.test", subj, "Утром.");
    await d.click(await d.find(".compose .split-btn .more"));
    await d.click(await d.until("preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра утром')]")));
    await composeClosed();
    await d.button("Исходящие");
    await d.until("scheduled", async () => {
      const t = await textOf(".outbox");
      return t.includes(subj) && t.includes("Запланировано: отправится завтра");
    });
    await screenshot("outbox-scheduled");
    await d.click(await d.xpath(`//div[contains(@class,'item')][contains(., ${JSON.stringify(subj)})]//button[contains(., 'Отправить сейчас')]`));
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
  });

  await step("5.10", "«Ждут ответа»: напоминание снимается, когда приходит ответ", async () => {
    const subj = `Вопрос ${stamp}`;
    await newMessage("carol@local.test", subj, "Когда будет готово?");
    await setSelect(".compose .remind", "3");
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.until("waiting in sidebar", async () => (await sidebarText()).includes("Ждут ответа"), 60000, 1000);
    await d.button("Ждут ответа");
    await rowBySubject(subj, 20000);
    await screenshot("followups");
    helper("reply", "Sent", subj);
    await d.until("resolved", async () => !(await sidebarText()).includes("Ждут ответа"), 60000, 1000);
  });

  await step("7.7", "палитра команд (Ctrl+K) и шаблоны ответов", async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "настр");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await screenshot("settings-general");
    await d.click(await d.find(".prefs .tab[data-page='mail']"));
    await d.until("mail page", async () => (await textOf(".prefs .pane h2")) === "Почта");
    await screenshot("settings-mail");
    // A plugin's settings are a page of their own, under "Plugins".
    await d.click(await d.xpath("//div[contains(@class,'prefs')]//button[contains(@class,'tab')][contains(., 'Шаблоны ответов')]"));
    await d.button("Добавить шаблон");
    await setInput(".prefs .tpl input", "Получил");
    await setInput(".prefs .tpl textarea", "Спасибо, получил.");
    await d.click(await d.find(".prefs footer .btn.primary"));
    await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.button("Шаблоны");
    await d.click(await d.until("template", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Получил')]")));
    const text = await d.exec("return document.querySelector('.compose textarea').value");
    if (!text.includes("Спасибо, получил.")) throw new Error(JSON.stringify(text));
    await d.click(await d.find(".compose header button:last-child"));
    await composeClosed();
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "перейти отлож");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("snoozed view", async () => (await textOf(".list h2")).trim() === "Отложенные");
    await d.button("Входящие");
  });

  await step("7.8", "язык: английский включается в настройках сразу, без перезапуска", async () => {
    const setLanguage = async (search, value) => {
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), search);
      await d.type(await d.find(".palette .q"), "\uE007");
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(`.prefs input[name][value="${value}"], .prefs input[type=radio][value="${value}"]`));
      await d.click(await d.find(".prefs footer .btn.primary"));
      await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
    };
    await d.button("Входящие");
    await setLanguage("настр", "en");
    await d.until("English sidebar", async () => (await sidebarText()).includes("Inbox"), 10000);
    if (!(await textOf(".list h2")).includes("Inbox")) throw new Error(`заголовок: ${await textOf(".list h2")}`);
    if (!(await textOf(".list .search input") || (await d.exec("return document.querySelector('.list .search input').placeholder"))).includes("Search")) {
      throw new Error("поле поиска не переведено");
    }
    await screenshot("english");
    await setLanguage("sett", "ru");
    await d.until("Russian again", async () => (await sidebarText()).includes("Входящие"), 10000);
  });

  const openModules = async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "плагины");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("plugins", async () => (await d.findAll(".modal.plugins")).length === 1);
  };
  const closeModules = async () => {
    await d.click(await d.find(".modal.plugins footer .btn.primary"));
    await d.until("plugins closed", async () => (await d.findAll(".modal.plugins")).length === 0);
  };
  const install = (name, dir = "plugins/community") => invoke("extension_install", { path: join(root, dir, name) });

  await step("10.1", "плагины: выключенный плагин уносит свои кнопки, клавиши и разделы", async () => {
    await d.button("Входящие");
    await openModules();
    await screenshot("plugins");
    await d.click(await d.find(".modal.plugins input[data-plugin=snooze]"));
    await closeModules();
    await openBySubject("Счёт за октябрь");
    await d.until("no snooze button", async () => !(await textOf(".reader .toolbar")).includes("Отложить"));
    await press("h");
    await new Promise((r) => setTimeout(r, 300));
    if ((await d.findAll(".reader .pop")).length) throw new Error("клавиша h работает при выключенном плагине");
    await openModules();
    await d.click(await d.find(".modal.plugins input[data-plugin=snooze]"));
    await closeModules();
    await d.until("snooze back", async () => (await textOf(".reader .toolbar")).includes("Отложить"));
  });

  await step("10.2", "расширения: плашка над письмом и команда для письма", async () => {
    await install("external-sender");
    await install("reading-time");
    await openBySubject("Бюджет на ноябрь");
    await openBySubject("Счёт за октябрь");
    await d.until("external banner", async () => (await textOf(".reader .ext-banner")).includes("извне"), 10000);
    await screenshot("extension-banner");
    await d.click(await d.find(".reader button[aria-label='Ещё']"));
    await d.click(await d.until("ext command", () => d.find(".reader .mi.ext-cmd")));
    await d.until("reading time toast", async () => (await textOf(".toasts")).includes("слов"), 10000);
  });

  await step("10.3", "расширение-правило раскладывает новую почту", async () => {
    await install("mail-rules");
    const subj = `Задача [в работу] ${stamp}`;
    helper("deliver", subj);
    await d.until("moved by the rule", async () => helper("count", "Работа", subj) === "1", 60000, 1000);
    if (helper("count", "INBOX", subj) !== "0") throw new Error("осталось во входящих");
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "правила стат");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("stats from storage", async () => (await textOf(".toasts")).includes("правила обработали писем: 1"), 10000);
  });

  await step("10.4", "песочница: расширение без прав не достаёт ни до приложения, ни до сети", async () => {
    await install("probe", "e2e/fixtures/extensions");
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "проверка песоч");
    await d.type(await d.find(".palette .q"), "\uE007");
    const result = await d.until("probe result", async () => {
      const t = await textOf(".toasts");
      return t.includes("sandbox holds") || t.includes("LEAK") ? t : null;
    }, 20000);
    if (!result.includes("sandbox holds 6/6")) throw new Error(result);
  });

  await step("10.5", "зависшее расширение не тормозит окно и снимается по таймауту", async () => {
    await install("hang", "e2e/fixtures/extensions");
    await openBySubject("Счёт за октябрь");
    const before = await textOf(".reader h1");
    const started = Date.now();
    await press("j");
    await d.until("next message while the extension loops", async () => (await textOf(".reader h1")) !== before, 5000);
    console.log(`    следующее письмо открылось через ${Date.now() - started} мс, пока расширение крутит цикл`);
    await new Promise((r) => setTimeout(r, 2500));
    await openModules();
    await d.until("timeout recorded", async () => /таймаутов: [1-9]/.test(await textOf(".modal.plugins [data-ext='test.hang']")), 10000);
    await closeModules();
    for (const id of ["test.hang", "test.probe", "examples.mail-rules", "examples.reading-time", "examples.external-sender"]) {
      await invoke("extension_remove", { id });
    }
  });

  await step("1.4, 2.2", "второй ящик по TLS: недоверенный сертификат принимается по отпечатку в мастере", async () => {
    // With one account, adding another lives in its menu.
    await d.click(await d.find(".menu-btn"));
    await d.button("Добавить ящик");
    await d.until("wizard", async () => (await d.findAll(".wizard")).length === 1);
    await setInput(".wizard input[placeholder='Иван Петров']", "Боб");
    await setInput(".wizard input[type=email]", "bob@local.test");
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "bob");
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
    await d.button("Проверить и сохранить");
    await d.until("IMAP certificate question", async () => (await d.bodyText()).includes("SHA-256"), 20000);
    await screenshot("wizard-certificate");
    await d.button("Доверять этому сертификату");
    // The same self-signed certificate is then met on SMTPS.
    await d.until("SMTP certificate or done", async () => {
      if ((await d.findAll(".wizard")).length === 0) return true;
      return (await textOf(".wizard .error")).startsWith("SMTP") ? "smtp" : null;
    }, 20000).then(async (r) => {
      if (r === "smtp") await d.button("Доверять этому сертификату");
    });
    await d.until("wizard closed", async () => (await d.findAll(".wizard")).length === 0, 20000);
    await d.until("second account in sidebar", async () => (await sidebarText()).includes("bob@local.test"), 20000);
  });

  await step("4.1", "общий входящий собирает письма обоих ящиков", async () => {
    const bobSubject = `Для Боба ${stamp}`;
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.type((await d.findAll(".compose .box input"))[0], "bob@local.test");
    await setInput(".compose .subject", bobSubject);
    await d.type(await d.find(".compose textarea"), "Проверка общего входящего");
    await d.button("Отправить");
    await d.button("Все входящие");
    await rowBySubject(bobSubject, 60000);
    await rowBySubject("Счёт за октябрь", 5000);
    await screenshot("unified-two-accounts");
  });

  await step("4.2", "менеджер ящиков: порядок, название и цвет; свёрнутый ящик без лишнего отступа", async () => {
    const names = () => d.exec("return [...document.querySelectorAll('nav.side .account-name .name')].map(n => n.innerText.trim())");
    const before = await names();
    await d.exec("document.querySelector('nav.side .account .menu-btn').click()");
    await d.click(await d.until("manage item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Ящики…')]")));
    await d.until("manager", async () => (await d.findAll(".modal.accounts")).length === 1);
    await d.click((await d.findAll(".modal.accounts .order .btn"))[1]);
    await d.until("order changed", async () => (await names())[0] === before[1]);
    // The colour of the mailbox now first, and its name.
    await d.click((await d.findAll(".modal.accounts .swatch-wrap > .swatch"))[0]);
    await d.click(await d.until("palette", () => d.find(".pop .palette .swatch[aria-label='#d0658f']")));
    await d.until("dot coloured", async () =>
      (await d.exec("return getComputedStyle(document.querySelector('nav.side .account .dot')).backgroundColor")) === "rgb(208, 101, 143)");
    const input = (await d.findAll(".modal.accounts .name"))[0];
    const label = await d.exec("return document.querySelector('.modal.accounts .name').value");
    await d.clear(input);
    await d.type(input, "Тестовый\uE007");
    await d.until("renamed", async () => (await names())[0] === "Тестовый");
    await screenshot("accounts");
    // Back as it was, for the steps after this one.
    await d.exec(
      "const i = document.querySelector('.modal.accounts .name'); i.focus(); i.value = arguments[0]; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur();",
      label,
    );
    await d.until("name back", async () => (await names())[0] === before[1]);
    await d.click((await d.findAll(".modal.accounts .order .btn"))[2]);
    await d.until("order back", async () => JSON.stringify(await names()) === JSON.stringify(before));
    await d.click(await d.find(".modal.accounts footer .btn.primary"));
    // Folded: the next mailbox's name follows right under it.
    await d.exec("document.querySelector('nav.side .account-name').click()");
    const gap = await d.exec(`const g = document.querySelectorAll('nav.side .group');
      const a = g[g.length - 2].querySelector('.account').getBoundingClientRect(), b = g[g.length - 1].querySelector('.account').getBoundingClientRect();
      return Math.round(b.top - a.bottom);`);
    await d.exec("document.querySelector('nav.side .account-name').click()");
    if (gap > 8) throw new Error(`отступ под свёрнутым ящиком ${gap}px`);
  });

  await step("3.9", "не больше 3 IMAP-соединений на ящик", async () => {
    // Only connections to the published ports: docker-proxy's own leg to the container also has dport 3143.
    const out = execFileSync("ss", ["-tnH", "state", "established", "( dport = :3143 or dport = :3993 )"], { encoding: "utf-8" });
    const peers = out.split("\n").map((l) => l.trim().split(/\s+/).pop() ?? "");
    const plain = peers.filter((p) => p === "127.0.0.1:3143").length;
    const tls = peers.filter((p) => p === "127.0.0.1:3993" || p === "[::1]:3993").length;
    if (plain > 3 || tls > 3) throw new Error(`соединений: carol ${plain}, bob ${tls}\n${out}`);
    console.log(`    соединений: carol ${plain}, bob ${tls}`);
  });

  const offlineSubject = `Без сети ${stamp}`;
  await step("4.7, 5.5", "без сети: открытые письма читаются, отправка ждёт в «Исходящих»", async () => {
    execFileSync("docker", ["compose", "-f", join(root, "compose.test.yaml"), "stop"], { stdio: "ignore" });
    await d.button("Все входящие");
    await openBySubject("Счёт за октябрь");
    if (!(await textOf(".reader")).includes("Оплатить до пятницы")) throw new Error("кэш письма недоступен");
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.type((await d.findAll(".compose .box input"))[0], "carol@local.test");
    await setInput(".compose .subject", offlineSubject);
    await d.type(await d.find(".compose textarea"), "Отправлено, когда сеть вернулась");
    await d.button("Отправить");
    await d.until("outbox in sidebar", async () => (await sidebarText()).includes("Исходящие"), 20000);
    await d.button("Исходящие");
    await d.until("outbox item", async () => (await textOf(".outbox")).includes(offlineSubject), 10000);
    await screenshot("outbox-offline");
  });

  await step("3.6, 3.8, 5.4", "сервер вернулся: переподключение, новый UIDVALIDITY, письмо ушло само", async () => {
    // GreenMail keeps mail in memory: after restart the mailbox is new (UIDVALIDITY changes).
    execFileSync("docker", ["compose", "-f", join(root, "compose.test.yaml"), "up", "-d", "--force-recreate"], { stdio: "ignore" });
    await d.until("greenmail up", async () => {
      try {
        helper("count", "INBOX", "x");
        return true;
      } catch {
        return false;
      }
    }, 30000);
    await d.until("outbox drained", async () => (await sidebarText()).includes("Исходящие") === false, 120000, 1000);
    await d.button("Все входящие");
    await rowBySubject(offlineSubject, 90000);
    // Old cached rows of the reset mailbox must be gone.
    await d.until("stale cache dropped", async () => !(await textOf(".list")).includes("Массовое письмо"), 30000);
  });

  await step("3.10", "неверный пароль не долбит сервер: ящик встаёт на паузу", async () => {
    const invoke = (cmd, args) =>
      d.req("POST", d.s("/execute/async"), {
        script: `const done = arguments[arguments.length - 1];
          window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(r => done({ ok: r }), e => done({ err: e }));`,
        args: [cmd, args],
      });
    const accs = (await invoke("accounts", {})).ok;
    const carol = accs.find((a) => a.email === "carol@local.test");
    const { status: _s, ...account } = carol;
    const logDir = join(profile, "data/ru.depesha.mail/logs");
    const attempts = () => {
      try {
        return Number(execFileSync("sh", ["-c", `cat ${logDir}/* | grep -c 'отклонил вход' || true`], { encoding: "utf-8" }).trim());
      } catch {
        return 0;
      }
    };
    const before = attempts();
    await invoke("account_save", { account, password: "wrong-password" });
    await d.until("paused", async () => (await sidebarText()).includes("Исправить"), 20000);
    await new Promise((r) => setTimeout(r, 20000));
    const tries = attempts() - before;
    console.log(`    неудачных входов за ~20 с: ${tries}`);
    if (tries > 3) throw new Error(`слишком много попыток входа: ${tries}`);
    await screenshot("paused-account");
    await invoke("account_save", { account, password: "secret" });
    await d.until("online again", async () => !(await sidebarText()).includes("Исправить"), 20000);
  });

  await step("1.4, 8.2", "удаление ящика стирает кэш и пароль; пароля нет ни в файлах, ни в логах", async () => {
    const accounts = await d.exec("return window.__TAURI_INTERNALS__.invoke('accounts')").catch(() => null);
    const list = accounts ?? JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8")).accounts;
    const bob = list.find((a) => a.email === "bob@local.test");
    await d.req("POST", d.s("/execute/async"), {
      script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('account_remove', { id: arguments[0] }).then(() => done(true), (e) => done(String(e?.message ?? e)));",
      args: [bob.id],
    });
    let left = "";
    try {
      left = execFileSync("secret-tool", ["lookup", "service", "ru.depesha.mail", "username", bob.id], { encoding: "utf-8" });
    } catch {}
    if (left) throw new Error("пароль остался в связке ключей");
    let found = "";
    try {
      found = execFileSync("grep", ["-rlaF", "--", "secret", profile], { encoding: "utf-8" });
    } catch {}
    if (found.trim()) throw new Error(`пароль найден в файлах: ${found}`);
    const logs = execFileSync("sh", ["-c", `ls ${join(profile, "data/ru.depesha.mail/logs")} 2>/dev/null || find ${profile} -name '*.log'`], { encoding: "utf-8" });
    console.log(`    логи: ${logs.trim().split("\n").length} файл(ов), пароля в них нет`);
  });

  await screenshot("final");
} catch (e) {
  console.error("Прогон прерван:", e);
  results.push({ criteria: "-", name: "прогон", ok: false, error: e.message });
} finally {
  await d.quit();
  driverProc.kill();
  // Remove only the test account's password from the keyring.
  try {
    const cfg = JSON.parse(readFileSync(join(profile, "config/ru.depesha.mail/accounts.json"), "utf-8"));
    for (const a of cfg.accounts ?? []) {
      execFileSync("secret-tool", ["clear", "service", "ru.depesha.mail", "username", a.id]);
    }
  } catch {}
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} шагов прошли.`);
writeFileSync(join(screens, "results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
