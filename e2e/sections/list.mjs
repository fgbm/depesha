// Section "list" of the run (see e2e/shard.mjs for the split into parts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropFixtures, dropOn, dropSteps, zonesStayInView } from "../drop-steps.mjs";
import { root, profile, d, helper, screenshot, step, rowBySubject, openBySubject, openFolder, textOf, setInput, invoke, refused, pickFolder, press, pressIn, composeClosed, closeSettings, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
  section("list");
  await step("108.1", "аватары в списке: круг в каждой строке, снимки в обеих темах, выключатель #108", async () => {
    await d.button("Входящие");
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    const count = async (sel) => Number(await d.exec(`return document.querySelectorAll('${sel}').length`));
    await d.until("a circle in every row", async () => {
      const rows = await count(".list .row");
      return rows > 0 && (await count(".list .row .pic")) === rows ? rows : null;
    }, 15000);
    // Initials: the stand's mail brings no DMARC verdict, so no logo is asked from the network.
    const initials = await d.exec("return document.querySelector('.list .row .pic')?.textContent.trim()");
    if (!initials) throw new Error("в круге нет инициалов");
    if ((await count(".list .row .pic button, .list .row .pic a, .list .row .pic [tabindex]")) > 0) throw new Error("кружок получил фокус или стал ссылкой");
    const settings = await invoke("settings_get");
    const theme = async (name) => {
      await invoke("settings_set", { settings: { ...settings, theme: name } });
      await d.until(`theme ${name}`, async () => (await d.exec("return document.documentElement.dataset.theme")) === name, 10000);
    };
    // The same list in the light theme and in the dark one, then back: the run keeps its own.
    await theme("paper");
    await screenshot("list-avatars-paper");
    await theme("night");
    await screenshot("list-avatars-night");
    await invoke("settings_set", { settings });
    // Off, the list is as before the avatars: no circles, the text starts where it did.
    await invoke("settings_set", { settings: { ...settings, list_avatars: false } });
    await d.until("no circles", async () => (await count(".list .row .pic")) === 0 && (await count(".list .row.avatars")) === 0, 10000);
    await invoke("settings_set", { settings: { ...settings, list_avatars: true } });
    await d.until("circles back", async () => (await count(".list .row .pic")) > 0, 10000);
  }, { retry: true });

  await step("72.1", "важность: «!» в строке списка, строка в шапке письма, поиск «это:важное» (#72)", async () => {
    const subj = `Важное ${stamp}`;
    helper("deliver-important", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 60000);
    const bang = () => d.exec(`return [...document.querySelectorAll('.list .row')].find(r => r.innerText.includes(arguments[0]))?.querySelector('.imp')?.innerText.trim() ?? ''`, subj);
    await d.until("a bang in the row", async () => (await bang()) === "!", 15000);
    await screenshot("importance-list");
    await openBySubject(subj);
    await d.until("the line in the header", async () => (await textOf(".reader")).includes("Отправитель отметил как важное"), 15000);
    await screenshot("importance-reader");
    // An ordinary letter beside it has neither.
    if ((await d.exec(`return [...document.querySelectorAll('.list .row')].filter(r => r.querySelector('.imp')).length`)) !== 1) throw new Error("«!» не только у важного письма");
    const box = await d.find(".list .search input");
    await d.clear(box);
    await d.type(box, "это:важное");
    await d.until("search view", async () => (await textOf(".list h2")).trim() === "Поиск");
    await rowBySubject(subj, 15000);
    const found = await d.exec(`return document.querySelectorAll('.list .row').length`);
    if (found < 1) throw new Error("поиск «это:важное» ничего не нашёл");
    await d.type(box, "\uE00C");
  }, { retry: true });

  await step("108.2", "выбор и курсор не путаются: открытое письмо с кругом и полосой, выбранные с галочкой (#108, 2.5 Б), снимки в обеих темах", async () => {
    await d.button("Входящие");
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    const settings = await invoke("settings_get");
    // Read mass letters far from the top: opening them changes no counter the later steps read.
    const OPEN = 6;
    const rowAt = (i) => `document.querySelectorAll('.list .row')[${i}]`;
    const ctrlClick = (i) => d.exec(`${rowAt(i)}.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
    const state = (i) => d.exec(`const r = ${rowAt(i)}; return { pic: !!r.querySelector('.pic'), pick: !!r.querySelector('.pick'), selected: r.classList.contains('selected'), cursor: r.classList.contains('cursor') }`);
    const theme = async (name) => {
      await invoke("settings_set", { settings: { ...settings, theme: name, list_avatars: shotAvatars } });
      await d.until(`theme ${name}`, async () => (await d.exec("return document.documentElement.dataset.theme")) === name, 10000);
    };
    let shotAvatars = true;
    for (const avatars of [true, false]) {
      shotAvatars = avatars;
      const tag = avatars ? "" : "-plain";
      await theme("paper");
      // The letter that is open: the circle stays, the bar stands at the left, no ground, no tick.
      await d.exec(`${rowAt(OPEN)}.click()`);
      await d.until("opened row", async () => (await state(OPEN)).cursor, 10000);
      let s = await state(OPEN);
      if (s.pick || s.selected) throw new Error(`открытое письмо показано как выбранное: ${JSON.stringify(s)}`);
      if (avatars && !s.pic) throw new Error("у открытого письма пропал круг");
      await screenshot(`row-cursor${tag}-paper`);
      await theme("night");
      await screenshot(`row-cursor${tag}-night`);
      // Two chosen together: a tick and the ground on both; the open one keeps its bar too.
      await ctrlClick(OPEN + 1);
      await d.until("two chosen", async () => (await state(OPEN + 1)).selected, 10000);
      for (const i of [OPEN, OPEN + 1]) {
        s = await state(i);
        if (!s.pick || !s.selected || s.pic) throw new Error(`строка ${i} не показана как выбранная: ${JSON.stringify(s)}`);
      }
      await screenshot(`row-chosen${tag}-night`);
      await theme("paper");
      await screenshot(`row-chosen${tag}-paper`);
      // Back to one letter.
      await d.exec(`${rowAt(OPEN + 2)}.click()`);
      await d.until("one again", async () => !(await state(OPEN + 1)).selected, 10000);
    }
    await invoke("settings_set", { settings });
  }, { retry: true });

  await step("108.3", "полоса курсора переезжает на j сразу, до ответа сервера (#108, 2.5 Б)", async () => {
    await d.button("Входящие");
    await d.exec("document.querySelector('.viewport').scrollTop = 0");
    const at = 6;
    const rows = `document.querySelectorAll('.list .row')`;
    await d.until("the list is drawn", async () => (await d.exec(`return ${rows}.length`)) > at + 2, 15000);
    await d.exec(`${rows}[${at}].click()`);
    await d.until("first letter open", async () => (await d.exec(`return ${rows}[${at}].classList.contains('cursor')`)) && (await textOf(".reader h1")).length > 0, 10000);
    const shown = await textOf(".reader h1");
    await press("j");
    // The key was just pressed: the letter is asked for after a pause and comes later, the bar
    // is already on the next row while the reader still shows the old letter.
    const now = await d.exec(`return { cursor: [...${rows}].findIndex(r => r.classList.contains('cursor')), h1: document.querySelector('.reader h1')?.innerText ?? '' }`);
    if (now.cursor !== at + 1) throw new Error(`полоса не переехала на j сразу: строка ${now.cursor}, ждали ${at + 1}`);
    if (now.h1.trim() !== shown.trim()) throw new Error("письмо открылось раньше полосы: шаг ничего не проверил");
    await d.until("the next letter opened", async () => (await textOf(".reader h1")) !== shown, 10000);
  }, { retry: true });

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
  }, { retry: true });

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
    // The letter is drawn a moment after it is opened: wait for the answer, not for the first look.
    await d.until("trust kept", async () => !(await d.bodyText()).includes("Внешние картинки скрыты"));
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

  await step("4.5.2", "папка для вложений: «Сохранить» и «Сохранить все» без диалога, имена не затираются", async () => {
    const dir = join(profile, "Вложения");
    const setDir = async (value) => {
      await press(",", { ctrlKey: true });
      await d.click(await d.until("writing page", () => d.find(".prefs .tab[data-page='writing']")));
      const row = ".prefs [data-row='attachments_dir']";
      const shown = () => d.exec(`return document.querySelector("${row} .path").title`);
      await d.until("folder field", () => d.find(`${row} .folder`));
      // Picked in the dialog: the field is not typed into.
      if (value) {
        await pickFolder(value);
        await d.click(await d.find(`${row} .folder .btn:not(.ghost)`));
        await d.until("folder picked", async () => (await shown()) === value);
      } else {
        const clear = await d.findAll(`${row} .folder .btn.ghost`);
        if (clear.length) await d.click(clear[0]);
        await d.until("folder cleared", async () => (await shown()) === "");
      }
      // Saved the moment it was picked: the window closes with nothing to confirm.
      await closeSettings();
    };
    await setDir(dir);
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    const saveButton = () => d.xpath("//div[contains(@class,'file')][contains(., 'report.pdf')]//button[@aria-label='Сохранить']");
    // The folder does not exist yet: it is made.
    await d.click(await saveButton());
    await d.until("saved without a dialog", async () => readdirSync(dir).includes("report.pdf"), 10000);
    await d.click(await saveButton());
    await d.until("second copy beside", async () => readdirSync(dir).includes("report (1).pdf"), 10000);
    await openFolder("Работа");
    await openBySubject("Документы на проверку");
    // With a few files more than two rows hold, «Save all» ends the list behind «+N more».
    if ((await d.findAll(".reader .files > button")).length) {
      await d.button("Сохранить все");
    } else {
      await d.click(await d.find(".reader .files .more"));
      await d.click(await d.until("save all in the list", () => d.xpath("//div[contains(@class,'pop')]//button[normalize-space(.)='Сохранить все']")));
    }
    await d.until("all saved", async () => ["contract.pdf", "sums.csv"].every((f) => readdirSync(dir).includes(f)), 10000);
    await d.button("Входящие");
    if (readFileSync(join(dir, "report (1).pdf")).subarray(0, 8).toString() !== "%PDF-1.4") throw new Error("копия искажена");
    await setDir("");
  });

  await step("8.5", "пути не из диалога отклоняются: файлы не пишутся и не читаются", async () => {
    const outside = join(tmpdir(), `depesha-e2e-outside-${process.pid}`);
    const rows = await invoke("search", { text: "HTML письмо картинками", accountId: null });
    const id = rows[0]?.id;
    if (!id) throw new Error("письмо не найдено поиском");
    const accountId = (await invoke("accounts"))[0].id;
    const settings = await invoke("settings_get");
    await refused("attachment_save", { id, index: 1, path: join(outside, "report.pdf") });
    await refused("settings_set", { settings: { ...settings, attachments_dir: outside } });
    if ((await invoke("settings_get")).attachments_dir !== settings.attachments_dir) throw new Error("папка вложений сменилась");
    await refused("attachments_save_all", { id, dir: outside });
    if (existsSync(outside)) throw new Error(`создано: ${outside}`);
    const secret = "/etc/hostname";
    const err = await refused("file_info", { path: secret });
    if (/\d{2,}/.test(err)) throw new Error(`file_info раскрыл размер: ${err}`);
    const draft = { from: null, to: [{ name: null, email: "someone@example.org" }], subject: "e2e: чужой файл", text: "", attachments: [{ kind: "file", path: secret }] };
    await refused("draft_save", { accountId, draft, replace: null });
    await refused("send", { accountId, draft, discardDraft: null, at: null, followupSecs: null });
    if ((await invoke("outbox")).some((o) => o.draft.subject === draft.subject)) throw new Error("письмо с чужим файлом в «Исходящих»");
    await refused("extension_install", { path: join(outside, "plugin"), permissions: [], hooks: [] });
    await refused("extension_storage_set", { id: "../../x", key: "k", value: 1 });
  });

  await step("4.10", "просмотрщик вложений в области чтения: PDF, Word, Excel, Markdown, CSV в cp1251; ←/→ и Esc", async () => {
    // The shown file's chip is framed; a file behind «+N more» frames that button instead.
    const current = () =>
      d.exec("const c = [...document.querySelectorAll('.reader .file.current .fname')].map((e) => e.innerText); if (document.querySelector('.reader .files .more.current')) c.push('+N ещё'); return c;");
    const frameText = () =>
      d.exec("return document.querySelector('.viewer iframe')?.contentDocument?.body?.innerText ?? ''");
    await openFolder("Работа");
    await openBySubject("Документы на проверку");
    await d.click(await d.until("contract.pdf", () => d.xpath("//button[contains(@class,'file-name')][contains(., 'contract.pdf')]")));
    await d.until("pdf page drawn", () => d.exec("return !!document.querySelector('.viewer .page canvas')"), 20000);
    await d.until("pdf text layer", async () => (await textOf(".viewer .page")).includes("Договор поставки"), 10000);
    await screenshot("viewer-pdf");
    // In place of the letter's text: the list, the letter's header and its attachments stay.
    if (!(await d.exec("return !!document.querySelector('.reader .viewer') && !!document.querySelector('.list .row') && !!document.querySelector('.reader h1')")))
      throw new Error("просмотрщик не в области чтения");
    if ((await current()).join() !== "contract.pdf") throw new Error(`подсвечено: ${await current()}`);
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
    const csv = await current();
    if (csv.length !== 1 || !(csv[0].endsWith(".csv") || csv[0] === "+N ещё")) throw new Error(`подсвечено: ${csv}`);
    await press("Escape");
    await d.until("viewer closed", async () => (await d.findAll(".viewer")).length === 0);
    if ((await current()).length) throw new Error("подсветка осталась после Esc");
    if (!(await textOf(".reader .body")).trim()) throw new Error("текст письма не вернулся");
    // The shown attachment clicked again takes back to the letter.
    const pdf = () => d.xpath("//button[contains(@class,'file-name')][contains(., 'contract.pdf')]");
    await d.click(await pdf());
    await d.until("viewer open", async () => (await d.findAll(".viewer")).length === 1);
    await d.click(await pdf());
    await d.until("viewer closed by its attachment", async () => (await d.findAll(".viewer")).length === 0);
    // A file that only pretends to be a PDF: the viewer says so and offers the application.
    await d.button("Входящие");
    await openBySubject("HTML-письмо с картинками");
    await d.click(await d.until("report.pdf", () => d.xpath("//button[contains(@class,'file-name')][contains(., 'report.pdf')]")));
    await d.until("fallback", async () => (await textOf(".viewer")).includes("не получилось показать"), 20000);
    await press("Escape");
    await d.until("viewer closed", async () => (await d.findAll(".viewer")).length === 0);
  });

  await step("4.10.2", "много вложений в письме: не больше двух рядов фишек и «+N ещё ›», текст виден; список с клавиатуры, Enter — просмотр, «Сохранить все» в конце списка", async () => {
    const subj = "Сканы акта сверки, 29 файлов";
    helper("many-files", "Работа", subj, "29")
    await openFolder("Работа");
    await rowBySubject(subj, 30000);
    await openBySubject(subj);
    const dir = process.env.E2E_SHOTS_DIR;
    const shotTo = async (name) => {
      if (!dir) return;
      // A toast in the frame is not what the picture is about.
      await d.exec("document.querySelector('.toasts')?.style.setProperty('visibility', 'hidden')").catch(() => {});
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.png`), await d.screenshot());
      await d.exec("document.querySelector('.toasts')?.style.removeProperty('visibility')").catch(() => {});
    };
    const strip = () =>
      d.exec(`
        const files = [...document.querySelectorAll('.reader .files .file')];
        const more = document.querySelector('.reader .files .more');
        const tops = new Set(files.map((f) => Math.round(f.getBoundingClientRect().top)));
        const body = document.querySelector('.reader .body').getBoundingClientRect();
        const box = document.querySelector('.reader .scroll').getBoundingClientRect();
        return {
          chips: files.length,
          rows: tops.size,
          more: more ? more.innerText.trim() : '',
          width: document.querySelector('.reader .files').clientWidth,
          seen: Math.max(0, Math.min(body.bottom, box.bottom) - Math.max(body.top, box.top)),
          text: document.querySelector('.reader .body').innerText.includes('Строка 1 '),
          saveAll: [...document.querySelectorAll('.reader .files > button')].length,
        };`);
    const check = (s, label) => {
      const m = /^\+(\d+) ещё ›$/.exec(s.more);
      if (!m) throw new Error(`${label}: нет «+N ещё ›»: ${JSON.stringify(s)}`);
      if (s.chips + Number(m[1]) !== 29) throw new Error(`${label}: ${s.chips} фишек и «${s.more}», а файлов 29`);
      if (s.rows > 2) throw new Error(`${label}: фишки в ${s.rows} рядах`);
      if (s.seen < 160) throw new Error(`${label}: текст письма виден на ${s.seen} px, нужно не меньше 160`);
      if (!s.text) throw new Error(`${label}: текста письма нет в панели`);
      if (s.saveAll) throw new Error(`${label}: «Сохранить все» осталось в ряду при свёртке`);
    };
    const settings = await invoke("settings_get");
    const theme = async (name) => {
      await invoke("settings_set", { settings: { ...settings, theme: name } });
      await d.until(`theme ${name}`, async () => (await d.exec("return document.documentElement.dataset.theme")) === name, 10000);
    };
    const rect = await d.rect();
    try {
      const wide = await d.until("folded", async () => {
        const s = await strip();
        return s.more ? s : null;
      }, 15000);
      check(wide, "широкая панель");
      for (const name of ["paper", "night"]) {
        await theme(name);
        await screenshot(`many-attach-wide-${name}`);
        await shotTo(`wide-${name}`);
      }
      await theme("paper");

      // The pane resized: the rows are counted again for its width.
      await d.setRect(960, rect.height);
      const narrow = await d.until("recounted", async () => {
        const s = await strip();
        return s.more && s.width !== wide.width ? s : null;
      }, 15000);
      check(narrow, "узкая панель");
      if (narrow.chips > wide.chips) throw new Error(`панель сузилась ${wide.width} → ${narrow.width}, а фишек стало больше: ${wide.chips} → ${narrow.chips}`);
      for (const name of ["paper", "night"]) {
        await theme(name);
        await screenshot(`many-attach-narrow-${name}`);
        await shotTo(`narrow-${name}`);
      }
      await theme("paper");
      await d.setRect(rect.width, rect.height);
      await d.until("wide again", async () => (await strip()).width === wide.width);
      check(await strip(), "широкая панель снова");

      // By Tab the last chip is followed by «+N more ›», which opens the list of every file.
      const [TAB, ENTER, UP, DOWN, LEFT, RIGHT, END, ESC] = ["\uE004", "\uE007", "\uE013", "\uE015", "\uE012", "\uE014", "\uE010", "\uE00C"];
      const active = (js) => d.exec(`const a = document.activeElement; return ${js};`);
      const onMore = () => active("a.classList.contains('more')");
      const listOf = (n) => d.until(`list of ${n}`, async () => (await d.findAll(".pop [data-att]")).length === n);
      const folded = (await strip()).chips;
      await d.exec("const f = [...document.querySelectorAll('.reader .files .file')].pop(); f.querySelectorAll('button')[f.querySelectorAll('button').length - 1].focus();");
      await d.pressKey(TAB);
      if (!(await onMore())) throw new Error("после последней фишки Tab не на «+N ещё ›»");
      await d.pressKey(ENTER);
      await listOf(29);
      // It opens from the top, the cursor on the first folded file (nothing is shown yet).
      await d.until("cursor on the first folded file", () => active(`a.dataset.att === '${folded}'`));
      const top = await d.exec("return document.querySelector('.pop').scrollTop");
      if (top !== 0) throw new Error(`список открылся прокрученным на ${top} px`);
      await shotTo("list-paper");
      await theme("night");
      await shotTo("list-night");
      await theme("paper");
      await d.pressKey(DOWN);
      if (!(await active(`a.dataset.att === '${folded + 1}'`))) throw new Error("↓ не на следующем файле");
      await d.pressKey(RIGHT);
      if (!(await active("a.dataset.act !== undefined"))) throw new Error("→ не на «Сохранить» у файла");
      await d.pressKey(DOWN);
      if (!(await active(`a.dataset.att === '${folded + 2}'`))) throw new Error("↓ от «Сохранить» не на следующем файле");
      await d.pressKey(UP);
      await d.pressKey(UP);
      if (!(await active(`a.dataset.att === '${folded}'`))) throw new Error("↑ не вернула на первый свёрнутый файл");
      // Enter on a file shows it, as a click on its chip does; the focus goes to the viewer.
      await d.pressKey(ENTER);
      await d.until("viewer from the list", async () => (await d.findAll(".reader .viewer")).length === 1);
      if (!(await active("a.classList.contains('viewer')"))) throw new Error("после Enter в списке фокус не на просмотре");
      if ((await d.findAll(".pop [data-att]")).length) throw new Error("список остался после просмотра");
      const viewerHeight = await d.exec("return document.querySelector('.reader .viewer').getBoundingClientRect().height");
      if (viewerHeight < 160) throw new Error(`просмотр сжат до ${viewerHeight} px`);
      if ((await d.findAll(".reader .files .more.current")).length !== 1) throw new Error("«+N ещё ›» не показывает, что открыт свёрнутый файл");

      // The viewer open: the list opens on the shown file, and → goes to the row's «Save», not to the next file.
      const shown = () => textOf(".reader .viewer .name");
      const name = await shown();
      await d.exec("document.querySelector('.reader .files .more').focus()");
      await d.pressKey(ENTER);
      await listOf(29);
      await d.until("cursor on the shown file", () => active(`a.dataset.att === '${folded}'`));
      // Enter on the shown file keeps it: only a click on its chip closes the viewer.
      await d.pressKey(ENTER);
      await d.until("list closed by Enter", async () => (await d.findAll(".pop [data-att]")).length === 0);
      if ((await d.findAll(".reader .viewer")).length !== 1 || (await shown()) !== name) throw new Error("Enter на показанном файле закрыл или сменил просмотр");
      if (!(await active("a.classList.contains('viewer')"))) throw new Error("после Enter на показанном файле фокус не на просмотре");
      await d.exec("document.querySelector('.reader .files .more').focus()");
      await d.pressKey(ENTER);
      await listOf(29);
      await d.until("cursor on the shown file again", () => active(`a.dataset.att === '${folded}'`));
      await d.pressKey(DOWN);
      if (!(await active(`a.dataset.att === '${folded + 1}'`))) throw new Error("↓ при открытом просмотре не на следующем файле");
      await d.pressKey(RIGHT);
      if (!(await active("a.dataset.act !== undefined"))) throw new Error("→ при открытом просмотре не на «Сохранить»: просмотр перехватил стрелку");
      if ((await shown()) !== name) throw new Error(`просмотр сменился: «${name}» → «${await shown()}»`);
      await d.pressKey(ESC);
      await d.until("list closed", async () => (await d.findAll(".pop [data-att]")).length === 0);
      if (!(await onMore())) throw new Error("после Esc из списка фокус не на «+N ещё ›»");
      if ((await d.findAll(".reader .viewer")).length !== 1) throw new Error("Esc из списка закрыл и просмотр");
      await d.pressKey(ESC);
      await d.until("viewer closed", async () => (await d.findAll(".reader .viewer")).length === 0);
      if (!(await onMore())) throw new Error("после Esc из просмотра фокус не на «+N ещё ›»");

      // «Save all» ends the list; Esc closes it and gives the focus back.
      await d.pressKey(ENTER);
      await listOf(29);
      await d.pressKey(END);
      if (!(await active("a.innerText.trim() === 'Сохранить все'"))) throw new Error("«Сохранить все» не последнее в списке");
      await d.pressKey(ESC);
      await d.until("list closed", async () => (await d.findAll(".pop [data-att]")).length === 0);
      if (!(await onMore())) throw new Error("после Esc из списка фокус не на «+N ещё ›»");
    } finally {
      await invoke("settings_set", { settings });
      await d.setRect(rect.width, rect.height);
      helper("delete", "Работа", subj);
    }
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
      // What a letter's window has no use for, it cannot call.
      const accountsBefore = await invoke("accounts");
      const settingsBefore = await invoke("settings_get");
      const extensionsBefore = (await invoke("extensions")).length;
      await refused("account_remove", { id: accountsBefore[0].id });
      await refused("settings_set", { settings: { ...settingsBefore, undo_send_secs: 0 } });
      await refused("extension_install", { path: join(root, "plugins/community/reading-time"), permissions: [], hooks: [] });
      await refused("update_install");
      if ((await invoke("accounts")).length !== accountsBefore.length) throw new Error("ящик удалён из окна письма");
      if ((await invoke("settings_get")).undo_send_secs !== settingsBefore.undo_send_secs) throw new Error("настройки изменены из окна письма");
      if ((await invoke("extensions")).length !== extensionsBefore) throw new Error("плагин поставлен из окна письма");
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

  await step("4.11.2", "«Отложить» по h в отдельном окне письма (#125): меню открывается у письма, выбор откладывает его", async () => {
    const subj = `Окно h ${stamp}`;
    helper("deliver", subj);
    await d.button("Входящие");
    await rowBySubject(subj, 30000);
    const main = await d.req("GET", d.s("/window"));
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
      await press("h", { code: "KeyH" });
      await d.until("snooze menu in the window", async () => (await textOf(".snooze .pop.main")).includes("Завтра"));
      await d.click(await d.until("snooze preset", () => d.xpath("//div[contains(@class,'snooze')]//button[contains(., 'Завтра')]")));
      await d.until("in Snoozed on server", async () => helper("count", "Отложенные", subj) === "1", 20000);
      // The undo is offered in the main window, where the list is, and the toast is short-lived: it is clicked first. It puts
      // things in order for the steps that follow. The snooze toast has no subject; the last one is this letter's.
      await d.req("POST", d.s("/window"), { handle: main });
      await d.click(await d.until("undo offered", () => d.xpath("(//div[contains(@class,'toast') and contains(., 'Отложено до')]//button[contains(., 'Отменить')])[last()]").catch(() => null)));
      await d.until("undone on server", async () => helper("count", "INBOX", subj) === "1" && helper("count", "Отложенные", subj) === "0", 20000);
    } finally {
      // A failure must not leave the letter's window for the next step: it is closed if it is still open.
      if ((await handles()).includes(other)) {
        await d.req("POST", d.s("/window"), { handle: other });
        await d.req("DELETE", d.s("/window")).catch(() => {});
      }
      await d.req("POST", d.s("/window"), { handle: main });
    }
  });

  // A drop on a reply (#79): the backend makes the window report a drop of real files, the rest is the real path.
  const drops = dropFixtures();
  /** The reply is in the form of the letter it answers: the drop zones come with an HTML one, so the reply is switched to it. */
  const toHtml = async () => {
    await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1, 20000);
    if ((await d.findAll(".compose .rich")).length === 0) {
      await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
      await d.click(await d.until("HTML", () => d.xpath("//div[contains(@class,'pop')]//*[@role='menuitemradio'][contains(., 'HTML')]")));
    }
    await d.until("rich reply", async () => (await d.findAll(".compose .rich")).length === 1, 20000);
  };
  const discardCompose = async () => {
    await d.click(await d.until("discard", () => d.find(".compose [aria-label='Удалить черновик']").catch(() => null)));
    if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
    await d.until("compose gone", async () => (await d.findAll(".compose")).length === 0, 15000);
  };
  await dropSteps({
    d,
    step,
    refused,
    fix: drops,
    openCompose: async () => {
      await d.button("Входящие");
      await openBySubject("HTML-письмо с картинками");
      await d.click(await d.until("reply", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await toHtml();
    },
    closeCompose: discardCompose,
  });

  await step("2.9", "бросок в ответ в отдельном окне письма (message-*)", async () => {
    const subj = "HTML-письмо с картинками";
    const main = await d.req("GET", d.s("/window"));
    await d.button("Входящие");
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
      await d.click(await d.until("reply", () => d.xpath("//div[contains(@class,'acts')]//button[contains(., 'Ответить')]")));
      await toHtml();
      await dropOn(d, [drops.pdf, drops.png], { zone: "attach" });
      await d.until("attachments", async () => (await d.findAll(".compose .files .file")).length === 2, 10000);
      await discardCompose();
      // Esc closes the window of a letter with nothing being written; «Готово» would archive the letter on the server.
      await press("Escape");
      await d.until("window closed", async () => (await handles()).length === 1, 20000);
    } finally {
      await d.req("POST", d.s("/window"), { handle: main });
    }
  });
  drops.clean();

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
    await d.type(await d.find(".compose textarea"), "\uE00C");
    // Esc folds the window into a bar, as in Gmail; the cross closes it.
    await d.until("compose folded by Esc", async () => (await d.findAll(".compose.min")).length === 1);
    await d.click(await d.find(".compose header > button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0);
  });

  await step("7.3.2", "клавиши работают на русской раскладке (о = j, л = k)", async () => {
    await openBySubject("Счёт за октябрь");
    const before = await textOf(".reader h1");
    await press("о", { code: "KeyJ" });
    await d.until("next message", async () => (await textOf(".reader h1")) !== before);
    await press("л", { code: "KeyK" });
    await d.until("back", async () => (await textOf(".reader h1")) === before);
  });

  await step("7.20", "клавиши: переназначение записью, конфликт, запреты, русская раскладка, подсказки", async () => {
    const row = (id) => `.prefs .kr[data-command='${id}']`;
    const openKeys = async () => {
      await press(",", { ctrlKey: true });
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(".prefs .tab[data-page='keys']"));
      await d.until("keys page", async () => (await d.findAll(row("core.archive"))).length === 1);
    };
    try {
      await openKeys();
      // Both labels of one key: e and the Russian у.
      const archive = await textOf(row("core.archive"));
      if (!archive.includes("e") || !archive.includes("у")) throw new Error(`«Готово»: ${archive}`);
      // A click on the key records the next press at once: Shift+R for «Reply all».
      await d.click(await d.find(`${row("core.reply-all")} button.combo`));
      await d.until("recording", async () => (await d.findAll(".prefs .kr.recording")).length === 1);
      await press("R", { shiftKey: true });
      await d.until("changed", async () => (await d.findAll(`${row("core.reply-all")}.changed`)).length === 1);
      if (!(await textOf(row("core.reply-all"))).includes("было a")) throw new Error("нет «было a»");
      // A key taken already: a card under the row; «у» is saved by its place as e.
      await d.click(await d.find(`${row("core.forward")} button.combo`));
      await press("у", { code: "KeyE" });
      await d.until("conflict", async () => (await textOf(".prefs .kconf")).includes("Готово"));
      await screenshot("keys-conflict");
      await d.button("Поменять местами");
      await d.until("swapped", async () => (await textOf(row("core.archive"))).includes("было e"));
      // Not allowed: a single letter in the letter window, Ctrl+C anywhere; the recording goes on.
      await d.click(await d.find(`${row("compose.bold")} button.combo`));
      await press("b");
      await d.until("letter refused", async () => (await textOf(".prefs .kconf.err")).includes("Ctrl или Alt"));
      await press("c", { ctrlKey: true });
      await d.until("copy refused", async () => (await textOf(".prefs .kconf.err")).includes("за системой"));
      await press("Escape");
      await d.until("recording cancelled", async () => (await d.findAll(".prefs .kr.recording")).length === 0);
      if ((await d.findAll(`${row("compose.bold")}.changed`)).length) throw new Error("запрещённая клавиша записалась");
      // The page saves as it changes: no shared «Save / Cancel» line at all.
      if ((await d.findAll(".prefs footer")).length) throw new Error("на странице «Клавиши» осталась общая строка Сохранить/Отмена");
      const saved = (await invoke("settings_get")).keybindings.custom;
      if (saved["core.reply-all"]?.[0] !== "Shift+r" || saved["core.forward"]?.[0] !== "e" || saved["core.archive"]?.[0] !== "f")
        throw new Error(`сохранено: ${JSON.stringify(saved)}`);
      await closeSettings();
      await d.until("settings closed", async () => (await d.findAll(".prefs")).length === 0);
      // Tooltips and the keys follow at once.
      await openBySubject("Счёт за октябрь");
      // The settings come back from the backend a moment after the save: wait for the tip.
      const tipOf = () => d.exec("return [...document.querySelectorAll('.reader button')].map((b) => b.title).find((t) => t.startsWith('Переслать')) ?? ''");
      await d.until("подсказка «Переслать (e/у)»", async () => (await tipOf()) === "Переслать (e/у)");
      await press("a");
      await new Promise((r) => setTimeout(r, 400));
      if ((await d.findAll(".compose")).length) throw new Error("старая клавиша a ещё отвечает всем");
      await press("К", { code: "KeyR", shiftKey: true });
      await d.until("reply all", async () => (await d.findAll(".compose")).length === 1);
      await d.click(await d.find(".compose header > button:last-child"));
      await composeClosed();
    } finally {
      // Back to the defaults for the steps after this one: «Reset all» and save. A recording
      // left by a failure takes the first Escape.
      if ((await d.findAll(".prefs .kr.recording")).length) await press("Escape");
      await closeSettings();
      if (Object.keys((await invoke("settings_get")).keybindings.custom).length) {
        await openKeys();
        await d.button("Сбросить все");
        await closeSettings();
        const left = (await invoke("settings_get")).keybindings.custom;
        if (Object.keys(left).length) throw new Error(`после сброса осталось: ${JSON.stringify(left)}`);
      }
    }
  });

  await step("7.20.2", "Alt+Enter из палитры приводит на строку команды; запись применяется без «Сохранить»", async () => {
    const row = (id) => `.prefs .kr[data-command='${id}']`;
    try {
      // The palette's own entry opens the page even without a highlighted command.
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), "настроить");
      await d.button("Настроить клавиши…");
      await d.until("keys page", async () => (await d.findAll(row("core.archive"))).length === 1);
      await d.until("no shared footer", async () => (await d.findAll(".prefs footer")).length === 0);
      await closeSettings();

      // Alt+Enter on the highlighted command goes to its row, lit; the command does not run.
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), "переслать");
      await d.until("highlighted", async () => (await textOf(".palette .item.active")) !== "");
      await pressIn(".palette .q", "Enter", { altKey: true });
      await d.until("row lit", async () => (await d.findAll(`${row("core.forward")}.hl`)).length === 1);
      if ((await d.findAll(".palette")).length) throw new Error("палитра не закрылась по Alt+Enter");
      await screenshot("keys-from-palette");

      // Record a key there: it takes effect with no «Save», at once.
      await d.click(await d.find(`${row("core.reply")} button.combo`));
      await press("m");
      await d.until("changed", async () => (await d.findAll(`${row("core.reply")}.changed`)).length === 1);
      const saved = (await invoke("settings_get")).keybindings.custom;
      if (saved["core.reply"]?.[0] !== "m") throw new Error(`не сохранилось сразу: ${JSON.stringify(saved)}`);
      await closeSettings();
      // The new key runs at once in the main window: m answers the open letter.
      await openFolder("Входящие");
      await openBySubject("Счёт за октябрь");
      await press("m");
      await d.until("answered by the new key", async () => (await d.findAll(".compose")).length === 1);
      await d.click(await d.find(".compose header > button:last-child"));
      await composeClosed();
    } finally {
      if ((await d.findAll(".prefs .kr.recording")).length) await press("Escape");
      await closeSettings();
      await press(",", { ctrlKey: true });
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(".prefs .tab[data-page='keys']"));
      await d.until("keys page", async () => (await d.findAll(row("core.archive"))).length === 1);
      await d.button("Сбросить все");
      await closeSettings();
      const left = (await invoke("settings_get")).keybindings.custom;
      if (Object.keys(left).length) throw new Error(`после сброса осталось: ${JSON.stringify(left)}`);
      await d.button("Входящие");
    }
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
    // The panel names the count and the size of the selection.
    await d.until("bulk panel", async () => /Выбрано 3 письма · [\d,]+ (Б|КБ|МБ)/.test(await d.bodyText()));
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

  await step("6.8", "вложенные папки сворачиваются своим треугольником, остальное на месте", async () => {
    const shown = () => d.exec("return [...document.querySelectorAll('nav.side .item .name')].map((n) => n.innerText.trim())");
    const toggles = () => d.exec("return [...document.querySelectorAll('nav.side .fold')].map((b) => b.getAttribute('aria-label'))");
    const t = await toggles();
    if (!t.some((l) => l.endsWith(": Работа"))) throw new Error(`нет треугольника у «Работы»: ${t}`);
    if (t.some((l) => l.endsWith(": Корзина") || l.endsWith(": Проекты"))) throw new Error(`треугольник у папки без подпапок: ${t}`);
    const before = await shown();
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    await d.until("branch folded", async () => !(await shown()).includes("Проекты"));
    const after = await shown();
    const lost = before.filter((n) => n !== "Проекты" && !after.includes(n));
    if (lost.length) throw new Error(`пропали другие папки: ${lost}`);
    // The folder itself still opens with a click on its name.
    await openFolder("Работа");
    await d.until("Работа open", async () => (await textOf(".list")).includes("Документы на проверку"));
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    await d.until("branch back", async () => (await shown()).includes("Проекты"));
    await d.button("Входящие");
  });

  await step("7.11", "избранные папки: звёздочка в строке, блок над деревом, свёрнутый ящик и ветка, полоса", async () => {
    const accountId = (await invoke("accounts"))[0].id;
    // Rows carry the server's name of the folder (modified UTF-7), not what it reads as.
    const nameOf = async (...path) =>
      (await invoke("folders")).find((f) => f.account_id === accountId && f.display_name === path.join(f.delimiter ?? ""))?.name;
    // A folder on the third level: Работа / Проекты / 2026.
    await invoke("folder_create", { accountId, parent: await nameOf("Работа", "Проекты"), name: "2026" });
    const tree = "nav.side .group .folder-row:not(.fav-row)";
    const starrable = () => d.exec(`return [...document.querySelectorAll(arguments[0])].filter((r) => r.querySelector('.star')).map((r) => r.dataset.folder)`, tree);
    const deep = await d.until("third level folder", async () => {
      const name = await nameOf("Работа", "Проекты", "2026");
      return name && (await starrable()).includes(name) ? name : null;
    }, 15000);
    const work = await nameOf("Работа");
    // Ten folders to star: enough of them made up top-level if the mailbox has fewer.
    for (let i = 1, n = (await starrable()).length; n < 10; i++, n++) {
      await invoke("folder_create", { accountId, parent: null, name: `Звезда ${i}` });
      await d.until(`folder ${i}`, async () => (await starrable()).length > n, 15000);
    }
    const all = await starrable();
    const ten = [deep, work, ...all.filter((n) => n !== deep && n !== work).slice(0, 8)];
    const star = (name, where = tree) => d.find(`${where}[data-folder=${JSON.stringify(name)}] .star`);
    const favs = () => d.exec("return [...document.querySelectorAll('nav.side .favs .fav-row')].map((r) => r.dataset.folder)");
    const active = () => d.exec("return document.querySelector('nav.side .item.active')?.innerText ?? ''");
    const before = await active();
    // Straight down the star column, one click per row.
    for (const name of ten) await d.click(await star(name));
    await d.until("ten favourites", async () => (await favs()).length === 10);
    // A star again on a starred folder takes it off; once more puts it back: still ten, no copy.
    await d.click(await star(ten[1]));
    await d.until("unstarred in the tree", async () => (await favs()).length === 9);
    await d.click(await star(ten[1]));
    await d.until("starred again", async () => (await favs()).length === 10);
    if (new Set(await favs()).size !== 10) throw new Error(`повтор в избранном: ${await favs()}`);
    if ((await active()) !== before) throw new Error("звёздочка открыла папку");
    const pressed = await d.exec(`return [...document.querySelectorAll(arguments[0])].filter((r) => r.querySelector('.star[aria-pressed=true]')).length`, tree);
    if (pressed !== 10) throw new Error(`в дереве отмечено ${pressed}`);
    // One column of stars and one of counters, the shared sections included.
    const columns = await d.exec(`const x = (css, side) => new Set([...document.querySelectorAll(css)].map((e) => Math.round(e.getBoundingClientRect()[side])));
      return { stars: [...x('nav.side .star', 'right')], counts: [...x('nav.side .count', 'right')] };`);
    if (columns.stars.length !== 1 || columns.counts.length !== 1) throw new Error(`столбцы съехали: ${JSON.stringify(columns)}`);
    const path = await d.exec("return document.querySelector(`nav.side .fav-row[data-folder=${JSON.stringify(arguments[0])}] .path`)?.innerText ?? ''", deep);
    if (path !== "Работа / Проекты") throw new Error(`путь вложенной: «${path}»`);
    await screenshot("favourites-tree");
    // The block's star is outline and only under the pointer or in focus; the tree's is gold at rest.
    const colorIn = (where, name) =>
      d.exec(`const s = document.querySelector(arguments[0] + '[data-folder="' + arguments[1] + '"] .star'); return s ? getComputedStyle(s).color : null`, where, name);
    const block = "nav.side .favs .fav-row";
    // Park the pointer on neutral chrome first: where the last click left it is not a promise.
    await d.moveTo(await d.find("nav.side .brand"));
    const blockIdle = await colorIn(block, ten[0]);
    if (blockIdle !== "rgba(0, 0, 0, 0)") throw new Error(`звезда блока видна в покое: «${blockIdle}»`);
    await d.moveTo(await d.find(`${block}[data-folder=${JSON.stringify(ten[0])}] .item`));
    await d.until("звезда блока проявилась", async () => (await colorIn(block, ten[0])) !== blockIdle);
    // The keyboard half of the rule: with the pointer away again, focus shows the block's star too.
    await d.moveTo(await d.find("nav.side .brand"));
    await d.until("звезда блока снова невидима", async () => (await colorIn(block, ten[0])) === blockIdle);
    await d.exec("document.querySelector(arguments[0] + ' .star').focus()", `${block}[data-folder=${JSON.stringify(ten[0])}]`);
    await d.until("звезда блока проявилась в фокусе", async () => (await colorIn(block, ten[0])) !== blockIdle);
    if ((await colorIn(tree, ten[0])) !== "rgb(224, 176, 64)") throw new Error("звезда избранной папки в дереве не золотая");
    // The row's paint belongs to the row: the star lies over the row, so crossing onto it must
    // not blink the background off (#60). Hovering the row and hovering its star read the same.
    const bgIn = (where, name) =>
      d.exec(`const r = document.querySelector(arguments[0] + '[data-folder="' + arguments[1] + '"] .item'); return r ? getComputedStyle(r).backgroundColor : null`, where, name);
    const rowsel = `${block}[data-folder=${JSON.stringify(ten[0])}]`;
    const bgUnder = async (part) => {
      await d.moveTo(await d.find(`${rowsel} ${part}`));
      return d.until(`row background under ${part}`, async () => {
        const c = await bgIn(block, ten[0]);
        return c && c !== "rgba(0, 0, 0, 0)" ? c : null;
      });
    };
    const bgRow = await bgUnder(".item");
    const bgStar = await bgUnder(".star");
    if (bgStar !== bgRow) throw new Error(`фон строки гаснет на звезде: ${bgRow} → ${bgStar}`);

    // A folded branch keeps its favourite in the block.
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    await d.until("branch folded", async () => !(await starrable()).includes(deep));
    if (!(await favs()).includes(deep)) throw new Error("вложенная избранная пропала со свёрнутой веткой");
    await d.click(await d.find("nav.side .fold[aria-label$=': Работа']"));
    // A folded mailbox: the tree goes, the favourites stay and open their folders.
    await d.click(await d.find("nav.side .account-name"));
    await d.until("tree hidden", async () => (await d.findAll(tree)).length === 0);
    if ((await favs()).length !== 10) throw new Error("избранное скрылось со свёрнутым ящиком");
    await d.click(await d.find(`nav.side .fav-row[data-folder=${JSON.stringify(work)}] .item`));
    await d.until("Работа from favourites", async () => (await textOf(".list")).includes("Документы на проверку"));
    if ((await d.findAll(tree)).length !== 0) throw new Error("ящик развернулся");
    await screenshot("favourites-collapsed");
    await d.click(await d.find("nav.side .account-name"));
    const inboxCounts = await d.exec(`return [...document.querySelectorAll('nav.side .group [data-folder="INBOX"] .count')].map((c) => c.innerText)`);
    if (inboxCounts.length === 2 && inboxCounts[0] !== inboxCounts[1]) throw new Error(`счётчики «Входящих» разные: ${inboxCounts}`);
    await openFolder("Работа");
    await d.until("Работа from the tree", async () => (await textOf(".list")).includes("Документы на проверку"));

    // In the strip the favourites come first; the whole tree under «All folders».
    const rect = await d.rect();
    try {
      await d.setRect(960, rect.height);
      await d.until("strip", async () => (await d.findAll("nav.side.strip")).length === 1);
      await d.click((await d.findAll("nav.side .circle"))[0]);
      await d.until("flyout favourites", async () => (await d.findAll(".pop .favs .fav-row")).length === 10);
      // The same in the strip's flyout: outline at rest, shown under the pointer on the row.
      const fly = ".pop .favs .fav-row";
      const flyColor = () =>
        d.exec("const s = document.querySelector(arguments[0] + ' .star'); return s ? getComputedStyle(s).color : null", fly);
      // Neutral chrome again, not wherever the circle's click left the pointer.
      await d.moveTo(await d.find("nav.side .brand"));
      const flyIdle = await flyColor();
      if (flyIdle !== "rgba(0, 0, 0, 0)") throw new Error(`звезда блока в полосе видна в покое: «${flyIdle}»`);
      await d.moveTo(await d.find(`${fly} .item`));
      await d.until("звезда блока в полосе проявилась", async () => (await flyColor()) !== flyIdle);
      await screenshot("favourites-strip");
      await d.click(await d.find(".pop .all-folders"));
      await d.until("tree in the flyout", async () => (await d.findAll(".pop .folder-row:not(.fav-row)")).length > 0);
      await press("Escape");
    } finally {
      await d.setRect(rect.width, rect.height);
      await d.until("full sidebar again", async () => (await d.findAll("nav.side.strip")).length === 0).catch(() => {});
    }

    // Unstarred in the block: the row fades in place, a second press keeps it.
    const second = (await favs())[1];
    await d.click(await star(second, "nav.side .fav-row"));
    if (!(await d.exec("return !!document.querySelector('nav.side .fav-row.leaving')"))) throw new Error("строка не затухает");
    await d.click(await star(second, "nav.side .fav-row"));
    await new Promise((r) => setTimeout(r, 1200));
    if (!(await favs()).includes(second)) throw new Error("повторное нажатие не вернуло папку");
    // From the keyboard: Space on the star, and the focus goes to the next row's star.
    const list = await favs();
    await d.type(await star(list[0], "nav.side .fav-row"), "\uE00D");
    await d.until("first one gone", async () => !(await favs()).includes(list[0]), 3000);
    const focused = await d.exec("const e = document.activeElement; return e.classList.contains('star') ? e.closest('.fav-row')?.dataset.folder : e.className");
    if (focused !== list[1]) throw new Error(`фокус ушёл на «${focused}»`);
    // The folder itself stays on the server and in the tree.
    if ((await d.findAll(`${tree}[data-folder=${JSON.stringify(list[0])}]`)).length !== 1) throw new Error("папка пропала из дерева");
    // The folder's menu says the same as the star.
    await d.exec(
      `const item = document.querySelector('${tree}[data-folder="' + arguments[0] + '"] .item'); const r = item.getBoundingClientRect();
       item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }));`,
      list[1],
    );
    await d.click(await d.until("menu item", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Убрать из избранного')]")));
    await d.until("removed by the menu", async () => !(await favs()).includes(list[1]));
    if (await d.exec(`return document.querySelector('${tree}[data-folder="' + arguments[0] + '"] .star').getAttribute('aria-pressed')`, list[1]) !== "false")
      throw new Error("звёздочка не сброшена после меню");

    // Without favourites the mailbox folds whole again, as before.
    // Unstarred in the tree, the folder's row in the block above stays and fades as well: the
    // tree does not move under the pointer, the star is empty at once, a second press keeps it.
    const top = (name) => d.exec(`return document.querySelector('${tree}[data-folder="' + arguments[0] + '"]').getBoundingClientRect().top`, name);
    const pressedIn = (name) => d.exec(`return document.querySelector('${tree}[data-folder="' + arguments[0] + '"] .star').getAttribute('aria-pressed')`, name);
    const leavingRow = (name) => d.exec(`return !!document.querySelector('nav.side .fav-row.leaving[data-folder="' + arguments[0] + '"]')`, name);
    const rest = await favs();
    const was = await top(rest[0]);
    await d.click(await star(rest[0]));
    if ((await top(rest[0])) !== was) throw new Error("дерево сдвинулось сразу после звёздочки");
    if ((await pressedIn(rest[0])) !== "false" || !(await leavingRow(rest[0]))) throw new Error("строка в блоке не затухает, или звёздочка в дереве не сброшена");
    await d.click(await star(rest[0]));
    await new Promise((r) => setTimeout(r, 1200));
    if (!(await favs()).includes(rest[0]) || (await pressedIn(rest[0])) !== "true") throw new Error("повторное нажатие в дереве не вернуло папку");
    // The rows go after their pause, and then the tree moves up: the next star waits for it.
    for (const name of rest) {
      const at = await top(name);
      await d.click(await star(name));
      if ((await top(name)) !== at) throw new Error(`дерево сдвинулось под «${name}»`);
      await d.until(`${name} out of the block`, async () => (await d.findAll(`nav.side .favs .fav-row[data-folder=${JSON.stringify(name)}]`)).length === 0);
    }
    await d.until("no favourites", async () => (await d.findAll("nav.side .fav-row")).length === 0);
    await d.click(await d.find("nav.side .account-name"));
    const left = await d.exec("return document.querySelector('nav.side .group.collapsed')?.querySelectorAll('.item').length ?? -1");
    await d.click(await d.find("nav.side .account-name"));
    if (left !== 0) throw new Error(`у свёрнутого ящика без избранного видно ${left} папок`);
    await d.button("Входящие");
  });

  await step("6.4", "крупные письма: размер в каждой строке, готовый запрос из подсказок, в:Папка/*", async () => {
    const subj = "Фото с праздника";
    // About 1,6 MB: a 1200 KB attachment in base64.
    helper("big", "Работа.Проекты", subj, "1200");
    await openFolder("Проекты");
    await rowBySubject(subj, 30000);
    const sizes = () => d.exec("return [...document.querySelectorAll('.list .row')].map((r) => r.querySelector('.size')?.innerText.trim() ?? '')");
    // Every row has its size, quiet while the list is ordered by date.
    const shown = await sizes();
    if (!shown.length || shown.some((s) => !/^[\d\s,]+ (Б|КБ|МБ|ГБ)$/.test(s))) throw new Error(`размеры в строках: ${shown}`);
    if (!shown.some((s) => /^1,\d МБ$/.test(s))) throw new Error(`нет размера крупного письма: ${shown}`);
    if ((await d.findAll(".list .row .size.strong")).length) throw new Error("размер выделен без сортировки по размеру");

    // The threshold is a setting; 1 MB here, so the ready query finds the letter.
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='storage']"));
    await setInput(".prefs [data-row='large_mb'] input", "1");
    await d.type(await d.find(".prefs [data-row='large_mb'] input"), "\uE007");
    await d.until("threshold saved", async () => (await invoke("settings_get")).large_mb === 1);
    await closeSettings();

    // A ready query from the suggestions of the empty search box.
    const box = await d.find(".list .search input");
    await d.click(box);
    const ready = await d.until("ready query", () =>
      d.xpath("//div[contains(@class,'suggest')]//button[contains(., 'Крупные (больше 1 МБ)')]").catch(() => null),
    );
    await screenshot("search-suggestions");
    await d.click(ready);
    await rowBySubject(subj, 10000);
    const query = await d.exec("return document.querySelector('.list .search input').value");
    if (query.trim() !== "больше:1М") throw new Error(`в поле: «${query}»`);
    // "больше:" puts the largest first by itself; totals of the cache above the results.
    if (!(await textOf(".list .view .trigger")).includes("Крупные сначала")) throw new Error(`сортировка: ${await textOf(".list .view .trigger")}`);
    if (!/\d+ пис\S* · [\d,\s]+ (КБ|МБ|ГБ)/.test(await textOf(".list .server")) || !(await textOf(".list .server")).includes("по кэшу")) {
      throw new Error(`итоги: ${await textOf(".list .server")}`);
    }
    if (!(await d.findAll(".list .row .size.strong")).length) throw new Error("при сортировке по размеру размер не выделен");
    await screenshot("large-mail");

    // A folder with its subfolders, and the folder alone.
    await d.clear(box);
    await d.type(box, "больше:1М в:Работа/*\uE007");
    await rowBySubject(subj, 10000);
    await d.clear(box);
    await d.type(box, "больше:1М в:Работа\uE007");
    await d.until("the folder alone", async () => {
      const value = await d.exec("return document.querySelector('.list .search input').value");
      return value.trim() === "больше:1М в:Работа" && !(await textOf(".list .viewport")).includes(subj);
    }, 10000);

    // Nothing of this step stays for the next ones: the threshold, the letter, the recent searches.
    const settings = await invoke("settings_get");
    await invoke("settings_set", { settings: { ...settings, large_mb: 25 } });
    await d.clear(box);
    await d.type(box, "\uE00C");
    await d.exec("localStorage.removeItem('depesha.search.recent')");
    helper("delete", "Работа.Проекты", subj);
    await openFolder("Проекты");
    await d.until("letter gone", async () => !(await textOf(".list .viewport")).includes(subj), 30000);
    await d.button("Входящие");
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

  await step("6.3.2", "«Непрочитанные»: прочитанное письмо остаётся в списке до смены вида", async () => {
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

  /** Picks an item of the signature menu open in the letter or in the settings. */
  async function menuItem(label) {
    const item = await d.until(`menu item ${label}`, () =>
      d.xpath(`//div[contains(@class,'pop')]//button[contains(@class,'mi') and normalize-space(.)=${JSON.stringify(label)}]`).catch(() => null),
    );
    await d.click(item);
  }

  /** Types lines into the signature open in its editor, as the editor's own commands do. */
  async function typeSignature(lines) {
    await d.exec(
      `const el = document.querySelector('.account-page .sig-rich .rich'); el.focus();
       arguments[0].forEach((line, i) => { if (i) document.execCommand('insertParagraph'); document.execCommand('insertText', false, line); });`,
      lines,
    );
  }

  await step("5.7", "две подписи в настройках ящика, подпись по умолчанию попадает в новое письмо", async () => {
    await d.click(await d.find(".menu-btn"));
    await d.button("Настройки…");
    await d.until("settings", async () => (await d.findAll(".account-page")).length === 1);
    // The first one becomes the default by itself.
    await d.button("Добавить подпись");
    await setInput(".account-page .signatures input.name", "Рабочая");
    await typeSignature(["С уважением,", "Кэрол"]);
    await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
    await d.button("Добавить подпись");
    await setInput(".account-page .signatures input.name", "Короткая");
    await typeSignature(["Кэрол, отдел ИТ"]);
    await d.click(await d.xpath("//div[contains(@class,'signatures')]//button[contains(., 'Свернуть')]"));
    const list = await textOf(".account-page .signatures");
    if (!/Рабочая\s*по умолчанию/.test(list) || !list.includes("Короткая")) throw new Error(`список подписей: ${list}`);
    // Signatures are no part of the connection: saved as they change, with no button and no login (#102, 1.7 Б).
    await d.until("signatures saved", async () => {
      const [saved] = await invoke("accounts");
      return saved.signatures?.length === 2 && saved.default_signature === saved.signatures[0].id;
    }, 20000);
    await d.until("saved mark", async () => (await textOf(".account-page footer")).includes("Сохранено"));
    if ((await d.findAll(".account-page footer .btn.primary:not([disabled])")).length) throw new Error("кнопка подключения горит, хотя подключение не менялось");
    await closeSettings();
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("закрытие страницы ящика о чём-то спросило");
    const [acc] = await invoke("accounts");
    if (acc.signatures?.length !== 2 || acc.default_signature !== acc.signatures[0].id) throw new Error(JSON.stringify(acc.signatures));
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // The field has only what is typed; the signature stands under it, apart.
    const text = await d.exec("return document.querySelector('.compose textarea').value");
    if (text.includes("Кэрол")) throw new Error(`подпись в поле ввода: ${JSON.stringify(text)}`);
    const sig = await textOf(".compose .sig-plain .sig-text");
    if (!sig.includes("-- \nС уважением,\nКэрол")) throw new Error(JSON.stringify(sig));
    // Only the signature is there: closing must neither ask nor save a draft.
    await d.click(await d.find(".compose header > button:last-child"));
    await d.until("compose closed", async () => (await d.findAll(".compose")).length === 0, 10000);
  });

  await step("5.7.2", "подпись выбирается на самом блоке подписи, «Без подписи» убирает блок", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); document.execCommand('insertText', false, 'Текст письма.');");
    // The menu sits on the block and shows when it is pointed at; a click opens it.
    await d.exec("document.querySelector('.compose .sig-plain .chip').click()");
    await menuItem("Короткая");
    await d.until("short one", async () => (await textOf(".compose .sig-plain .sig-text")).includes("Кэрол, отдел ИТ"));
    if ((await textOf(".compose .sig-plain .sig-text")).includes("С уважением")) throw new Error("в письме две подписи");
    if ((await d.exec("return document.querySelector('.compose textarea').value")) !== "Текст письма.") throw new Error("текст письма изменился");
    await d.exec("document.querySelector('.compose .sig-plain .chip').click()");
    await menuItem("Без подписи");
    await d.until("no signature", async () => (await d.findAll(".compose .sig-plain")).length === 0);
    if (!(await textOf(".compose .sig-none")).includes("Без подписи")) throw new Error("нет строки «Без подписи · добавить»");
    await d.click(await d.find(".compose .sig-none button"));
    await menuItem("Рабочая");
    await d.until("back", async () => (await textOf(".compose .sig-plain .sig-text")).includes("С уважением,"));
    // In HTML the signature is a block of the editor that the caret does not enter.
    await d.click(await d.find(".compose footer button[aria-haspopup=menu]"));
    await menuItem("HTML");
    await d.until("html signature", async () =>
      d.exec("const b = document.querySelector('.compose .rich .depesha-signature'); return !!b && b.isContentEditable === false && b.innerText.includes('Кэрол');"));
    await d.exec("const bar = document.querySelector('.compose .block-bar .chip'); bar.click();");
    await menuItem("Короткая");
    await d.until("html swapped", async () => (await textOf(".compose .rich .depesha-signature")).includes("отдел ИТ"));
    if ((await d.findAll(".compose .rich .depesha-signature")).length !== 1) throw new Error("в письме две подписи");
    if (!(await textOf(".compose .rich")).includes("Текст письма.")) throw new Error("текст письма потерялся");
    // A long letter scrolled so that the signature's top is under the fields: its tint stays in
    // the letter's area and its menu goes to the bottom of the part in sight, still there to click.
    await d.exec(`
      const el = document.querySelector('.compose .rich');
      // Lines above the signature and below it, as a quote of an answer would be.
      el.insertAdjacentHTML('afterbegin', '<div>Строка.</div>'.repeat(40));
      el.insertAdjacentHTML('beforeend', '<div>Строка.</div>'.repeat(40));
      el.dispatchEvent(new Event('input'));`);
    await d.until("letter scrolled", async () =>
      d.exec(`
        const el = document.querySelector('.compose .rich');
        const sig = el.querySelector('.depesha-signature');
        const lift = sig.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + 6;
        if (Math.abs(lift) > 1) {
          el.scrollTop += lift;
          return false;
        }
        sig.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        return true;`));
    const geometry = await d.until("signature tint", async () =>
      d.exec(`
        const el = document.querySelector('.compose .rich');
        const hover = document.querySelector('.compose .block-hover');
        if (!hover) return null;
        const e = el.getBoundingClientRect();
        const view = { left: e.left + el.clientLeft, top: e.top + el.clientTop, right: e.left + el.clientLeft + el.clientWidth, bottom: e.top + el.clientTop + el.clientHeight };
        // What of the tint is painted: its box with its frame, cut by every box that clips it.
        const h = hover.getBoundingClientRect();
        let seen = { left: h.left - 4, top: h.top - 4, right: h.right + 4, bottom: h.bottom + 4 };
        for (let p = hover.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflow === 'visible') continue;
          const c = p.getBoundingClientRect();
          seen = { left: Math.max(seen.left, c.left), top: Math.max(seen.top, c.top), right: Math.min(seen.right, c.right), bottom: Math.min(seen.bottom, c.bottom) };
        }
        const sig = el.querySelector('.depesha-signature').getBoundingClientRect();
        const bar = document.querySelector('.compose .block-bar').getBoundingClientRect();
        return { view, seen, bar, sigTop: sig.top, sigBottom: Math.min(sig.bottom, view.bottom) };`));
    const within = (b, v) => b.left >= v.left - 0.5 && b.top >= v.top - 0.5 && b.right <= v.right + 0.5 && b.bottom <= v.bottom + 0.5;
    if (!(geometry.sigTop < geometry.view.top)) throw new Error(`верх подписи не ушёл под шапку: ${JSON.stringify(geometry)}`);
    if (!within(geometry.seen, geometry.view)) throw new Error(`подсветка подписи выходит за область письма: ${JSON.stringify(geometry)}`);
    if (!within(geometry.bar, geometry.view)) throw new Error(`бейдж подписи выходит за область письма: ${JSON.stringify(geometry)}`);
    if (geometry.bar.bottom < geometry.sigBottom - 0.5) throw new Error(`бейдж не у нижнего края подписи: ${JSON.stringify(geometry)}`);
    await screenshot("5.7-signature-scrolled");
    // The letter was typed in: it goes away without a draft.
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });

  await step("5.7.3", "в Markdown-письме подпись показана оформлением, а не текстом под «-- »", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); document.execCommand('insertText', false, 'Текст письма.');");
    // The format button of the footer switches this very letter to Markdown.
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await menuItem("Markdown");
    // The signature stands as a block with its formatting and pictures (#67), not as the
    // text under "-- " a plain letter carries.
    await d.until("markdown signature", async () =>
      d.exec("const b = document.querySelector('.compose .sig-html'); return !!b && b.innerText.includes('Кэрол');"));
    if ((await d.findAll(".compose .sig-plain .sig-text")).length) throw new Error("в Markdown-письме подпись показана текстом");
    await screenshot("5.7-signature-markdown");
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });

  await step("2.9.2", "зоны броска в Markdown-письме с подписью видны, когда текст прокручен", async () => {
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // Long enough to scroll, typed while the letter is plain, then switched to Markdown.
    await d.exec("const t = document.querySelector('.compose textarea'); t.focus(); document.execCommand('insertText', false, 'x\\n'.repeat(80));");
    await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
    await menuItem("Markdown");
    await d.until("markdown signature", async () => (await d.findAll(".compose .sig-html")).length === 1);
    await zonesStayInView(d, drops);
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });
}
