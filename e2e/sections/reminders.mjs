// Section "reminders" of the run (see e2e/shard.mjs for the split into parts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profile, d, helper, screenshot, step, rowBySubject, openBySubject, reloadWindow, textOf, setInput, remindMenu, remindBy, altKey, invoke, press, newMessage, composeClosed, closeSettings, sidebarText, section, stamp } from "../kit.mjs";

export async function run() {
  section("reminders");
  await step("5.10", "«Ждут ответа»: напоминание снимается, когда приходит ответ", async () => {
    const subj = `Вопрос ${stamp}`;
    await newMessage("carol@local.test", subj, "Когда будет готово?");
    // The reminder is chosen in the menu of «Snooze»: typed «через 3 дня», Enter; the chip shows the date.
    await remindBy("через 3 дня");
    if ((await textOf(".compose .remind")).includes("Без напоминания")) throw new Error("срок не выбран");
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.until("waiting in sidebar", async () => (await sidebarText()).includes("Ждут ответа"), 60000, 1000);
    await d.button("Ждут ответа");
    await rowBySubject(subj, 20000);
    await screenshot("followups");
    helper("reply", "Sent", subj);
    // Answered: out of the active ones, kept among the closed with who replied.
    await d.until("resolved", async () => (await invoke("counters")).followups === 0, 60000, 1000);
    if (!(await sidebarText()).includes("Ждут ответа")) throw new Error("«Ждут ответа» пропал, хотя закрытое ожидание есть");
    await d.button("Закрытые");
    await rowBySubject(subj, 20000);
    await screenshot("followups-closed");
    await d.button("Активные");
  });

  await step("5.10.2", "ответ с «Без напоминания» и галочкой «Убрать письмо из входящих»: письмо в архиве, «Ждут ответа» пусто (#106)", async () => {
    const subj = `Без ожидания ${stamp}`;
    const acc = (await invoke("accounts"))[0];
    const waiting = (park) => invoke("account_save", { account: { ...acc, waiting: { park, folder: "", stop_to_archive: false } }, password: null, grant: null });
    // The mailbox that takes answered letters out of the inbox; the window reads it at start.
    await waiting(true);
    try {
      await reloadWindow();
      await d.button("Входящие");
      helper("deliver", subj);
      await d.until("letter in inbox", async () => helper("count", "INBOX", subj) === "1", 30000);
      await openBySubject(subj);
      await d.button("Ответить");
      await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
      await d.until("the box", async () => (await d.findAll(".compose .wait-line .queue input")).length === 1);
      const text = await textOf(".compose .wait-line");
      if (!text.includes("Убрать письмо из входящих") || text.includes("до ответа")) throw new Error(`строка: ${text}`);
      if (!(await d.exec("return document.querySelector('.compose .wait-line .queue input').checked"))) throw new Error("галочка не стоит по умолчанию");
      if (!text.includes("Без напоминания")) throw new Error(`напоминание: ${text}`);
      await d.type(await d.find(".compose textarea"), "Принято.");
      await d.button("Отправить");
      await d.until("original in archive", async () => helper("count", "Архив", subj) === "1" && helper("count", "INBOX", subj) === "0", 60000, 1000);
      await d.until("toast", async () => (await textOf(".toasts")).includes("Письмо — в архиве"), 20000);
      // That no wait starts and nothing goes to «Ждут ответа» is a rule of the core
      // (`an_answer_without_a_wait_goes_to_the_archive_and_a_wait_for_its_conversation_waits_for_that`).
    } finally {
      await waiting(false);
    }
  });

  await step("5.10.3", "ответ с напоминанием и парковкой: «Не ждать» и «Отменить» — письмо остаётся в папке «Ждут ответа» (#98)", async () => {
    const subj = `Парковка ${stamp}`;
    const acc = (await invoke("accounts"))[0];
    const waiting = (park) => invoke("account_save", { account: { ...acc, waiting: { park, folder: "", stop_to_archive: false } }, password: null, grant: null });
    await waiting(true);
    try {
      await reloadWindow();
      await d.button("Входящие");
      helper("deliver", subj);
      await d.until("letter in inbox", async () => helper("count", "INBOX", subj) === "1", 30000);
      await openBySubject(subj);
      await d.button("Ответить");
      await d.until("reply compose", async () => (await d.findAll(".compose")).length === 1);
      await remindBy("через 3 дня");
      await d.type(await d.find(".compose textarea"), "Жду.");
      await d.button("Отправить");
      // The letter waits in the folder of the mailbox, out of the inbox.
      const folder = "Ждут ответа";
      await d.until("letter parked", async () => helper("count", folder, subj) === "1" && helper("count", "INBOX", subj) === "0", 60000, 1000);
      await d.button("Ждут ответа");
      await openBySubject(subj);
      await d.button("Не ждать");
      await d.until("not waiting", async () => (await invoke("counters")).followups === 0, 20000);
      const toast = "//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Не ждём ответа')]";
      await d.click(await d.until("stop toast", () => d.xpath(`${toast}//button[contains(@class,'act')]`)));
      await d.until("waiting again", async () => (await invoke("counters")).followups > 0, 20000);
      // That the return is held back past the undo toast, and the letters stay in the folder, is a rule of the
      // core (`the_letters_of_a_stopped_wait_come_back_after_the_undo_toast_and_not_before`), not waited for here.
      await d.until("row in the list", async () => (await textOf(".list")).includes(subj), 20000);
      // Stopped for good: the letters go back to the inbox once the toast is gone.
      await d.button("Не ждать");
      await d.until("back in the inbox", async () => helper("count", "INBOX", subj) === "1" && helper("count", folder, subj) === "0", 90000, 1000);
    } finally {
      await waiting(false);
    }
  });

  await step("5.10.4", "«Ждут ответа»: свой срок через «Настроить…» запоминается в списке", async () => {
    const subj = `Свой срок ${stamp}`;
    await newMessage("carol@local.test", subj, "Жду ответа.");
    await remindMenu();
    await d.click(await d.find(".snooze [data-row='setup']"));
    await d.until("custom form", async () => (await textOf(".compose .pop")).includes("Через"));
    await setInput(".pop .num", "2");
    await d.exec("const s = document.querySelector('.pop select'); s.value = 'workdays'; s.dispatchEvent(new Event('change', { bubbles: true }));");
    await d.click(await d.find(".pop .keep input"));
    await d.click(await d.find(".pop .btn.primary"));
    await d.until("kept choice shown", async () => (await textOf(".compose .remind")).includes("через 2 рабочих дня"));
    const started = Math.floor(Date.now() / 1000);
    await d.click(await d.find(".compose .split-btn .main"));
    await composeClosed();
    await d.until("waiting", async () => (await invoke("counters")).followups > 0, 60000, 1000);
    // The reminder is listed by the copy in Sent, which comes a moment after sending.
    const due = await d.until("waiting row", async () => {
      const rows = await invoke("messages", { query: { followups_only: true, threads: false, limit: 50 } });
      return rows.find((m) => m.subject === subj)?.followup_due ?? 0;
    }, 30000, 500);
    // Two working days: at least two calendar days, at most four (over a weekend).
    if (due < started + 2 * 86_400 - 60 || due > started + 4 * 86_400 + 600) throw new Error(`срок ${due - started} с`);
    // The choice stays in the list of the next letter.
    await d.button("Написать");
    await d.until("compose", async () => (await d.findAll(".compose")).length === 1);
    // «Настроить…» keeps the saved choices in its list.
    await remindMenu();
    await d.click(await d.find(".snooze [data-row='setup']"));
    await d.until("kept in the list", async () => !!(await d.exec("return [...document.querySelectorAll('.compose .pop [role=menuitemradio]')].some((o) => o.innerText.includes('через 2 рабочих дня'))")));
    await d.exec("document.querySelector('.compose .pop [role=menuitemradio]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await d.click(await d.find(".compose header > button:last-child"));
    await composeClosed();
    // Not waiting any more: the banner's button.
    await d.button("Ждут ответа");
    await openBySubject(subj);
    await d.button("Не ждать");
    await d.until("not waiting", async () => (await invoke("counters")).followups === 0, 20000);
    // The list of waits is read again after the button of the banner: the row is gone from «Активные».
    await d.until("row left the list", async () => !(await textOf(".list")).includes(subj), 20000);
    // The tab's count is read again with it: no «Активные 1» over an empty list.
    await d.until("count follows the list", async () => !/Активные\s*\d/.test(await textOf(".list")), 20000);
    // The toast says so and takes it back (#98): the wait returns, with its reminder.
    const stopToast = "//div[contains(concat(' ', normalize-space(@class), ' '), ' toast ')][contains(., 'Не ждём ответа')]";
    await d.until("stop toast", () => d.xpath(stopToast));
    await screenshot("followups-stop-toast", { toasts: true });
    await d.click(await d.xpath(`${stopToast}//button[contains(@class,'act')]`));
    await d.until("waiting again", async () => (await invoke("counters")).followups > 0, 20000);
    await d.until("wait banner back", async () => (await textOf(".reader")).includes("Не ждать"), 20000);
    await d.until("row is back", async () => (await textOf(".list")).includes(subj), 20000);
    await d.button("Не ждать");
    await d.until("not waiting again", async () => (await invoke("counters")).followups === 0, 20000);
    // Closed by hand: among the closed, and the banner offers to wait again.
    await d.until("closed banner", async () => (await textOf(".reader")).includes("Снова ждать ответа"), 20000);
    await d.button("Закрытые");
    await rowBySubject(subj, 20000);
    await d.button("Активные");
  });

  await step("5.11", "окно письма (#103): ящик в заголовке, «Копия» и «Скрытая» свёрнуты, Alt-клавиши, вложения одной строкой, 160 px тексту", async () => {
    const subj = `Окно письма ${stamp} — тема заведомо длиннее заголовка окна, и ей положено обрезаться многоточием`;
    await newMessage("carol@local.test", subj, "Текст письма.");
    const geometry = (css) => d.exec("const r = document.querySelector(arguments[0]).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };", css);
    const rows = () => d.exec("return [...document.querySelectorAll('.compose .fields .row .label')].map((l) => l.innerText)");
    const focusedRow = () => d.exec("return document.activeElement?.closest('.row')?.querySelector('.label')?.innerText ?? ''");

    // «From» is the label of the title, never a row; the subject is cut with «…», the label keeps its size.
    if ((await d.findAll(".compose .from-row, .compose .fields .from")).length) throw new Error("«От» осталась строкой");
    const label = await d.exec("const m = document.querySelector('.compose header .mailbox'); return m ? { title: m.title, cut: m.scrollWidth > m.clientWidth } : null");
    if (!label || !label.title.includes("@local.test")) throw new Error(`метка ящика: ${JSON.stringify(label)}`);
    if (label.cut) throw new Error("метка ящика сжата");
    const cut = await d.exec("const t = document.querySelector('.compose header .title'); return { cut: t.scrollWidth > t.clientWidth, title: t.title }");
    if (!cut.cut || cut.title !== subj) throw new Error(`тема в заголовке: ${JSON.stringify(cut)}`);

    // Cc and Bcc are links beside «To» without printed keys; the fields open on Alt+C and Alt+B and fold when empty.
    const links = await d.exec("return [...document.querySelectorAll('.compose .fields .lnk')].map((b) => b.innerText.trim())");
    if (links.join() !== "Копия,Скрытая") throw new Error(`ссылки: ${links}`);
    if ((await d.findAll(".compose .fields kbd")).length) throw new Error("у ссылок напечатаны клавиши");
    if ((await rows()).join() !== "Кому,Тема") throw new Error(`строки: ${await rows()}`);
    await altKey("c", "KeyC");
    await d.until("Cc opened", async () => (await rows()).join() === "Кому,Копия,Тема");
    if ((await focusedRow()) !== "Копия") throw new Error(`курсор в «${await focusedRow()}»`);
    await altKey("c", "KeyC", ".compose .fields .row:nth-child(2) input");
    await d.until("empty Cc folded", async () => (await rows()).join() === "Кому,Тема");
    // The caret does not leave the window: it goes to «To», and the keys of the window still work from there.
    if ((await focusedRow()) !== "Кому") throw new Error(`после сворачивания курсор в «${await focusedRow()}»`);
    await d.exec("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }))");
    await d.until("saved from the focus", async () => (await textOf(".compose .saved")).includes("Сохранено"), 15000);
    // Alt+C from elsewhere takes the caret to an open empty «Cc» instead of folding it.
    await altKey("c", "KeyC");
    await d.until("Cc opened again", async () => (await focusedRow()) === "Копия");
    await d.exec("document.querySelector('.compose .subject').focus()");
    await altKey("c", "KeyC");
    await d.until("caret in Cc", async () => (await focusedRow()) === "Копия");
    if ((await rows()).join() !== "Кому,Копия,Тема") throw new Error("«Копия» свернулась от Alt+C из другого места");
    await altKey("c", "KeyC", ".compose .fields .row:nth-child(2) input");
    await d.until("folded from inside", async () => (await rows()).join() === "Кому,Тема");
    await altKey("b", "KeyB");
    await d.until("Bcc opened", async () => (await rows()).join() === "Кому,Скрытая,Тема");
    if ((await focusedRow()) !== "Скрытая") throw new Error(`курсор в «${await focusedRow()}»`);
    await altKey("b", "KeyB", ".compose .fields .row:nth-child(2) input");
    await d.until("empty Bcc folded", async () => (await rows()).join() === "Кому,Тема");
    await d.click(await d.find(".compose .fields .lnk"));
    await d.until("Cc by the link", async () => (await rows()).join() === "Кому,Копия,Тема");
    await d.type(await d.find(".compose .fields .row:nth-child(2) input"), "dave@local.test,");
    await altKey("c", "KeyC", ".compose .fields .row:nth-child(2) input");
    if ((await rows()).join() !== "Кому,Копия,Тема") throw new Error("поле с адресом свернулось");
    if ((await geometry(".compose .fields .row:nth-child(2)")).height > 46) throw new Error("«Копия» с одним адресом двойной высоты");

    // One mailbox only: the label tells it and offers no list (the list is checked where there are two, step 4.1).
    if ((await d.findAll(".compose header .mailbox.fixed")).length !== 1) throw new Error("у единственного ящика метка не фиксирована");

    // Eight files by a drop: one line and «+N ещё», the list on Alt+A, Delete takes a file off.
    const dir = join(profile, "att103");
    mkdirSync(dir, { recursive: true });
    const paths = Array.from({ length: 8 }, (_, i) => {
      const file = join(dir, `Договор-${i + 1}.txt`);
      writeFileSync(file, `файл ${i + 1}`);
      return file;
    });
    await d.exec("window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'files-dropped', payload: { paths: arguments[0], position: { x: 0, y: 0 } } })", paths);
    await d.until("8 files", async () => (await d.exec("return document.querySelectorAll('.compose .files .file').length + Number((document.querySelector('.compose .files .more')?.innerText.match(/\\d+/) ?? [0])[0])")) === 8);
    if ((await geometry(".compose .files")).height > 44) throw new Error("полоса вложений выше одной строки");
    const text = await d.exec("return document.querySelector('.compose textarea').getBoundingClientRect().height");
    if (text < 159) throw new Error(`тексту ${text} px`);
    await altKey("a", "KeyA");
    await d.until("list", async () => (await d.findAll(".compose [data-att]")).length === 8);
    await screenshot("compose-103-files-paper");
    await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
    await d.until("a file less", async () => (await d.findAll(".compose [data-att]")).length === 7);
    await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await d.until("list closed", async () => (await d.findAll(".compose [data-att]")).length === 0);

    // At full screen the strip shows every file in up to two rows with its own scroll (2.1 Б).
    await d.click((await d.findAll(".compose header .hb"))[1]);
    await d.until("full screen", async () => (await d.findAll(".compose.max .files.full")).length === 1);
    const full = await d.exec("return { chips: document.querySelectorAll('.compose .files .file').length, more: document.querySelectorAll('.compose .files .more').length, height: document.querySelector('.compose .files').getBoundingClientRect().height }");
    if (full.chips !== 7 || full.more !== 0 || full.height > 72) throw new Error(`полоса на весь экран: ${JSON.stringify(full)}`);
    await screenshot("compose-103-fullscreen-paper");
    await d.click((await d.findAll(".compose header .hb"))[1]);
    await d.until("window again", async () => (await d.findAll(".compose.max")).length === 0);

    // The format is in one place; Markdown adds «Показать разметку» and the note with a cross.
    await altKey("f", "KeyF");
    await d.until("format menu", async () => (await d.findAll(".compose footer [role=menuitemradio]")).length === 3);
    await d.click(await d.until("Markdown", () => d.xpath("//div[contains(@class,'compose')]//footer//button[@role='menuitemradio'][contains(., 'Markdown')]")));
    await d.until("Markdown letter", async () => (await d.findAll(".compose .cm-editor")).length === 1);
    if ((await d.findAll(".compose .md-note, .compose .tb.markup")).length) throw new Error("формат или разметка показаны ещё раз");
    await altKey("f", "KeyF", ".compose .cm-content");
    await d.until("markup row", async () => (await textOf(".compose footer .pop")).includes("Показать разметку"));
    if (!(await textOf(".compose footer .pop .nt")).includes("Уйдёт тремя частями")) throw new Error("нет пояснения про три части");
    await screenshot("compose-103-format-paper");
    await d.click(await d.find(".compose footer .pop .ntx"));
    await d.until("note closed for good", async () => (await invoke("settings_get")).markdown_parts_note === false);
    if ((await d.findAll(".compose footer .pop .nt")).length) throw new Error("пояснение осталось");
    await d.exec("document.querySelector('.compose footer .pop [role=menuitemradio]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    // The way back: Settings → Look and language → Hints.
    await press(",", { ctrlKey: true });
    await d.until("settings", async () => (await d.findAll(".prefs")).length === 1);
    await d.click(await d.find(".prefs .tab[data-page='look']"));
    await d.until("look page", async () => (await textOf(".prefs .pane h2")) === "Вид и язык");
    await d.click(await d.find(".prefs [data-row='markdown_parts_note'] .sw"));
    await d.until("note back", async () => (await invoke("settings_get")).markdown_parts_note === true);
    await closeSettings();

    // The same window at night.
    const theme = (await invoke("settings_get")).theme;
    await invoke("settings_patch", { patch: { theme: "night" } });
    await d.until("night", async () => (await d.exec("return document.documentElement.dataset.theme ?? ''")) === "night");
    await screenshot("compose-103-files-night");
    await invoke("settings_patch", { patch: { theme } });

    // The last file taken off the list gives the caret back to the text.
    await altKey("a", "KeyA");
    await d.until("list again", async () => (await d.findAll(".compose [data-att]")).length > 0);
    for (let left = (await d.findAll(".compose [data-att]")).length; left > 0; left--) {
      await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))");
      await d.until("one less", async () => (await d.findAll(".compose [data-att]")).length === left - 1);
    }
    await d.until("caret in the text", async () => !!(await d.exec("return document.activeElement?.closest('.compose .body-area') !== null && document.activeElement?.closest('.compose .body-area') !== undefined")));

    // A letter typed in goes away without a draft.
    await d.click(await d.find(".compose footer button[aria-label='Удалить черновик']"));
    await d.click(await d.until("confirm", () => d.find(".modal.confirm .btn.primary").catch(() => null), 5000));
    await composeClosed();
  });
}
