// Section "triage" of the run (see e2e/shard.mjs for the split into parts).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { screens, d, helper, screenshot, step, rowBySubject, openBySubject, reloadWindow, openFolder, textOf, invoke, idOf, press, composeClosed, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
  section("triage");
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

  await step("1.4.2", "«Готово»: отметка «прочитано» у следующего письма не мигает, счётчик не растёт", async () => {
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
    await d.until("snooze menu", async () => (await textOf(".snooze .pop")).includes("Завтра"));
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
    await d.click(await d.until("snooze preset", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Завтра')]")));
    await d.until("both in Snoozed on server", async () => helper("count", "Отложенные", subj) === "2", 20000);
    await d.button("Отложенные");
    await rowBySubject(subj, 10000);
    const rows = await d.exec(`return [...document.querySelectorAll('.row')].filter(r => r.innerText.includes(arguments[0])).length`, subj);
    if (rows !== 1) throw new Error(`строк цепочки в «Отложенных»: ${rows}`);
    // The folder counter follows scheduleFolders: it is absent until that pass, so wait
    // for it instead of reading once.
    await d.until("snoozed counter is 1", async () => {
      const badge = await d.exec(`return [...document.querySelectorAll('nav.side .item')].find(b => (b.querySelector('.name') ?? b).innerText.trim() === 'Отложенные')?.querySelector('.count')?.innerText.trim() ?? ''`);
      return badge === "1" ? true : null;
    });
  });

  await step("2.5", "«Отложить» по клавише: меню у строки, подменю рядом, день цифрой, тост и «Отменить» (#95, #96)", async () => {
    const subj = `Меню ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 30000);
    await openBySubject(subj);
    const box = (css) => d.exec(`const r = document.querySelector(arguments[0])?.getBoundingClientRect(); return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null`, css);
    // «h» on the selected row: the menu hangs on that row, under it or over it, never on top of it.
    await press("h", { code: "KeyH" });
    await d.until("menu open", async () => (await d.findAll(".snooze .pop.main")).length === 1);
    const row = await box(".row.selected, .row.cursor");
    const menu = await box(".snooze .pop.main");
    if (!(menu.t >= row.b - 1 || menu.b <= row.t + 1)) throw new Error(`меню закрывает строку: строка ${JSON.stringify(row)}, меню ${JSON.stringify(menu)}`);
    if (menu.l < row.l - 1 || menu.l > row.r) throw new Error(`меню не у строки: строка ${JSON.stringify(row)}, меню ${JSON.stringify(menu)}`);
    // «Д» (the key of «Рабочие дни») lights the item, → opens the submenu beside it.
    await press("д", { code: "KeyL" });
    await press("ArrowRight", { code: "ArrowRight" });
    await d.until("submenu", async () => (await d.findAll(".snooze .pop.subm")).length === 1);
    const sub = await box(".snooze .pop.subm");
    const parent = await box(".snooze .pop.main");
    if (!(sub.l >= parent.r - 1 || sub.r <= parent.l + 1)) throw new Error(`подменю закрывает меню: ${JSON.stringify({ parent, sub })}`);
    if (sub.l < 0 || sub.r > (await d.exec("return window.innerWidth")) || sub.t < 0 || sub.b > (await d.exec("return window.innerHeight"))) {
      throw new Error(`подменю вышло за окно: ${JSON.stringify(sub)}`);
    }
    if ((await d.findAll(".snooze .mi.parent")).length !== 1) throw new Error("родитель подменю не подсвечен");
    await screenshot("snooze-submenu");
    // «1» is Monday, ISO: lights it in the submenu; Enter snoozes.
    await press("1", { code: "Digit1" });
    await press("Enter", { code: "Enter" });
    await d.until("in Snoozed on server", async () => helper("count", "Отложенные", subj) === "1", 20000);
    await d.until("toast", async () => /Отложено до пн, \d+ [а-я]+, 9:00/.test(await textOf(".toasts")));
    await d.click(await d.xpath("//div[contains(@class,'toasts')]//button[contains(., 'Отменить')]"));
    await d.until("undone on server", async () => helper("count", "INBOX", subj) === "1" && helper("count", "Отложенные", subj) === "0", 20000);
  });

  await step("2.4", "«Вернуть сейчас»: «w» возвращает отложенное письмо в «Входящие», «z» откладывает обратно", async () => {
    const subj = `Вернуть ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 30000);
    await invoke("snooze", { ids: [await idOf(subj)], until: Math.floor(Date.now() / 1000) + 86400 });
    await d.until("in Snoozed on server", async () => helper("count", "Отложенные", subj) === "1", 20000);
    await d.button("Отложенные");
    await openBySubject(subj);
    await d.until("banner button", async () => (await textOf(".reader")).includes("Вернуть сейчас"));
    await press("w");
    // The toast first: it does not wait for the server and goes away in a few seconds.
    await d.until("toast", async () => (await textOf(".toasts")).includes(`Возвращено во «Входящие»: ${subj}`), 5000, 200);
    await d.until("back in inbox on server", async () => helper("count", "INBOX", subj) === "1" && helper("count", "Отложенные", subj) === "0", 20000);
    // The undo snoozes it again, for the same time.
    await press("z");
    await d.until("snoozed again", async () => helper("count", "Отложенные", subj) === "1" && helper("count", "INBOX", subj) === "0", 20000);
    // Put things in order: back to the inbox for the steps that follow.
    await d.button("Отложенные");
    await openBySubject(subj);
    await press("w");
    await d.until("inbox again", async () => helper("count", "INBOX", subj) === "1", 20000);
  });

  // The window read afresh; the click that follows must not land in the page being left.
  await step("4.12", "письмо с Markdown-частью: переключатель «HTML · Markdown · Текст», задачи галочками, настройка «Показывать письма»", async () => {
    const subj = `Заметки ${stamp}`;
    helper("deliver-markdown", subj);
    await d.button("Входящие");
    await openBySubject(subj);
    const modes = async () =>
      (await d.exec("return [...document.querySelectorAll('.reader .letter-view [role=radio]')].map((b) => b.textContent.trim() + (b.getAttribute('aria-checked') === 'true' ? '*' : ''))")).join(" ");
    // As the sender sent it: the HTML, which Depesha puts last.
    await d.until("switch", async () => (await modes()) === "HTML* Markdown Текст");
    // The Markdown part is the letter's text, not an attachment.
    if ((await d.findAll(".reader .files")).length) throw new Error("Markdown-часть показана вложением");
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Markdown']"));
    const md = await d.until("markdown drawn", () =>
      d.exec(`const doc = document.querySelector('.reader iframe')?.contentDocument;
        if (!doc?.querySelector('h1')) return null;
        return { boxes: doc.querySelectorAll('input[type=checkbox][disabled]').length, done: doc.querySelectorAll('input[type=checkbox][checked]').length,
                 table: !!doc.querySelector('table') };`),
    );
    if (md.boxes !== 2 || md.done !== 1 || !md.table) throw new Error(`Markdown нарисован не так: ${JSON.stringify(md)}`);
    await screenshot("markdown-message");
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Текст']"));
    await d.until("plain text", async () => (await textOf(".reader .plain")).includes("- [x] договор подписан"));
    // The choice in a letter holds while it is open; the setting decides for the next one.
    const settings = await invoke("settings_get");
    await invoke("settings_set", { settings: { ...settings, letter_view: "markdown" } });
    await openBySubject("Счёт за октябрь");
    if ((await d.findAll(".reader .letter-view")).length) throw new Error("переключатель у письма без Markdown");
    await openBySubject(subj);
    await d.until("markdown preferred", async () => (await modes()) === "HTML Markdown* Текст");
    // The mailbox's own form comes before the setting (#105); the setting stays "markdown" here.
    const [mailbox] = await invoke("accounts");
    await invoke("account_save", { account: { ...mailbox, letter_view: "text" }, password: null, grant: null });
    await invoke("settings_set", { settings: { ...settings, letter_view: "sender" } });
    // The window reads the mailboxes once: a reload shows the saved one.
    await reloadWindow();
    await d.button("Входящие");
    await openBySubject(subj);
    await d.until("mailbox view applied", async () => (await modes()) === "HTML Markdown Текст*");
    await invoke("account_save", { account: { ...mailbox, letter_view: null }, password: null, grant: null });
    await reloadWindow();
    await d.button("Входящие");
  });

  await step("4.15", "печать письма (#70): Ctrl+P, палитра, «Ещё», меню строки и окно письма печатают отдельный лист — шапку и тело в виде на экране, не интерфейс", async () => {
    // The system's print dialog cannot be driven: the frame's print() is replaced, and what the
    // frame holds at that moment is what would be printed. The sheets are kept for the pictures.
    const intercept = () =>
      d.exec(`if (window.__prints) return;
        window.__prints = [];
        const get = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get() {
          const w = get.call(this);
          if (w && this.classList.contains('print-frame') && !w.__hooked) {
            w.__hooked = true;
            const frame = this;
            w.print = () => window.__prints.push({ html: frame.contentDocument.documentElement.outerHTML, text: frame.contentDocument.body.innerText,
              main: frame.contentDocument.querySelector('main')?.innerHTML ?? '',
              // How many boxes of the body sit over the header: a letter's own placing must not reach it.
              overHeader: (() => { const d = frame.contentDocument, h = d.querySelector('header').getBoundingClientRect();
                return [...d.querySelectorAll('main *')].filter((el) => { const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && r.top < h.bottom && r.bottom > h.top && r.left < h.right && r.right > h.left; }).length; })(), width: frame.getBoundingClientRect().width, hidden: getComputedStyle(frame).display === 'none' });
          }
          return w;
        } });`);
    const count = () => d.exec("return window.__prints.length");
    const lastPrint = () => d.exec("return window.__prints.at(-1)");
    const sheet = async (n, name) => {
      await d.until(`print ${n}`, async () => (await count()) === n, 20000);
      const p = await lastPrint();
      writeFileSync(join(screens, `print-${name}.html`), p.html);
      return p;
    };
    // The key as the window gets it; true when the browser's own Ctrl+P was stopped.
    const ctrlP = (target = "window") =>
      d.exec(`const e = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true });
        (arguments[0] === 'window' ? window : document.querySelector(arguments[0])).dispatchEvent(e); return e.defaultPrevented;`, target);
    const expectIn = (what, text, ...parts) => {
      for (const part of parts) if (!text.includes(part)) throw new Error(`${what}: нет «${part}»`);
    };
    const expectNot = (what, text, ...parts) => {
      for (const part of parts) if (text.includes(part)) throw new Error(`${what}: есть «${part}»`);
    };

    // 1. An HTML letter with a file: Ctrl+P on the open letter.
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    await intercept();
    // The folder tree of the mailbox has been seen gone at the end of this step (#129): who folded it is kept here.
    await d.exec(`window.__folds = [];
      document.addEventListener('click', (e) => { if (e.target.closest?.('.account-name')) window.__folds.push({ trusted: e.isTrusted, x: e.clientX, y: e.clientY, detail: e.detail,
        focus: document.activeElement?.className, at: Math.round(performance.now()) }); }, true);`);
    if (!(await ctrlP())) throw new Error("Ctrl+P не отнят у браузера: он напечатал бы весь интерфейс");
    let p = await sheet(1, "html");
    expectIn("лист HTML-письма", p.html, "<h1>HTML-письмо с картинками</h1>", "<dt>От</dt><dd>Рассылка &lt;news@example.org&gt;</dd>", "<dt>Кому</dt>", "<dt>Дата</dt>", "<dt>Вложения</dt><dd>report.pdf</dd>", "Новости", "data:image/png");
    expectNot("лист HTML-письма", p.html, "<script>", "onclick", "class=\"reader\"", "<nav");
    // Remote pictures print as the screen shows them: this sender may be trusted by now (4.4).
    const onScreen = await d.exec("return /img-src data: https: http:/.test(document.querySelector('.reader iframe').srcdoc)");
    if (p.html.includes("img-src data: https: http:") !== onScreen) throw new Error(`внешние картинки: на экране ${onScreen}, в листе ${!onScreen}`);
    if (!onScreen) expectNot("лист HTML-письма", p.html, "tracker.example");
    if (p.html.split("</header>")[0].includes("<img")) throw new Error("в шапке листа картинка (логотип)");
    if (p.overHeader) throw new Error(`тело письма лежит поверх шапки листа: ${p.overHeader}`);
    if (p.hidden || p.width < 700) throw new Error(`кадр печати не уложен на лист: ${JSON.stringify({ hidden: p.hidden, width: p.width })}`);
    if ((await d.findAll("iframe.print-frame")).length !== 1) throw new Error("кадров печати не один");

    // 2. The form on screen: Markdown, then text. A letter in the thread prints alone.
    const subj = `Заметки ${stamp}`;
    await openBySubject(subj).catch(async (e) => {
      throw new Error(`${e.message}; список: ${JSON.stringify(await d.exec("return [document.querySelector('.list h2')?.innerText, ...[...document.querySelectorAll('.row .subject')].slice(0, 12).map((x) => x.innerText)]"))}`);
    });
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Markdown']"));
    await d.until("markdown drawn", () => d.exec("return !!document.querySelector('.reader iframe')?.contentDocument?.querySelector('h1')"));
    await ctrlP();
    p = await sheet(2, "markdown");
    expectIn("лист Markdown", p.html, `<h1>${subj}</h1>`, "<table", "type=\"checkbox\"", "border-collapse:collapse");
    if (!p.main.includes("<h1")) throw new Error("в теле листа нет заголовка Markdown");
    await d.click(await d.xpath("//div[contains(@class,'letter-view')]//button[normalize-space(.)='Текст']"));
    await d.until("text drawn", async () => (await d.findAll(".reader .plain")).length === 1);
    await ctrlP();
    p = await sheet(3, "text");
    expectIn("лист текста", p.main, "class=\"plain\"");
    expectNot("лист текста", p.main, "<h1", "<table");

    // 3. «More», the palette.
    await d.click(await d.find(".reader .toolbar [aria-label='Ещё']"));
    await d.click(await d.until("print item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'mi')][contains(., 'Печать')]")));
    p = await sheet(4, "more-menu");
    expectIn("лист из меню «Ещё»", p.html, `<h1>${subj}</h1>`);
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "печать");
    await d.until("palette lists print", async () => (await textOf(".palette")).includes("Печать"));
    await d.type(await d.find(".palette .q"), "\uE007");
    p = await sheet(5, "palette");
    expectIn("лист из палитры", p.html, `<h1>${subj}</h1>`);

    // 4. The context menu of a row prints that letter.
    const other = "Счёт за октябрь";
    await rowBySubject(other);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       const r = row.getBoundingClientRect();
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));`,
      other,
    );
    await d.until("row menu", async () => (await textOf(".pop")).includes("Печать"));
    await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(@class,'mi')][contains(., 'Печать')]"));
    p = await sheet(6, "row-menu");
    expectIn("лист из меню строки", p.html, `<h1>${other}</h1>`);
    // The right click selects the row, as it always did, so the reader shows it by now; the sheet is its own.
    if ((await d.findAll("iframe.print-frame")).length !== 1) throw new Error("кадров печати не один");

    // 5. In a composition the key is still the app's, and prints nothing.
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    if (!(await ctrlP(".compose textarea"))) throw new Error("в письме, которое пишут, Ctrl+P достался браузеру");
    await new Promise((r) => setTimeout(r, 400));
    if ((await count()) !== 6) throw new Error("Ctrl+P в написании письма напечатал лист");
    await d.click(await d.find(".compose header button:last-child"));
    await composeClosed();

    // 6. The letter's own window: the same function.
    const title = "Документы на проверку";
    const main = await d.req("GET", d.s("/window"));
    await openFolder("Работа").catch(async (e) => {
      const seen = await d.exec(`return { folds: window.__folds, stored: localStorage.getItem('depesha.sidebar.collapsed'), at: Math.round(performance.now()),
        side: document.querySelector('nav.side').innerText.slice(0, 300) }`);
      throw new Error(`${e.message}; ящик: ${JSON.stringify(seen)}`);
    });
    await rowBySubject(title);
    await d.exec(
      `const row = [...document.querySelectorAll('.row')].find(r => r.innerText.includes(arguments[0]));
       row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`,
      title,
    );
    const handles = () => d.req("GET", d.s("/window/handles"));
    await d.until("second window", async () => (await handles()).length === 2, 15000);
    const own = (await handles()).find((h) => h !== main);
    await d.req("POST", d.s("/window"), { handle: own });
    try {
      await d.until("letter in its window", async () => (await textOf(".reader h1")).includes(title), 20000);
      await intercept();
      if (!(await ctrlP())) throw new Error("в окне письма Ctrl+P достался браузеру");
      p = await sheet(1, "window");
      expectIn("лист из окна письма", p.html, `<h1>${title}</h1>`, "<dt>Вложения</dt>", "contract.pdf");
      await press("Escape");
      await d.until("window closed", async () => (await handles()).length === 1, 20000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
    await d.button("Входящие");

    // 7. The letter's own frame: its links, hover and keys reach the app, and nothing in it runs.
    await openBySubject("HTML-письмо с картинками");
    const frameDoc = "document.querySelector('.reader iframe').contentDocument";
    const inFrame = async () => {
      const frame = await d.find(".reader iframe");
      const r = await d.exec("const b = document.querySelector('.reader iframe').getBoundingClientRect(); return [b.width, b.height]");
      // The lower right corner: the letter's text and links are up and to the left.
      await d.clickAt(frame, Math.round(r[0] / 2) - 12, Math.round(r[1] / 2) - 12);
      if ((await d.exec("return document.activeElement?.tagName")) !== "IFRAME") throw new Error("фокус не в кадре письма");
    };
    // The frame's handlers are attached: a link's hover shows its address, and a click asks before
    // opening it instead of the frame following it.
    // The reader shows the subject before the body: the frame is blank until its srcdoc has loaded.
    await d.until("letter frame drawn", () => d.exec(`return !!${frameDoc}?.querySelector('a')`));
    await d.exec(`${frameDoc}.querySelector('a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await d.until("link hover reaches the app", async () => (await textOf(".reader .status")).includes("example.com/news"));
    const clickLink = (selector) =>
      d.exec(`${frameDoc}.querySelector(arguments[0]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`, selector);
    const dismissQuestion = async () => {
      await press("Escape");
      await d.until("question closed", async () => (await d.findAll(".confirm")).length === 0);
    };
    await clickLink("a");
    await d.until("link asks first", async () => (await textOf(".confirm")).includes("example.com"));
    await dismissQuestion();

    // 7a. The keys as the driver sends them, with the focus on the page and then inside the frame:
    // the frame replays them to the window (MailFrame.svelte), so the palette opens and the letter prints.
    const paletteOpen = async () => (await d.findAll(".palette")).length === 1;
    const closePalette = async () => {
      await d.pressKey("\uE00C");
      await d.until("palette closed", async () => !(await paletteOpen()));
    };
    await d.exec("document.activeElement?.blur()");
    await d.chord(["\uE009"], "k");
    await d.until("palette by a key on the page", paletteOpen);
    await closePalette();
    await inFrame();
    await d.chord(["\uE009"], "k");
    await d.until("palette by a key in the letter's frame", paletteOpen);
    await closePalette();
    const before = await count();
    await inFrame();
    await d.chord(["\uE009"], "p");
    p = await sheet(before + 1, "frame-key");
    expectIn("лист по Ctrl+P из кадра письма", p.html, "<h1>HTML-письмо с картинками</h1>");
    // 7b. The same key as an event of the frame's own document: the window takes it, so the frame's default is cancelled.
    const prevented = await d.exec(
      `const e = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true });
       ${frameDoc}.body.dispatchEvent(e); return e.defaultPrevented;`,
    );
    if (!prevented) throw new Error("Ctrl+P в кадре письма достался браузеру");
    await sheet(before + 2, "frame-key-event");

    // 7c. Nothing a letter writes runs in its frame: an image with a handler, a javascript: link and a
    // data: image with a script do not reach the page (`parent.__pwned`), and the frame stays where it is.
    await d.exec(`window.__pwned = undefined;
      ${frameDoc}.body.innerHTML = '<img src="x" onerror="parent.__pwned=1">' +
        '<a id="js" href="javascript:parent.__pwned=1">j</a>' +
        '<a id="svg" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cscript%3Eparent.__pwned=1%3C/script%3E%3C/svg%3E">s</a>';`);
    await new Promise((r) => setTimeout(r, 800));
    for (const id of ["#js", "#svg"]) {
      await clickLink(id);
      // The app asks before it opens any address, and is answered «no».
      await d.until(`${id} asks first`, async () => (await d.findAll(".confirm")).length === 1);
      await dismissQuestion();
    }
    await new Promise((r) => setTimeout(r, 500));
    const pwned = await d.exec(`return { pwned: window.__pwned ?? null, url: document.querySelector('.reader iframe').contentWindow.location.href, kept: !!${frameDoc}.getElementById('js') }`);
    if (pwned.pwned !== null) throw new Error("critical: в кадре письма выполнился код письма (parent.__pwned)");
    if (pwned.url !== "about:srcdoc" || !pwned.kept) throw new Error(`кадр письма перешёл по ссылке: ${JSON.stringify(pwned)}`);

    // 8. A letter that places its text at the top of the page does not cover the header of the sheet.
    const forged = `Подделка шапки ${stamp}`;
    helper("deliver-overlay", forged);
    await d.button("Входящие");
    await openBySubject(forged);
    await ctrlP();
    p = await sheet(before + 3, "overlay");
    expectIn("лист письма-подделки", p.main, "ПОДДЕЛЬНАЯ ШАПКА", "position:absolute");
    expectIn("лист письма-подделки", p.html, `<h1>${forged}</h1>`, "<dd>Mallory &lt;mallory@example.org&gt;</dd>");
    if (p.overHeader) throw new Error(`письмо легло поверх шапки листа: ${p.overHeader} блоков`);
  });

  // The sidebar's rows by their tops: the smart rows above the mailboxes and the folders of the tree (#158).
  const sidebarRows = () =>
    d.exec(`const items = [...document.querySelectorAll('nav.side .item')];
      const at = (list, name) => list.find((b) => b.querySelector('.name')?.innerText.trim() === name)?.getBoundingClientRect().top ?? null;
      // The row of the smart sections above the mailboxes; the folder of the same name is in the tree.
      const smart = [...(document.querySelector('nav.side .scroll .group')?.querySelectorAll('.item') ?? [])];
      return { loading: !!window.__before, snoozed: at(smart, 'Отложенные'), inbox: at(items, 'Входящие') };`);
  // A launch: the page is read anew, the first frame that has the folder tree is taken, and the sidebar again 2 s later.
  const launchFrames = async () => {
    await d.exec("window.__before = true; location.reload()");
    const first = await d.until("tree at load", async () => {
      const r = await sidebarRows();
      return !r.loading && r.inbox !== null ? r : null;
    }, 15000, 20);
    await new Promise((r) => setTimeout(r, 2000));
    return { first, later: await sidebarRows() };
  };
  // What the launch leaves on the screen must not stand in the way of the next step: its toasts (local drafts, stuck copies) are closed.
  const closeLaunchNotices = async () => {
    await d.exec("document.querySelectorAll('.toasts .close').forEach((b) => b.click())");
    if ((await d.findAll(".confirm")).length) await press("Escape");
    await d.until("no notices", async () => (await d.findAll(".toasts .toast")).length === 0 && (await d.findAll(".confirm")).length === 0);
  };
  const snoozeOne = async (subj) => {
    helper("deliver", subj);
    await d.button("Входящие");
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
    await openBySubject(subj);
    const id = await idOf(subj);
    // A snoozed letter: the row «Snoozed» is in the sidebar, and the count is what the next launch starts from.
    await invoke("snooze", { ids: [id], until: Math.floor(Date.now() / 1000) + 86400 });
    await d.until("snoozed row", async () => (await sidebarRows()).snoozed !== null, 20000);
    return id;
  };

  await step("4.16", "панель при запуске не сдвигается (#158): «Отложенные» стоят в первом кадре, «Входящие» через 2 с там же, где при загрузке", async () => {
    const id = await snoozeOne(`Сдвиг ${stamp}`);
    try {
      const { first, later } = await launchFrames();
      if (first.snoozed === null) throw new Error(`в первом кадре нет строки «Отложенные»: ${JSON.stringify({ first, later })}`);
      if (first.inbox !== later.inbox) throw new Error(`«Входящие» сдвинулись за 2 с после загрузки: ${JSON.stringify({ first, later })}`);
    } finally {
      await invoke("unsnooze", { ids: [id] });
      await closeLaunchNotices();
    }
  });

  await step("4.17", "выключенное «Отложить» не мелькает при запуске (#158): счётчик из кэша не рисуется, пока настройки не подтвердили плагин", async () => {
    const id = await snoozeOne(`Сдвиг выкл ${stamp}`);
    const settings = await invoke("settings_get");
    try {
      await invoke("settings_set", { settings: { ...settings, disabled_plugins: [...(settings.disabled_plugins ?? []), "snooze"] } });
      await d.until("row gone", async () => (await sidebarRows()).snoozed === null, 20000);
      // The cache still holds the count of the last run with the plugin on.
      const { first, later } = await launchFrames();
      if (first.snoozed !== null || later.snoozed !== null) throw new Error(`строка выключенного «Отложить» нарисована: ${JSON.stringify({ first, later })}`);
      if (first.inbox !== later.inbox) throw new Error(`«Входящие» сдвинулись за 2 с после загрузки: ${JSON.stringify({ first, later })}`);
    } finally {
      await invoke("settings_set", { settings });
      await d.until("row back", async () => (await sidebarRows()).snoozed !== null, 20000);
      await invoke("unsnooze", { ids: [id] });
      await closeLaunchNotices();
    }
  });

  await step("9.2", "карточка контакта: щелчок по имени открывает её, «Все письма» в фокусе, Enter ищет отправителя (#66, #44)", async () => {
    const subj = `Карточка ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await d.until("delivered", async () => helper("count", "INBOX", subj) === "1", 60000, 1000);
    await openBySubject(subj);
    // The click on the sender's name opens their card, not the search it used to run.
    await d.click(await d.find(".reader .sender"));
    await d.until("person card", async () => (await d.findAll(".pcard")).length === 1);
    // The card holds the rules of #44: the format to write in and the form to show.
    const card = await textOf(".pcard");
    if (!card.includes("Формат писем") || !card.includes("Все письма")) throw new Error(`карточка: ${card.slice(0, 200)}`);
    // The first button is «All mail» and stands in focus; Enter runs what a click used to.
    const focused = await d.exec("return document.activeElement?.innerText?.trim() ?? ''");
    if (focused !== "Все письма") throw new Error(`в фокусе «${focused}», а не «Все письма»`);
    await screenshot("person-card");
    // A real Enter on the focused button: what the keyboard does, not a synthetic event.
    await d.pressKey("\uE007");
    await d.until("search by sender", async () => (await d.exec("return document.querySelector('.list .search input')?.value ?? ''")).includes("from:petr@example.org"));
    await rowBySubject(subj, 10000);
  });
  await step("9.3", "адресная книга (#104): открыть с клавиатуры, найти контакт, изменить настройку, объединить и вернуть; ссылка «Своё у …» из настроек; карточка письма клавишей, имя в карточке", async () => {
    const people = () => invoke("people", { query: "" });
    const byEmail = async (email) => (await people()).find((p) => p.emails.some((a) => a.email.toLowerCase() === email));
    const night = (on) => d.exec("document.documentElement.dataset.theme = arguments[0]", on ? "night" : "paper");
    const was = await d.exec("return document.documentElement.dataset.theme ?? ''");
    const focusList = () => d.exec("document.querySelector('.people [role=listbox]').focus()");
    const rowMark = (mark) => d.exec(`document.querySelector('.people [data-r="${mark}"]').focus()`);
    // Two records that may be one person: the same words of a name in another order.
    for (const [email, name] of [["olga.e2e@example.org", "Ольга Смирнова"], ["smirnova.e2e@example.net", "Смирнова Ольга"]]) {
      await invoke("person_save", { person: { email, name, manual: true } });
    }
    await reloadWindow();
    await d.button("Входящие");

    // The book opens from the keyboard: the palette, «go to people».
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "перейти контакты");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("book", async () => (await d.findAll(".people")).length === 1);
    if (!(await d.findAll("nav.side .item.active")).length) throw new Error("в боковой панели «Контакты» не отмечены");
    await screenshot("people-book");
    await night(true);
    await screenshot("people-book-night");
    await night(false);

    // A person is found by a word of the name: «/» in the list goes to the search, ↓ comes back.
    await focusList();
    await d.pressKey("/");
    await d.until("search has the focus", async () => (await d.exec("return document.activeElement?.type")) === "search");
    await d.type(await d.find(".people input[type=search]"), "смирнова");
    await d.until("two found", async () => (await d.findAll(".people .pr")).length === 2);
    await d.pressKey("\uE015");
    await d.until("list has the focus", async () => (await d.exec("return document.activeElement?.getAttribute('role')")) === "listbox");
    // The card on the right is the first person's, and it suggests the second as the same person.
    const cards = await textOf(".people .pd");
    if (!cards.includes("Ольга Смирнова")) throw new Error(`карточка справа: ${cards.slice(0, 200)}`);
    if (!(await textOf(".people .pd .pc-dup")).includes("Смирнова Ольга")) throw new Error(`нет подсказки о дубле в карточке: ${cards.slice(0, 300)}`);

    // Enter goes into the card, on «All mail»; its format is turned by the arrows and saved at once.
    await d.pressKey("\uE007");
    await d.until("card has the focus", async () => (await d.exec("return document.activeElement?.dataset?.r")) === "all");
    await rowMark("fmt");
    await d.pressKey("\uE014");
    await d.until("format saved", async () => (await byEmail("olga.e2e@example.org"))?.send_format === "html", 15000);
    await screenshot("people-card");
    await night(true);
    await screenshot("people-card-night");
    await night(false);

    // Esc comes back to the list; M joins the suggested pair, the dialog shows what it offers, Enter takes it.
    await d.pressKey("\uE00C");
    await d.until("list again", async () => (await d.exec("return document.activeElement?.getAttribute('role')")) === "listbox");
    // Space marks the two, the banner counts them, M opens the dialog.
    await d.pressKey(" ");
    await d.pressKey("\uE015");
    await d.pressKey(" ");
    await d.until("two marked", async () => (await textOf(".people .banner")).includes("Отмечено: 2"));
    await d.pressKey("m");
    await d.until("merge dialog", async () => (await d.findAll(".merge")).length === 1);
    await screenshot("people-merge");
    await night(true);
    await screenshot("people-merge-night");
    await night(false);
    await d.pressKey("\uE007");
    await d.until("merged", async () => (await byEmail("olga.e2e@example.org"))?.emails.length === 2, 15000);
    await d.until("undo toast", async () => (await textOf(".toasts")).includes("Объединено"));
    const merged = await byEmail("smirnova.e2e@example.net");
    if (merged.send_format !== "html") throw new Error(`правило не сохранилось при объединении: ${JSON.stringify(merged)}`);
    // Z takes it back: two people again, each with their own address.
    await d.pressKey("z");
    await d.until("split back", async () => (await byEmail("olga.e2e@example.org"))?.emails.length === 1 && (await byEmail("smirnova.e2e@example.net"))?.emails.length === 1, 15000);

    // The way from the settings: «Own at …» on the format's row opens the book, narrowed to the people with a format.
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='writing']"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    await d.click(await d.find(".prefs [data-row='layer_format'] .lnk"));
    // Several places differ (a mailbox too): the way is a menu, and the person is picked in it.
    if (await d.exec("return new Promise((r) => setTimeout(() => r(!!document.querySelector('.pop')), 400))")) {
      await d.click(await d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Ольга Смирнова')]"));
    }
    await d.until("book from settings", async () => (await d.findAll(".people")).length === 1 && (await d.findAll(".prefs")).length === 0);
    if (!(await textOf(".people .fchip.on")).includes("С особым форматом")) throw new Error("список не отфильтрован по «С особым форматом»");
    await screenshot("people-from-settings");
    if ((await d.findAll(".prefs .tab[data-page='people']")).length) throw new Error("в настройках остался пункт «Контакты»");

    // The test people go away; the letter of 9.2 gets its card by the key, and the name is written in it.
    for (const email of ["olga.e2e@example.org", "smirnova.e2e@example.net"]) await invoke("person_forget", { email });
    await d.button("Входящие");
    const subj = `Карточка ${stamp}`;
    await openBySubject(subj);
    await d.exec("document.activeElement?.blur?.()");
    await d.pressKey("p");
    await d.until("card by the key", async () => (await d.findAll(".pcard")).length === 1);
    await d.until("card focus", async () => (await d.exec("return document.activeElement?.dataset?.r")) === "all");
    await screenshot("people-letter-card");
    await d.pressKey("\uE013");
    await d.pressKey("\uE032");
    await d.until("name line", async () => (await d.findAll(".pcard input[data-own]")).length === 1);
    await d.type(await d.find(".pcard input[data-own]"), " Е2Е\uE007");
    await d.until("name saved", async () => (await byEmail("petr@example.org"))?.name.endsWith("Е2Е"), 15000);
    // Esc leaves the line without closing the card; the name goes back to what the letters say.
    await d.pressKey("\uE032");
    await d.until("name line again", async () => (await d.findAll(".pcard input[data-own]")).length === 1);
    await d.pressKey("\uE00C");
    if ((await d.findAll(".pcard")).length !== 1) throw new Error("Esc в строке имени закрыл карточку");
    await d.pressKey("\uE032");
    await d.until("name line third", async () => (await d.findAll(".pcard input[data-own]")).length === 1);
    // The line opens with the name selected: BackSpace empties it, Enter saves an empty name (the letters' own comes back).
    await d.pressKey("\uE003");
    await d.pressKey("\uE007");
    await d.until("name back", async () => !(await byEmail("petr@example.org"))?.name.endsWith("Е2Е"), 15000);
    await d.pressKey("\uE00C");
    await d.until("card closed", async () => (await d.findAll(".pcard")).length === 0);
    await d.exec("document.documentElement.dataset.theme = arguments[0]", was);
  });
}
