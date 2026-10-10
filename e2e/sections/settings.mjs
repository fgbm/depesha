// Section "settings" of the run (see e2e/shard.mjs for the split into parts).
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root, profile, d, helper, screenshot, step, injectFailure, openBySubject, textOf, setInput, setSelect, invoke, pickFolder, press, pressIn, pictureFrameInSight, composeClosed, closeSettings, focusInfo, openMailboxPage, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
  section("settings");
  await step("7.7", "палитра команд (Ctrl+K) и шаблоны ответов", async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "настройки");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await screenshot("settings-reading");
    await d.click(await d.find(".prefs .tab[data-page='writing']"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    await screenshot("settings-writing");
    // The templates are a group of the plugin on the page they belong to, marked «плагин» (#102, 2.4).
    await d.button("Добавить шаблон");
    await setInput(".prefs .tpl input", "Получил");
    await setInput(".prefs .tpl textarea", "Спасибо, получил.");
    // The plugin saves what was typed as the window closes.
    await closeSettings();
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    await d.button("Шаблоны");
    await d.click(await d.until("template", () => d.xpath("//div[contains(@class,'pop')]//button[contains(., 'Получил')]")));
    const text = await d.exec("return document.querySelector('.compose textarea').value");
    if (!text.includes("Спасибо, получил.")) throw new Error(JSON.stringify(text));
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    await press("k", { ctrlKey: true });
    await d.type(await d.find(".palette .q"), "перейти отлож");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("snoozed view", async () => (await textOf(".list h2")).trim() === "Отложенные");
    await d.button("Входящие");
  });

  await step("7.9", "все настройки в одном окне: Ctrl+, ящики и плагины разделами", async () => {
    if (await d.exec("return !!document.querySelector('nav.side .foot-btn[aria-label=\"Плагины\"]')")) throw new Error("в сайдбаре остался отдельный вход в плагины");
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    const tabs = await textOf(".prefs .pages");
    for (const want of ["Чтение и список", "Написание", "Ящики", "Все плагины"]) {
      if (!tabs.includes(want)) throw new Error(`нет раздела «${want}»: ${tabs}`);
    }
    // One entry for the mailboxes; they stand on its page, not in the menu (#102, 2.6 Б).
    if ((await d.findAll(".prefs .tab[data-page^='account:']")).length) throw new Error("ящики снова пунктами меню");
    await d.click(await d.find(".prefs .tab[data-page='accounts']"));
    await d.until("manager", async () => (await d.findAll(".prefs .accounts")).length === 1);
    if (!(await textOf(".prefs .accounts")).includes("carol@local.test")) throw new Error("на странице «Ящики» нет ящика");
    await d.click((await d.findAll(".prefs .accounts .acc > .btn.icon"))[0]);
    await d.until("mailbox page", async () => (await d.findAll(".prefs .account-page")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='plugins']"));
    await d.until("plugins page", async () => (await d.findAll(".prefs .plugins")).length === 1);
    await screenshot("settings-plugins");
    await closeSettings();
  });

  await step("7.21", "окно настроек: поиск находит настройку и открывает страницу на поле", async () => {
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    // The settings window (#68) is wider than the letter since 0.7.1: up to 1280 px, but the
    // test window (1280 px wide) is narrower than that plus the gaps, so it fills the width.
    const box = await d.exec(
      "const r = document.querySelector('.prefs').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), inner: window.innerWidth, sym: Math.abs(r.left - (window.innerWidth - r.right)) < 1 };",
    );
    const want = Math.min(1280, box.inner - 64);
    if (box.w !== want) throw new Error(`ширина окна настроек: ${box.w}, а не ${want}`);
    if (box.top !== 32) throw new Error(`отступ сверху: ${box.top}, а не 32`);
    if (box.h !== (await d.exec("return window.innerHeight")) - 64) throw new Error(`высота окна настроек: ${box.h}`);
    if (!box.sym) throw new Error("окно настроек не по центру по ширине");
    // The search over the settings sits above the menu of pages (#68).
    if (!(await d.findAll(".prefs .psearch .q")).length) throw new Error("нет поля «Найти настройку»");
    await d.clear(await d.find(".prefs .psearch .q"));
    await d.type(await d.find(".prefs .psearch .q"), "markdown");
    injectFailure("7.21");
    await d.until("results", async () => (await d.findAll(".prefs .rlist .hit")).length > 0);
    const found = await textOf(".prefs .content.results");
    if (!found.includes("Формат новых писем")) throw new Error(`по «markdown» не нашёлся «Формат новых писем»: ${found}`);
    // A click opens the page and scrolls to the field (#68, frame 4А).
    await d.click(await d.xpath("//div[contains(@class,'prefs')]//button[contains(@class,'hit')][.//span[contains(@class,'lbl') and contains(., 'Формат новых писем')]]"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    // The row is in view and has the focus: found, so the value can be changed from the keyboard (#102, 4.4 А).
    await d
      .until("field in view", async () =>
        await d.exec("const el = document.querySelector('.prefs [data-settings=\"compose_format\"]'); if (!el || document.activeElement !== el) return false; const r = el.getBoundingClientRect(); const c = document.querySelector('.prefs .content').getBoundingClientRect(); return r.top >= c.top - 4 && r.top < c.bottom;"),
      )
      .catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await focusInfo())}`);
      });
    await screenshot("settings-search");
    await closeSettings();
  }, { retry: true });

  await step("7.23", "настройки: всё сохраняется сразу, «Отменить» и Ctrl+Z, неверное значение не сохраняется, тема в обеих темах", async () => {
    const saved = () => invoke("settings_get");
    const theme = () => d.exec("return document.documentElement.dataset.theme ?? ''");
    const row = (id) => `.prefs [data-row='${id}']`;
    const tile = (name) =>
      d.xpath(`//div[contains(@class,'prefs')]//div[@data-row='theme']//button[@role='radio'][normalize-space(.)='${name}']`);
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='reading']"));
    await d.until("reading page", async () => (await textOf(".prefs .pane h2")) === "Чтение и список");
    // Nothing waits to be saved: no «Save» and no «Cancel» anywhere in the window.
    if ((await d.findAll(".prefs footer .btn")).length) throw new Error("в окне настроек остались кнопки «Сохранить» и «Отмена»");

    // A switch is saved the moment it is clicked; its row says so, a toast offers to take it back.
    const was = (await saved()).threads;
    await d.click(await d.find(`${row("threads")} .sw`));
    await d.until("threads saved", async () => (await saved()).threads === !was);
    await d.until("saved mark", async () => (await textOf(row("threads"))).includes("✓ Сохранено"));
    await d.until("undo toast", async () => (await textOf(".toasts")).includes("Отменить"));
    // The click left the focus on the switch; the arrows still walk the rows from there (#102, 4.1).
    await d.type(await d.find(`${row("threads")} .sw`), "\uE015");
    await d.until("arrow after a click", async () => (await d.exec("return document.activeElement?.dataset?.row")) === "list_avatars");
    // Ctrl+Z takes the last change back.
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("threads back", async () => (await saved()).threads === was);

    // The keyboard: the menu → the page, the arrows change a value, Ctrl+Z takes it back.
    await d.click(await d.find(".prefs .tab[data-page='writing']"));
    await d.until("writing page", async () => (await textOf(".prefs .pane h2")) === "Написание");
    await d.exec("document.querySelector(\".prefs .tab[data-page='writing']\").focus()");
    await pressIn(".prefs .tab[data-page='writing']", "ArrowRight");
    await d
      .until("first row has the focus", async () => (await d.exec("return document.activeElement?.dataset?.row")) === "compose_format")
      .catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await focusInfo())}`);
      });
    const format = (await saved()).compose_format;
    await pressIn(row("compose_format"), format === "markdown" ? "ArrowLeft" : "ArrowRight");
    await d.until("format stepped", async () => (await saved()).compose_format !== format);
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("format back", async () => (await saved()).compose_format === format);

    // A number out of its limits is lit and not saved; Esc puts the saved one back and keeps the window.
    const px = `${row("image_max_px")} input`;
    const width = (await saved()).image_max_px;
    await setInput(px, "99999");
    await d.type(await d.find(px), "\uE007");
    await d.until("field lit", async () => (await d.findAll(`${px}.bad`)).length === 1);
    if ((await saved()).image_max_px !== width) throw new Error("неверное число сохранилось");
    await d.type(await d.find(px), "\uE00C");
    await d.until("saved value back", async () => (await d.exec(`return document.querySelector("${px}").value`)) === String(width));
    if (!(await d.findAll(".prefs")).length) throw new Error("Esc в поле закрыл окно");
    // A right one is saved on Enter.
    await setInput(px, "1200");
    await d.type(await d.find(px), "\uE007");
    await d.until("number saved", async () => (await saved()).image_max_px === 1200);
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("number back", async () => (await saved()).image_max_px === width);

    // Tab goes on inside an open row: the second threshold is reached from the keyboard (#102, 4.1).
    await d.click(await d.find(".prefs .tab[data-page='storage']"));
    await d.until("storage page", async () => (await textOf(".prefs .pane h2")) === "Хранение");
    const levels = (await saved()).quota_levels;
    const second = levels[1] === 98 ? 97 : 98;
    await pressIn(row("quota_levels"), "Enter");
    await d.until("first threshold open", async () => (await d.exec("return document.activeElement?.tagName")) === "INPUT");
    await d.type(await d.find(`${row("quota_levels")} input`), "\uE004");
    await d.until("second threshold has the focus", async () => (await d.exec("return document.activeElement === document.querySelectorAll(\"[data-row='quota_levels'] input\")[1]")) === true);
    const secondField = (await d.findAll(`${row("quota_levels")} input`))[1];
    await d.clear(secondField);
    await d.type(secondField, `${second}\uE007`);
    await d.until("second threshold saved", async () => (await saved()).quota_levels[1] === second);
    await pressIn(".modal.prefs", "z", { ctrlKey: true });
    await d.until("second threshold back", async () => (await saved()).quota_levels[1] === levels[1]);

    // The theme applies the moment its tile is clicked, and the page is photographed in both.
    await d.click(await d.find(".prefs .tab[data-page='look']"));
    await d.until("look page", async () => (await textOf(".prefs .pane h2")) === "Вид и язык");
    const was_theme = (await saved()).theme;
    await d.click(await tile("Бумага"));
    await d.until("light theme", async () => (await theme()) === "paper");
    await screenshot("settings-look-paper");
    await d.click(await tile("Ночь"));
    await d.until("dark theme", async () => (await theme()) === "night");
    await screenshot("settings-look-night");
    const back = { system: "Как в системе", paper: "Бумага", night: "Ночь", snow: "Снег", graphite: "Графит" }[was_theme];
    await d.click(await tile(back));
    await d.until("theme as it was", async () => (await saved()).theme === was_theme);

    // Closing asks nothing.
    await closeSettings();
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("закрытие окна настроек о чём-то спросило");
  });

  await step("7.24", "страница ящика: формат сохраняется сразу, без кнопки; кнопка «Проверить и сохранить» — только для подключения", async () => {
    const me = (await invoke("accounts"))[0];
    await openMailboxPage(me.id);
    await d.click(await d.find(".account-page .toc a[data-toc='letters']"));
    const was = me.compose_format ?? "";
    const pick = was === "markdown" ? "html" : "markdown";
    // The format does not reach the server: it is saved as it is picked, with the row's «Saved» and the toast.
    await setSelect(".account-page .compose-format", pick);
    await d.until("format saved", async () => ((await invoke("accounts"))[0].compose_format ?? "") === pick, 20000);
    await d.until("saved mark", async () => (await textOf(".account-page footer")).includes("Сохранено"));
    await d.until("undo toast", async () => (await textOf(".toasts")).includes("Отменить"));
    await screenshot("settings-account-autosave", { toasts: true });
    // The button waits for the connection: it is dim until a server, a port or a login changes.
    if ((await d.findAll(".account-page footer .btn.primary:not([disabled])")).length) throw new Error("кнопка подключения горит без изменений подключения");
    // The key is pressed on the control the pick left the focus on, not on the window.
    await pressIn(".account-page .compose-format .trigger", "z", { ctrlKey: true });
    await d.until("format back", async () => ((await invoke("accounts"))[0].compose_format ?? "") === was, 20000);
    // Closing asks nothing: nothing of the connection is waiting.
    await closeSettings();
    if ((await d.findAll(".dialog, .confirm")).length) throw new Error("закрытие страницы ящика о чём-то спросило");
  });

  await step("7.26", "страница ящика: название, набранное во время проверки подключения, сохраняется; уход с несохранённым подключением спрашивает", async () => {
    const me = (await invoke("accounts"))[0];
    await openMailboxPage(me.id);
    await d.click(await d.find(".account-page button.head"));
    // A server nobody answers at: the check takes a while or fails at once, the end is the same.
    const imapHost = ".account-page #account-connection fieldset:nth-of-type(1) .host input";
    await setInput(imapHost, "192.0.2.1");
    await d.until("button lit", async () => (await d.findAll(".account-page footer .btn.primary:not([disabled])")).length === 1);
    await d.click(await d.find(".account-page footer .btn.primary"));
    const name = ".account-page .grid input";
    await setInput(name, "Проверка 7.26");
    await d.type(await d.find(name), "\uE007");
    // The name waits for the check: while it is under way (the button says «Проверяем…») nothing is written.
    const checking = async () => (await textOf(".account-page footer .btn.primary")).includes("Проверяем");
    // The check takes 3 s in the test build (DEPESHA_E2E_CHECK_DELAY_MS): it must still be under way here, or the step proves nothing.
    if (!(await checking())) throw new Error("проверка подключения уже закончилась: шаг ничего не доказывает");
    const written = (await invoke("accounts"))[0].label ?? "";
    if (written === "Проверка 7.26") throw new Error("название записано во время проверки");
    if (!(await checking())) throw new Error("проверка закончилась до чтения записанного названия");
    // The check ends with its error: the connection is not saved, the name is.
    await d.until("name saved", async () => (await invoke("accounts"))[0].label === "Проверка 7.26", 90000);
    await d.until("check failed", async () => (await d.findAll(".account-page .outcome")).length === 1, 90000);
    if ((await invoke("accounts"))[0].imap.host !== me.imap.host) throw new Error("подключение сохранилось без проверки");
    // The connection is still changed and not saved: leaving asks, and «Вернуться» stays.
    await d.click(await d.find(".prefs .tab[data-page='plugins']"));
    await d.until("question", async () => (await d.findAll(".modal.confirm")).length === 1);
    await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[normalize-space(.)='Вернуться']"));
    await d.until("question gone", async () => (await d.findAll(".modal.confirm")).length === 0);
    if (!(await d.findAll(".prefs .account-page")).length) throw new Error("страница ящика закрылась после «Вернуться»");
    // Back as it was, for the steps after this one.
    await d.click(await d.xpath("//div[contains(@class,'account-page')]//footer//button[normalize-space(.)='Отмена']"));
    // Enter saves the text, as it does for the user: the focus stays in the field.
    if (me.label) await setInput(name, me.label);
    else await d.exec("const i = document.querySelector('.account-page .grid input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));");
    await d.type(await d.find(name), "\uE007");
    await d.until("name back", async () => ((await invoke("accounts"))[0].label ?? "") === (me.label ?? ""), 20000);
    await closeSettings();
  });

  await step("7.27", "страница ящика: текст, набранный без ухода фокуса, не теряется при скрытии окна (#120)", async () => {
    const me = (await invoke("accounts"))[0];
    await openMailboxPage(me.id);
    const name = ".account-page .grid input";
    const typed = "Скрытие 7.27";
    // The text is typed and the focus stays in the field: neither Enter nor a click elsewhere.
    await setInput(name, typed);
    const rect = await d.rect();
    await invoke("window_hide");
    await d.until("typed text saved on hide", async () => (await invoke("accounts"))[0].label === typed, 20000);
    // The window is shown again by the driver (the page has no `show`; a focus alone does not show it): the steps after this one need it on screen, at its size.
    await d.req("POST", d.s("/window/maximize"), {});
    await d.setRect(rect.width, rect.height);
    await d.until("window back", async () => (await d.exec("return document.visibilityState")) === "visible");
    // Back as it was, for the steps after this one.
    if (me.label) await setInput(name, me.label);
    else await d.exec("const i = document.querySelector('.account-page .grid input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));");
    await d.type(await d.find(name), "\uE007");
    await d.until("name back", async () => ((await invoke("accounts"))[0].label ?? "") === (me.label ?? ""), 20000);
    await closeSettings();
  });

  await step("7.29", "картинка в тексте выделена и прокручена за край: рамка и плашка не выходят из поля текста, в обычном и «Во весь экран»; Delete и Backspace не стирают невидимую картинку", async () => {
    await d.button("Написать");
    try {
      await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
      // The mailbox's own format decides what opens: the letter is switched to HTML by the footer's menu.
      if ((await d.findAll(".compose .rich")).length === 0) {
        await d.click(await d.find(".compose footer button[aria-label='Формат письма']"));
        await d.click(await d.until("HTML", () => d.xpath("//div[contains(@class,'pop')]//*[@role='menuitemradio'][contains(., 'HTML')]")));
      }
      await d.until("rich", async () => (await d.findAll(".compose .rich")).length === 1);
      await pictureFrameInSight("normal");
      await d.click(await d.find(".compose [aria-label='Во весь экран']"));
      await d.until("maximized", async () => (await d.findAll(".compose [aria-label='Обычный размер']")).length === 1);
      await pictureFrameInSight("max");
    } finally {
      if ((await d.findAll(".compose")).length) {
        await d.click(await d.find(".compose header > button:last-child"));
        if ((await d.findAll(".confirm")).length) await d.click(await d.xpath("//div[contains(@class,'confirm')]//button[contains(@class,'primary')]"));
        await composeClosed();
      }
    }
  });

  await step("7.25", "фон без значка: согласие даётся действием строки, а не выбором", async () => {
    const before = await invoke("settings_get");
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='start']"));
    await d.until("start page", async () => (await textOf(".prefs .pane h2")) === "Запуск и обновления");
    const tray = await d.until("tray known", async () => {
      const t = (await invoke("background_status")).tray;
      return t === "checking" ? null : t;
    }, 15000);
    await setSelect(".prefs [data-row='close_action']", "background");
    await d.until("background chosen", async () => (await invoke("settings_get")).close_action === "background");
    // Choosing the background agrees to nothing.
    if ((await invoke("settings_get")).background_without_tray !== before.background_without_tray) throw new Error("выбор «в фоне» молча дал согласие");
    if (tray === "absent") {
      await d.until("consent row", async () => (await d.findAll(".prefs [data-row='tray_consent']")).length === 1);
      await screenshot("settings-tray-consent");
      await pressIn(".prefs [data-row='tray_consent']", "Enter");
      await d.until("consent saved", async () => (await invoke("settings_get")).background_without_tray === true);
      await d.until("consent row gone", async () => (await d.findAll(".prefs [data-row='tray_consent']")).length === 0);
    } else if ((await d.findAll(".prefs [data-row='tray_consent']")).length) {
      throw new Error("строка согласия при значке в трее");
    }
    // As it was, for the steps after this one.
    await invoke("settings_patch", { patch: { close_action: before.close_action, background_without_tray: before.background_without_tray } });
    await closeSettings();
  });

  await step("11.1", "«Сервер»: возможности по данным входа, группы, технические подробности, «Проверить снова»", async () => {
    await openMailboxPage((await invoke("accounts"))[0].id);
    await d.click(await d.find(".account-page .toc a[data-toc='server']"));
    // What the login found is in the cache: the table shows without asking the server.
    await d.until("features", async () => (await d.findAll(".account-page tr[data-feature='idle']")).length === 1, 15000);
    const idle = await textOf(".account-page tr[data-feature='idle']");
    if (!idle.includes("IDLE") || !idle.includes("используется")) throw new Error(`IDLE: ${idle}`);
    const head = await textOf(".account-page section[data-section='server']");
    if (!head.includes("127.0.0.1:3143") || !head.includes("Определено")) throw new Error(`шапка раздела: ${head.slice(0, 300)}`);
    // GreenMail has IDLE and MOVE: nothing to look at in the contents.
    if ((await d.findAll(".account-page .toc a[data-toc='server'] .look")).length) throw new Error("точка у «Сервер» при IDLE и MOVE");
    await d.click(await d.find(".account-page details.tech summary"));
    const tech = await textOf(".account-page details.tech");
    if (!tech.includes("* CAPABILITY IMAP4rev1")) throw new Error(`технические подробности: ${tech.slice(0, 300)}`);
    if (/secret|carol:secret/i.test(tech)) throw new Error("в подробностях пароль");
    const before = (await invoke("server_info", { accountId: (await invoke("accounts"))[0].id })).caps.detected;
    await new Promise((r) => setTimeout(r, 1100));
    await d.click(await d.find(".account-page [data-action='server-check']"));
    await d.until(
      "checked again",
      async () => (await invoke("server_info", { accountId: (await invoke("accounts"))[0].id })).caps.detected > before,
      20000,
    );
    await screenshot("account-server");
    await closeSettings();
  });

  await step("11.2", "«Хранилище»: квота или «не сообщает», локальный кэш отдельно, размер папок фоном, строка в сайдбаре", async () => {
    const id = (await invoke("accounts"))[0].id;
    await openMailboxPage(id);
    await d.click(await d.find(".account-page .toc a[data-toc='storage']"));
    const storage = await textOf(".account-page section[data-section='storage']");
    if (!/Занято|Сервер не сообщает квоту/.test(storage)) throw new Error(`ни квоты, ни «не сообщает»: ${storage.slice(0, 300)}`);
    if (!storage.includes("Кэш Депеши") || !storage.includes("не входит в квоту")) throw new Error("локальный кэш не подписан как локальный");
    // Counting is a background task with its progress in the tasks window; the result stays in the cache.
    await d.click(await d.find(".account-page [data-action='sizes-count']"));
    await d.until("counted", async () => !!(await invoke("server_info", { accountId: id })).sizes, 60000);
    await d.until("table", async () => (await d.findAll(".account-page table.sizes tr")).length > 1, 10000);
    const sizes = await textOf(".account-page table.sizes");
    if (!sizes.includes("Входящие") && !sizes.includes("INBOX")) throw new Error(`нет «Входящих» в размерах: ${sizes}`);
    if (!sizes.includes("Итого")) throw new Error("нет итога");
    // An own limit makes the folder sizes an estimate to compare with: the sidebar shows it.
    await setInput(".account-page input.own", "0,001");
    // A text is saved when its field is left or Enter is pressed (#102, 1.7 Б).
    await d.type(await d.find(".account-page input.own"), "\uE007");
    await d.until("limit saved", async () => (await invoke("accounts"))[0].quota_limit_mb === 1, 20000);
    await closeSettings();
    await d.until("quota line", async () => (await d.findAll(`nav.side .quota[data-account='${id}']`)).length === 1, 10000);
    const line = await textOf(`nav.side .quota[data-account='${id}']`);
    if (!line.includes("1 МБ")) throw new Error(`строка квоты: ${line}`);
    await screenshot("sidebar-quota");
    // A click opens the mailbox's «Storage».
    await d.click(await d.find(`nav.side .quota[data-account='${id}']`));
    await d.until("storage opened", async () => (await d.findAll(".prefs .account-page section[data-section='storage']")).length === 1);
    await setInput(".account-page input.own", "\uE003\uE003\uE003\uE003\uE003");
    await d.exec("const i = document.querySelector('.account-page input.own'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur();");
    await d.until("limit cleared", async () => !(await invoke("accounts"))[0].quota_limit_mb, 20000);
    await closeSettings();
    // Messages from the toasts this left (a full mailbox) go before the next steps.
    for (const t of await d.findAll(".toast .close")) await d.click(t).catch(() => {});
  });

  await step("7.8", "язык: английский включается в настройках сразу, без перезапуска", async () => {
    const setLanguage = async (search, value) => {
      await press("k", { ctrlKey: true });
      await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
      await d.type(await d.find(".palette .q"), search);
      await d.type(await d.find(".palette .q"), "\uE007");
      await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
      await d.click(await d.find(".prefs .tab[data-page='look']"));
      // The language is a few short options, so segments (#102, 1.1 А); saved the moment one is clicked.
      await d.click(await d.xpath(`//div[contains(@class,'prefs')]//div[@data-row='language']//button[@role='radio'][normalize-space(.)='${value === "en" ? "English" : "Русский"}']`));
      await d.until("language saved", async () => (await invoke("settings_get")).language === value);
      await closeSettings();
    };
    await d.button("Входящие");
    await setLanguage("настройк", "en");
    await d.until("English sidebar", async () => (await sidebarText()).includes("Inbox"), 10000);
    if (!(await textOf(".list h2")).includes("Inbox")) throw new Error(`заголовок: ${await textOf(".list h2")}`);
    if (!(await textOf(".list .search input") || (await d.exec("return document.querySelector('.list .search input').placeholder"))).includes("Search")) {
      throw new Error("поле поиска не переведено");
    }
    await screenshot("english");
    await setLanguage("settings", "ru");
    await d.until("Russian again", async () => (await sidebarText()).includes("Входящие"), 10000);
  });

  const openModules = async () => {
    await press("k", { ctrlKey: true });
    await d.until("palette", async () => (await d.findAll(".palette")).length === 1);
    await d.type(await d.find(".palette .q"), "плагины");
    await d.type(await d.find(".palette .q"), "\uE007");
    await d.until("plugins", async () => (await d.findAll(".prefs .plugins")).length === 1);
  };
  const closeModules = closeSettings;
  // Straight to the backend, agreeing to exactly what the manifest asks for.
  const install = (name, dir = "plugins/community") => {
    const path = join(root, dir, name);
    const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    return invoke("extension_install", { path, permissions: m.permissions ?? [], hooks: m.hooks ?? [] });
  };
  const extensionsDir = join(profile, "data", "ru.depesha.mail", "extensions");
  const installFromUi = async (name) => {
    await pickFolder(join(root, "e2e/fixtures/extensions", name));
    await d.click(await d.find(".prefs .plugins .head .btn"));
  };
  const consentDialog = () => d.until("consent dialog", async () => (await d.findAll(".consent[data-consent='test.consent']")).length === 1);
  const answerConsent = async (ok) => {
    await d.click(await d.find(`.consent .buttons .btn${ok ? ".primary" : ":not(.primary)"}`));
    await d.until("consent closed", async () => (await d.findAll(".consent")).length === 0);
  };

  await step("10.1", "плагины: выключенный плагин уносит свои кнопки, клавиши и разделы", async () => {
    await d.button("Входящие");
    await openModules();
    await screenshot("plugins");
    await d.click(await d.find(".prefs .plugins input[data-plugin=snooze]"));
    await closeModules();
    await openBySubject("Счёт за октябрь");
    await d.until("no snooze button", async () => !(await textOf(".reader .toolbar")).includes("Отложить"));
    await press("h");
    await new Promise((r) => setTimeout(r, 300));
    if ((await d.findAll(".reader .pop")).length) throw new Error("клавиша h работает при выключенном плагине");
    await openModules();
    await d.click(await d.find(".prefs .plugins input[data-plugin=snooze]"));
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
    await d.until("timeout recorded", async () => /таймаутов: [1-9]/.test(await textOf(".prefs .plugins [data-ext='test.hang']")), 10000);
    await closeModules();
    for (const id of ["test.hang", "test.probe", "examples.mail-rules", "examples.reading-time", "examples.external-sender"]) {
      await invoke("extension_remove", { id });
    }
  });

  await step("10.6", "согласие: до установки видны автор, версия и права словами; отказ ничего не ставит", async () => {
    await openModules();
    await installFromUi("consent-v1");
    await consentDialog();
    const text = await textOf(".consent");
    for (const want of ["Consent check", "1.0.0", "Depesha tests", "Читать почту", "каждом открытом письме"]) {
      if (!text.includes(want)) throw new Error(`в окне согласия нет «${want}»: ${text}`);
    }
    if ((await d.findAll(".consent .leak")).length) throw new Error("предупреждение о выгрузке без права на сеть");
    await screenshot("extension-consent");
    await answerConsent(false);
    if ((await d.findAll(".prefs .plugins [data-ext='test.consent']")).length) throw new Error("плагин в списке после отказа");
    if (existsSync(join(extensionsDir, "test.consent"))) throw new Error("плагин на диске после отказа");
    await installFromUi("consent-v1");
    await consentDialog();
    await answerConsent(true);
    await d.until("installed and on", async () => d.exec("return document.querySelector(\".prefs .plugins [data-ext='test.consent'] input[type=checkbox]\")?.checked === true"));
  });

  await step("10.7", "согласие: обновление с новым правом спрашивает снова и выделяет новое", async () => {
    await installFromUi("consent-v2");
    await consentDialog();
    const added = await textOf(".consent li.added");
    if (!added.includes("api.example.com")) throw new Error(`новое право не выделено: ${added}`);
    if (!(await textOf(".consent .leak")).includes("api.example.com")) throw new Error("нет предупреждения о выгрузке писем");
    await screenshot("extension-consent-update");
    await answerConsent(false);
    if (!(await textOf(".prefs .plugins [data-ext='test.consent']")).includes("1.0.0")) throw new Error("после отказа сменилась версия");
    // The backend holds to consent too: a set other than the manifest's is refused.
    const refused = await invoke("extension_install", {
      path: join(root, "e2e/fixtures/extensions/consent-v2"),
      permissions: ["messages.read"],
      hooks: ["messageOpen"],
    }).then(() => null, (e) => e.message);
    if (!refused) throw new Error("установка в обход согласия прошла");
    // The same rights again: no dialog, only a note.
    await installFromUi("consent-v1");
    await d.until("updated without asking", async () => (await textOf(".toasts")).includes("Обновлено"), 10000);
    if ((await d.findAll(".consent")).length) throw new Error("согласие спрошено без новых прав");
  });

  await step("10.8", "плагин с локальным адресом в network: не запускается, причина видна", async () => {
    cpSync(join(root, "e2e/fixtures/extensions/local"), join(extensionsDir, "test.local"), { recursive: true });
    // Removing one plugin reloads the list.
    await invoke("extension_remove", { id: "test.consent" });
    const row = await d.until("refused plugin shown", async () => {
      const t = await textOf(".prefs .plugins [data-ext='test.local'] [data-problem]");
      return t.includes("127.0.0.1") ? t : null;
    }, 10000);
    console.log(`    ${row}`);
    if (await d.exec("return document.querySelector(\".prefs .plugins [data-ext='test.local'] input[type=checkbox]\").checked")) {
      throw new Error("плагин с локальным адресом включён");
    }
    if ((await d.findAll("iframe[src*='test.local']")).length) throw new Error("плагин с локальным адресом запущен");
    await invoke("extension_remove", { id: "test.local" });
    await closeModules();
  });
}
