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
  return d.until(`row "${subject}"`, () =>
    d.xpath(`//div[contains(@class,'row')][.//span[contains(@class,'subject') and contains(., ${JSON.stringify(subject)})]]`),
  timeoutMs);
}

async function openBySubject(subject) {
  await d.click(await rowBySubject(subject));
  await d.until(`reader shows "${subject}"`, async () => (await textOf(".reader h1")).includes(subject));
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
  await d.exec(
    `const s = document.querySelector(arguments[0]); s.value = arguments[1]; s.dispatchEvent(new Event('change', {bubbles: true}));`,
    css,
    value,
  );
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
  await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
  await d.type((await d.findAll(".modal.compose .box input"))[0], to);
  await setInput(".modal.compose .subject", subject);
  await d.exec(
    "const t = document.querySelector('.modal.compose textarea'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, arguments[0]);",
    text,
  );
}

async function composeClosed() {
  await d.until("compose closed", async () => (await d.findAll(".modal.compose")).length === 0, 15000);
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
    await setSelect(".wizard fieldset:nth-of-type(1) select", "plain");
    await setSelect(".wizard fieldset:nth-of-type(2) select", "plain");
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
    const count = async () => (await textOf(".list .title .muted")).trim();
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
    await d.button("Все входящие");
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

  await step("7.3", "клавиатура: j/k по списку, c — новое письмо, Esc — закрыть", async () => {
    await d.button("Все входящие");
    await openBySubject("Счёт за октябрь");
    const body = await d.find("body");
    const before = await textOf(".reader h1");
    await d.type(body, "j");
    await d.until("next message", async () => (await textOf(".reader h1")) !== before);
    await d.type(body, "k");
    await d.until("back", async () => (await textOf(".reader h1")) === before);
    await d.type(body, "c");
    await d.until("compose by key", async () => (await d.findAll(".modal.compose")).length === 1);
    await d.type(await d.find(".modal.compose textarea"), "");
    await d.until("compose closed by Esc", async () => (await d.findAll(".modal.compose")).length === 0);
  });

  await step("6.3", "групповые действия: три письма отмечаются непрочитанными", async () => {
    await d.button("Все входящие");
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

  await step("5.7", "подпись из настроек ящика попадает в новое письмо", async () => {
    await d.click(await d.find(".menu-btn"));
    await d.button("Настройки…");
    await d.until("settings", async () => (await d.findAll(".wizard")).length === 1);
    // WebKitWebDriver drops "\n" in typed text; Enter makes the line break.
    await setInput(".wizard textarea.sig", "С уважением,\uE007Кэрол");
    await d.button("Проверить и сохранить");
    await d.until("saved", async () => (await d.findAll(".wizard")).length === 0, 20000);
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
    const text = await d.exec("return document.querySelector('.modal.compose textarea').value");
    if (!text.includes("-- \nС уважением,\nКэрол")) throw new Error(JSON.stringify(text));
    // Only the signature was typed: closing must neither ask nor save a draft.
    await d.click(await d.find(".modal.compose header button"));
    await d.until("compose closed", async () => (await d.findAll(".modal.compose")).length === 0, 10000);
  });

  let sentAt = 0;
  await step("5.1", "новое письмо уходит через очередь", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
    const to = (await d.findAll(".modal.compose .box input"))[0];
    await d.type(to, "carol@local.test");
    await setInput(".modal.compose .subject", subject);
    // WebDriver always types at the end of a field; a user types above the signature.
    await d.exec(
      "const t = document.querySelector('.modal.compose textarea'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, arguments[0]);",
      "Тестовое письмо из Депеши.\nВторая строка.",
    );
    await screenshot("compose");
    await d.button("Отправить");
    sentAt = Date.now();
    await d.until("compose closed", async () => (await d.findAll(".modal.compose")).length === 0);
    await d.until("sent toast", async () => (await d.bodyText()).includes(`Отправлено: ${subject}`), 30000);
  });

  await step("3.5", "новое письмо появляется само (IDLE), меньше чем за 60 с", async () => {
    await d.button("Все входящие");
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
    await d.until("reply compose", async () => (await d.findAll(".modal.compose")).length === 1);
    const subj = await d.exec("return document.querySelector('.modal.compose .subject').value");
    if (subj !== `Re: ${subject}`) throw new Error(`тема: ${subj}`);
    const body = await d.exec("return document.querySelector('.modal.compose textarea').value");
    if (!body.includes("пишет:") || !body.includes("> Тестовое письмо")) throw new Error(`цитата: ${body}`);
    await d.exec("const t = document.querySelector('.modal.compose textarea'); t.focus(); t.setSelectionRange(0, 0);");
    await d.type(await d.find(".modal.compose textarea"), "Ответ получен.");
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
    await d.button("Все входящие");
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
    await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
    await setInput(".modal.compose .subject", `Черновик ${stamp}`);
    await d.type(await d.find(".modal.compose textarea"), "Недописанное письмо");
    await d.click(await d.find(".modal.compose header button"));
    await d.until("compose closed", async () => (await d.findAll(".modal.compose")).length === 0, 15000);
    await d.until("draft on server", async () => helper("count", "Drafts", `Черновик ${stamp}`) === "1", 15000);
    const flags = helper("flags", "Drafts", `Черновик ${stamp}`);
    if (!flags.includes("\\Draft")) throw new Error(`флаги черновика: ${flags}`);
  });

  await step("8", "цепочка: три письма — одна строка, в письме видна вся переписка", async () => {
    await d.button("Все входящие");
    const threadRow = () =>
      d.exec(`return [...document.querySelectorAll('.row')].filter(r => r.innerText.includes('Бюджет на ноябрь')).map(r => r.querySelector('.count')?.innerText.trim() ?? '1')`);
    await d.until("one row with 3", async () => JSON.stringify(await threadRow()) === '["3"]', 15000);
    await openBySubject("Бюджет на ноябрь");
    await d.until("conversation strip", async () => (await d.findAll(".conversation .conv")).length === 3);
    const t = await textOf(".conversation");
    if (!t.includes("Мария Соколова")) throw new Error(`цепочка: ${t}`);
    await screenshot("conversation");
  });

  await step("9", "люди и рассылки отдельно; отписка письмом", async () => {
    await d.button("Рассылки");
    await rowBySubject("Скидки недели");
    if ((await textOf(".list")).includes("Счёт за октябрь")) throw new Error("письмо от человека среди рассылок");
    await d.button("Люди");
    await d.until("people only", async () => {
      const t = await textOf(".list");
      return t.includes("Счёт за октябрь") && !t.includes("Скидки недели");
    });
    await d.exec("document.querySelector('.split button').click()");
    await openBySubject("Скидки недели");
    await d.click(await d.find(".reader .chip"));
    await d.click(await d.find(".reader .banner .btn.primary"));
    await d.until("unsubscribe request delivered", async () => helper("count", "INBOX", "unsubscribe-weekly") === "1", 40000);
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
    await d.button("Все входящие");
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

  await step("5.8", "проверка перед отправкой и отмена отправки", async () => {
    const subj = `Отмена ${stamp}`;
    await newMessage("carol@local.test", subj, "Договор во вложении.");
    await d.click(await d.find(".modal.compose .split-btn .main"));
    await d.until("attachment warning", async () => (await textOf(".modal.compose .warnings")).includes("вложение"));
    await screenshot("preflight");
    await d.click(await d.find(".modal.compose .warnings .btn.primary"));
    await composeClosed();
    await d.click(await d.until("undo toast", () => d.xpath("//div[contains(@class,'toast')][contains(., 'Отправляется')]//button[contains(@class,'act')]")));
    await d.until("compose is back", async () => (await d.findAll(".modal.compose")).length === 1);
    const back = await d.exec("return document.querySelector('.modal.compose .subject').value");
    if (back !== subj) throw new Error(`вернулось: ${back}`);
    await new Promise((r) => setTimeout(r, 12000));
    if (helper("count", "INBOX", subj) !== "0") throw new Error("письмо ушло, хотя отправку отменили");
    // Closing keeps it as a draft.
    await d.click(await d.find(".modal.compose header button"));
    await composeClosed();
  });

  await step("5.9", "«Отправить позже»: письмо ждёт в «Исходящих» своего времени", async () => {
    const subj = `Позже ${stamp}`;
    await newMessage("carol@local.test", subj, "Утром.");
    await d.click(await d.find(".modal.compose .split-btn .more"));
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
    await setSelect(".modal.compose .remind", "3");
    await d.click(await d.find(".modal.compose .split-btn .main"));
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
    await d.button("Добавить шаблон");
    await setInput(".prefs .tpl input", "Получил");
    await setInput(".prefs .tpl textarea", "Спасибо, получил.");
    await d.click(await d.find(".prefs footer .btn.primary"));
    await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
    await d.button("Шаблоны");
    await d.click(await d.until("template", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Получил')]")));
    const text = await d.exec("return document.querySelector('.modal.compose textarea').value");
    if (!text.includes("Спасибо, получил.")) throw new Error(JSON.stringify(text));
    await d.click(await d.find(".modal.compose header button"));
    await composeClosed();
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "перейти отлож");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("snoozed view", async () => (await textOf(".list h2")).trim() === "Отложенные");
    await d.button("Все входящие");
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
    await d.button("Все входящие");
    await setLanguage("настр", "en");
    await d.until("English sidebar", async () => (await sidebarText()).includes("All inboxes"), 10000);
    if (!(await textOf(".list h2")).includes("All inboxes")) throw new Error(`заголовок: ${await textOf(".list h2")}`);
    if (!(await textOf(".list .search input") || (await d.exec("return document.querySelector('.list .search input').placeholder"))).includes("Search")) {
      throw new Error("поле поиска не переведено");
    }
    await screenshot("english");
    await setLanguage("sett", "ru");
    await d.until("Russian again", async () => (await sidebarText()).includes("Все входящие"), 10000);
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
    await d.button("Все входящие");
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
    await d.button("Добавить ящик");
    await d.until("wizard", async () => (await d.findAll(".wizard")).length === 1);
    await setInput(".wizard input[placeholder='Иван Петров']", "Боб");
    await setInput(".wizard input[type=email]", "bob@local.test");
    await setInput(".wizard input[type=password]", "secret");
    await d.button("Далее");
    await d.until("settings step", async () => (await d.bodyText()).includes("Входящая почта (IMAP)"), 30000);
    await setInput(".wizard input[placeholder^='адрес или']", "bob");
    await setSelect(".wizard fieldset:nth-of-type(1) select", "tls");
    await setSelect(".wizard fieldset:nth-of-type(2) select", "tls");
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
    await d.until("second account in sidebar", async () => (await sidebarText()).toUpperCase().includes("БОБ"), 20000);
  });

  await step("4.1", "общий входящий собирает письма обоих ящиков", async () => {
    const bobSubject = `Для Боба ${stamp}`;
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
    await d.type((await d.findAll(".modal.compose .box input"))[0], "bob@local.test");
    await setInput(".modal.compose .subject", bobSubject);
    await d.type(await d.find(".modal.compose textarea"), "Проверка общего входящего");
    await d.button("Отправить");
    await d.button("Все входящие");
    await rowBySubject(bobSubject, 60000);
    await rowBySubject("Счёт за октябрь", 5000);
    await screenshot("unified-two-accounts");
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
    await d.until("compose", async () => (await d.findAll(".modal.compose")).length === 1);
    await d.type((await d.findAll(".modal.compose .box input"))[0], "carol@local.test");
    await setInput(".modal.compose .subject", offlineSubject);
    await d.type(await d.find(".modal.compose textarea"), "Отправлено, когда сеть вернулась");
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
